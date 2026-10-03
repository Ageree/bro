import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import {
  personMessages,
  personWordsThisTurn,
} from "@agent/lib/browser-use/said";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  scheduleDelivery,
  scheduleOwner,
  scheduleReplyAnchor,
} from "@agent/lib/schedules/tools";
import { pageKey, readPricePage } from "@agent/lib/subscriptions/page";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import {
  amountsSaid,
  conditionLabel,
  daysSaid,
  conditionMet,
  priceLabel,
} from "@agent/lib/subscriptions/price";
import { createSubscription } from "@db/services/subscriptions";
import type { PriceCondition } from "@shared/subscriptions/price";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { localRunLabel } from "@shared/schedules/timing";

/** A shop is read every six hours: four requests a day, 28 in a week. */
const checkEverySeconds = 6 * 60 * 60;
const defaultDays = 30;
const maximumDays = 90;

const watchInputSchema = z.object({
  // Weak models fill every optional field: 0 means it was not given.
  below: z
    .number()
    .optional()
    .describe(
      "Tell when the price is at or below this amount, only one the person named («меньше 8к», «до 8000» are 8000)."
    ),
  days: z
    .number()
    .int()
    .optional()
    .describe(
      "How many days to watch, if the person said («2 недели» is 14, «месяц» 30); 30 otherwise."
    ),
  dropPercent: z
    .number()
    .optional()
    .describe(
      "Tell on a drop of at least this many percent, only if the person named one."
    ),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe("The product page link exactly as the person sent it."),
});

/**
 * A link's host and path: the model may drop the query, so the person's
 * link is found by these, and their own spelling, query included, is what
 * gets watched.
 */
function linkPath(url: URL) {
  return `${url.hostname.replace(/^www\./u, "")}${url.pathname.replace(/\/+$/u, "")}`;
}

/** The links in the person's words, latest first, as they wrote them. */
function linksSaid(said: readonly string[]) {
  return said.toReversed().flatMap((words) =>
    [...words.matchAll(/https?:\/\/[^\s<>"'«»]+/giu)].flatMap((match) => {
      const link = URL.parse(
        match[0].replace(/[).,;:!?]+$/u, "").replace(/^http:/iu, "https:")
      );
      if (!link) return [];
      link.hash = "";
      return [link];
    })
  );
}

/**
 * The link the person gave, as they wrote it: the model may only point at
 * one of theirs, never bring one from a page, a search or a report. The same
 * page (`pageKey`) first; by host and path only when the model dropped the
 * query, and then only if one page of theirs fits: «?sku=1» and «?sku=2» are
 * two products, and one must not take the other's watch.
 */
function personLink(said: readonly string[], given: string) {
  const wanted = URL.parse(given.replace(/^http:/iu, "https:"));
  if (!wanted) return undefined;
  const links = linksSaid(said);
  const exact = links.find((link) => pageKey(link) === pageKey(wanted));
  if (exact || wanted.search !== "") return exact;
  const loose = links.filter((link) => linkPath(link) === linkPath(wanted));
  return new Set(loose.map(pageKey)).size === 1 ? loose[0] : undefined;
}

/**
 * A page read that cannot throw: one that failed in a way the download did
 * not foresee is a page that did not open, not an error for the turn.
 */
async function readSafely(url: URL) {
  try {
    return await readPricePage(url);
  } catch (error) {
    console.warn("[subscriptions] watch read failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return { kind: "unreachable", reason: "error" } as const;
  }
}

const notThePerson =
  "Nothing was set up: a watch starts only in a turn the person's own message opened.";
const notTheirLink =
  "Nothing was set up: the link must be one the person sent in this conversation. Ask them for the product's link.";
const tooLong =
  "Nothing was set up: the link is too long to watch. Ask the person for the product page's short link.";
const notTheirAmount =
  "Nothing was set up: the threshold must be one the person named. Ask them, or leave it out to hear of any drop.";

/**
 * The person's words a watch is checked against, taken before each step:
 * their messages, one steered into the turn included, and their answers to
 * Bro's questions in it (`ask_question`). `personsTurn`: whether their own
 * message opened this turn — not a browser report, a schedule, or the task
 * agent's report (whose caller is still theirs), whose text a page wrote.
 */
interface WatchWords {
  readonly personsTurn: boolean;
  readonly said: readonly string[];
}

async function createWatch(
  input: z.output<typeof watchInputSchema>,
  context: ToolContext,
  { personsTurn, said }: WatchWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    throw new Error(notThePerson);
  }
  const url = personLink(said, input.url);
  if (!url) throw new Error(notTheirLink);
  // A report carries the link: one past 2 000 would not fit it.
  if (url.href.length > 2_000) throw new Error(tooLong);
  const named = amountsSaid(said);
  const below =
    input.below !== undefined && input.below > 0 ? input.below : undefined;
  const percent =
    input.dropPercent !== undefined && input.dropPercent > 0
      ? input.dropPercent
      : undefined;
  if (
    (below !== undefined && !named.amounts.has(below)) ||
    (percent !== undefined && !named.percents.has(percent))
  ) {
    throw new Error(notTheirAmount);
  }
  // A term the person did not name is the default one, not the model's.
  const days =
    input.days !== undefined && daysSaid(said).has(input.days)
      ? Math.min(Math.max(input.days, 1), maximumDays)
      : defaultDays;
  const condition: PriceCondition =
    below === undefined
      ? { kind: "drop", percent: Math.min(percent ?? 0, 90) }
      : { amount: below, kind: "below" };
  const reading = await readSafely(url);
  if (reading.kind === "unavailable") {
    return {
      reply:
        "Say the product is out of stock now, so there is no price to watch; offer to try again when it is back. Nothing was set up.",
      watching: false,
    };
  }
  if (reading.kind !== "price") {
    const why = {
      blocked:
        "the site does not show the page to a plain request (a bot check or a refusal)",
      "no-price": "the page shows no price in a form code can read",
      "several-products": "the page lists several products, not one",
      unreachable: "the page did not open",
    }[reading.kind];
    return {
      reply: `Say plainly that this price cannot be watched without the browser: ${why}. Offer a daily schedule (schedules-create) that checks the page with the browser instead, and set it up only on the person's yes.`,
      watching: false,
    };
  }
  // Without a name or SKU a later reading could be another product's.
  if (reading.name === null && reading.sku === null) {
    return {
      reply:
        "Say plainly that this price cannot be watched without the browser: the page does not name the product in its markup. Offer a daily schedule (schedules-create) that checks the page with the browser instead, and set it up only on the person's yes.",
      watching: false,
    };
  }
  const current = priceLabel(reading.amount, reading.currency);
  // «8» for «8к»: a threshold a tenth of the price is a misreading.
  if (below !== undefined && below < reading.amount / 10) {
    return {
      currentPrice: current,
      reply: `The price is ${current}, and ${priceLabel(below, reading.currency)} is far below it: ask the person which amount they meant. Nothing was set up.`,
      watching: false,
    };
  }
  // A drop is counted from this very reading, so only a threshold can
  // already be met.
  if (conditionMet(condition, reading.amount, reading.amount)) {
    return {
      currentPrice: current,
      reply: `The price is already ${current}, which is ${conditionLabel(condition, reading.currency)}: say so with the link. Nothing was set up.`,
      watching: false,
    };
  }
  const owner = scheduleOwner(context);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60_000);
  const product = reading.name ? `«${reading.name}»` : "the product";
  const { created, subscription } = await createSubscription(
    owner.scope,
    {
      checkEverySeconds,
      condition,
      conversation: owner.conversation,
      dedupeKey: pageKey(url),
      description: `Price watch: ${product}, tell the person about ${conditionLabel(condition, reading.currency)} (it was ${current} when the watch began). ${url.href}`,
      expiresAt,
      replyAnchorMessageId: scheduleReplyAnchor(context),
      source: {
        currency: reading.currency,
        extractor: reading.extractor,
        landedOn: reading.landedOn,
        name: reading.name,
        sku: reading.sku,
        url: url.href,
      },
      state: {
        baseline: reading.amount,
        last: reading.amount,
        lastSeenAt: now.toISOString(),
      },
      template: "price",
    },
    now
  );
  const [timeZone, delivery] = await Promise.all([
    readWorkspaceTimeZone(owner.scope),
    scheduleDelivery({
      ...owner.conversation,
      replyAnchorMessageId: null,
      workspaceId: owner.scope.workspaceId,
    }),
  ]);
  return {
    currentPrice: current,
    id: subscription.id,
    reply: `${created ? "The watch is set up" : "The watch of this page already ran; it now has the new condition and term"}. Say the current price, what you will tell about (${conditionLabel(condition, reading.currency)}), that the page is checked every 6 hours until ${localRunLabel(expiresAt, timeZone)}, and that the news arrives in ${delivery.deliversTo}. It can be paused or deleted in plain words.`,
    watching: true,
  };
}

export default defineDynamic({
  events: {
    // Only the pilot (SUBSCRIPTIONS_WORKSPACES) gets the tool, the same at
    // every step. What the person wrote is taken before each step, so a
    // message steered into the turn and an answer to Bro's question count:
    // a watch's link and threshold are checked against their words, never
    // the model's.
    "step.started": async (event, context) => {
      const auth = context.session.auth.current;
      if (resolveModeValue(context, { interactive: true }) !== true) {
        return null;
      }
      if (auth?.principalType !== "user") return null;
      if (!(await subscriptionsPilot(scopeFromPrincipal(auth)))) return null;
      const turn = personWordsThisTurn(
        context.messages,
        stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          context.session.id
        )
      );
      const words: WatchWords = {
        personsTurn: turn.said !== null,
        said: [...personMessages(context.messages), ...turn.answers],
      };
      return {
        "watch-create": defineTool({
          description:
            "Watch a product page's price for the person: code checks it every 6 hours without you and tells them once when it is at or below an amount they named, or on any drop. Use it for «следи за ценой», «напиши, когда подешевеет» with a link they sent. Never set one up they did not ask for. A site that hides its price from plain requests is refused: then offer a daily browser check (schedules-create). Pause or delete it with schedules-list and schedules-update.",
          inputSchema: watchInputSchema,
          async execute(input, toolContext) {
            return createWatch(input, toolContext, words);
          },
        }),
      };
    },
  },
});
