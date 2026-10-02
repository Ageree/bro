import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { personMessages } from "@agent/lib/browser-use/said";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  scheduleDelivery,
  scheduleOwner,
  scheduleReplyAnchor,
} from "@agent/lib/schedules/tools";
import { readPricePage } from "@agent/lib/subscriptions/page";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import {
  amountsSaid,
  conditionLabel,
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
      "Tell when the price is below this amount, only one the person named («меньше 8к» is 8000)."
    ),
  days: z
    .number()
    .int()
    .optional()
    .describe("How many days to watch, if the person said; 30 otherwise."),
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

/** «https://shop.ru/p/1?utm=x#a» and «https://www.shop.ru/p/1/» are one page. */
function pageKey(url: URL) {
  return `${url.hostname.replace(/^www\./u, "")}${url.pathname.replace(/\/+$/u, "")}`;
}

/**
 * The link the person gave, as they wrote it: the model may only point at
 * one of theirs, never bring one from a page, a search or a report. The
 * person's own spelling, query included, is what gets watched.
 */
function personLink(said: readonly string[], given: string) {
  const wanted = URL.parse(given.replace(/^http:/iu, "https:"));
  if (!wanted) return undefined;
  const key = pageKey(wanted);
  for (const words of said.toReversed()) {
    for (const match of words.matchAll(/https?:\/\/[^\s<>"'«»]+/giu)) {
      const link = URL.parse(
        match[0].replace(/[).,;:!?]+$/u, "").replace(/^http:/iu, "https:")
      );
      if (link && pageKey(link) === key) {
        link.hash = "";
        return link;
      }
    }
  }
  return undefined;
}

const notThePerson =
  "Nothing was set up: a watch starts only in a turn the person's own message opened.";
const notTheirLink =
  "Nothing was set up: the link must be one the person sent in this conversation. Ask them for the product's link.";
const notTheirAmount =
  "Nothing was set up: the threshold must be one the person named. Ask them, or leave it out to hear of any drop.";

async function createWatch(
  input: z.output<typeof watchInputSchema>,
  context: ToolContext,
  said: readonly string[]
) {
  if (!startedByPerson(context)) throw new Error(notThePerson);
  const url = personLink(said, input.url);
  if (!url) throw new Error(notTheirLink);
  const named = amountsSaid(said);
  const below =
    input.below !== undefined && input.below > 0 ? input.below : undefined;
  const percent =
    input.dropPercent !== undefined && input.dropPercent > 0
      ? Math.min(input.dropPercent, 90)
      : undefined;
  if (
    (below !== undefined && !named.has(below)) ||
    (percent !== undefined && !named.has(percent))
  ) {
    throw new Error(notTheirAmount);
  }
  const condition: PriceCondition =
    below === undefined
      ? { kind: "drop", percent: percent ?? 0 }
      : { amount: below, kind: "below" };
  const reading = await readPricePage(url);
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
  const current = priceLabel(reading.amount, reading.currency);
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
  const days = Math.min(
    Math.max(
      input.days !== undefined && input.days > 0 ? input.days : defaultDays,
      1
    ),
    maximumDays
  );
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
    // Only the pilot (SUBSCRIPTIONS_WORKSPACES) gets the tool, for the whole
    // session, so the tool list stays the same from step to step. What the
    // person wrote is taken here, before any step: a watch's link and
    // threshold are checked against their words, never the model's.
    "turn.started": async (_event, context) => {
      const auth = context.session.auth.current;
      if (resolveModeValue(context, { interactive: true }) !== true) {
        return null;
      }
      if (auth?.principalType !== "user") return null;
      if (!(await subscriptionsPilot(scopeFromPrincipal(auth)))) return null;
      const said = personMessages(context.messages);
      return {
        "watch-create": defineTool({
          description:
            "Watch a product page's price for the person: code checks it every 6 hours without you and tells them once when it drops below an amount they named, or by any drop. Use it for «следи за ценой», «напиши, когда подешевеет» with a link they sent. Never set one up they did not ask for. A site that hides its price from plain requests is refused: then offer a daily browser check (schedules-create). Pause or delete it with schedules-list and schedules-update.",
          inputSchema: watchInputSchema,
          async execute(input, toolContext) {
            return createWatch(input, toolContext, said);
          },
        }),
      };
    },
  },
});
