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
import { startingParcelState } from "@agent/lib/subscriptions/parcel/check";
import {
  normalizedParcelNumber,
  parcelNumbersIn,
} from "@agent/lib/subscriptions/parcel/number";
import {
  type ParcelRead,
  readPochtaParcel,
} from "@agent/lib/subscriptions/parcel/pochta";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import { daysSaid } from "@agent/lib/subscriptions/price";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { createSubscription } from "@db/services/subscriptions";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { localRunLabel } from "@shared/schedules/timing";
import {
  parcelCheckEverySeconds,
  parcelNumberSchema,
  parcelWatchDays,
} from "@shared/subscriptions/parcel";

const maximumDays = 90;

const parcelInputSchema = z.object({
  // Weak models fill every optional field: 0 means it was not given.
  days: z
    .number()
    .int()
    .optional()
    .describe(
      "How many days to watch, if the person said («2 недели» is 14, «месяц» 30); 60 otherwise."
    ),
  number: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe("The tracking number exactly as the person sent it."),
});

/**
 * The person's words a watch is checked against, taken before each step:
 * their messages, one steered into the turn included, and their answers to
 * Bro's questions in it. `personsTurn`: whether their own message opened
 * this turn — not a browser report, a schedule, or the task agent's report.
 */
interface ParcelWords {
  readonly personsTurn: boolean;
  readonly said: readonly string[];
}

const notThePerson =
  "Nothing was set up: a watch starts only in a turn the person's own message opened.";
const notTheirNumber =
  "Nothing was set up: the number must be one the person sent in this conversation. Ask them for the tracking number.";
const notPochta =
  "Nothing was set up: code reads only Russian Post's tracking — a number of 14 digits, or two letters, nine digits and two letters (RA123456789RU). CDEK shows its tracking only to a browser, and other carriers are not read either. Say so plainly and offer a daily check with the browser (schedules-create) instead, set up only on the person's yes.";

/**
 * A reading that cannot throw: one that failed in a way the download did not
 * foresee is a carrier that did not answer, not an error for the turn.
 */
async function readSafely(number: string): Promise<ParcelRead> {
  try {
    return await readPochtaParcel(number);
  } catch (error) {
    console.warn("[subscriptions] parcel read failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return { kind: "unreachable", reason: "error" };
  }
}

/** What Russian Post says of it now, for the reply. */
function nowWords(reading: Extract<ParcelRead, { kind: "parcel" }>) {
  if (reading.status === "unknown") {
    return "Russian Post knows nothing of this number yet (a shop often gives it before handing the parcel over); the watch waits for it";
  }
  const said = reading.lastEvent
    ? `Russian Post says «${reading.lastEvent}»${reading.place ? ` (${reading.place})` : ""}`
    : "Russian Post has the number";
  if (reading.status === "arrived") {
    return `${said}: it waits to be collected${reading.storageUntil ? `, kept until ${reading.storageUntil}` : ""}`;
  }
  return reading.expectedOn
    ? `${said}; it expects to deliver it on ${reading.expectedOn}`
    : said;
}

async function watchParcel(
  input: z.output<typeof parcelInputSchema>,
  context: ToolContext,
  { personsTurn, said }: ParcelWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    throw new Error(notThePerson);
  }
  const number = normalizedParcelNumber(input.number);
  if (!parcelNumberSchema.safeParse(number).success) {
    return { reply: notPochta, watching: false };
  }
  if (!parcelNumbersIn(said.join("\n")).includes(number)) {
    throw new Error(notTheirNumber);
  }
  const reading = await readSafely(number);
  if (reading.kind !== "parcel") {
    return {
      reply:
        "Say Russian Post did not answer just now, so nothing was set up; offer to try again a bit later, or to look the number up with the browser.",
      watching: false,
    };
  }
  if (
    reading.status === "delivered" ||
    reading.status === "returned" ||
    reading.status === "lost"
  ) {
    const fate = {
      delivered: "has already been handed over",
      lost: "is registered as lost or destroyed",
      returned: "is being returned to the sender",
    }[reading.status];
    return {
      reply: `Russian Post says the parcel ${fate}${reading.lastEvent ? `: «${reading.lastEvent}»` : ""}. Say so; there is nothing to watch, and nothing was set up.`,
      watching: false,
    };
  }
  // A term the person did not name is the default one, not the model's.
  const days =
    input.days !== undefined && daysSaid(said).has(input.days)
      ? Math.min(Math.max(input.days, 1), maximumDays)
      : parcelWatchDays;
  const owner = scheduleOwner(context);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60_000);
  const { created, subscription } = await createSubscription(
    owner.scope,
    {
      checkEverySeconds: parcelCheckEverySeconds,
      condition: { kind: "changes" },
      conversation: owner.conversation,
      dedupeKey: number,
      description: `Parcel watch: Russian Post ${number}${reading.title ? ` («${reading.title}»)` : ""}, tell the person of a new date, its arrival, its storage ending.`,
      expiresAt,
      replyAnchorMessageId: scheduleReplyAnchor(context),
      source: {
        carrier: "pochta",
        number,
        origin: "person",
        title: reading.title,
      },
      state: startingParcelState(reading, now),
      template: "parcel",
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
    id: subscription.id,
    reply: `${created ? "The watch is set up" : "This number was already watched; the watch now has the new term"}. Say what Russian Post says now — ${nowWords(reading)} — that code checks it every 3 hours until ${localRunLabel(expiresAt, timeZone)} and writes only on a change (a new expected date, its arrival where it is collected, its storage ending, a return), and that the news arrives in ${delivery.deliversTo}. It can be paused or deleted in plain words.`,
    watching: true,
  };
}

export default defineDynamic({
  events: {
    // Only the pilot (SUBSCRIPTIONS_WORKSPACES) gets the tool, the same at
    // every step. What the person wrote is taken before each step, so a
    // message steered into the turn and an answer to Bro's question count:
    // the number is checked against their words, never the model's.
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
      const words: ParcelWords = {
        personsTurn: turn.said !== null,
        said: [...personMessages(context.messages), ...turn.answers],
      };
      return {
        "parcel-watch": defineTool({
          description:
            "Watch a Russian Post parcel for the person by its tracking number: code reads its status every 3 hours without you and tells them only of a change — a new expected date, its arrival at the post office or pickup point, its storage running out, a return. Use it for «следи за посылкой», «отслеживай трек 8008…» with a number they sent (14 digits, or like RA123456789RU). CDEK and other carriers are refused: then offer a daily browser check (schedules-create). Pause or delete it with schedules-list and schedules-update.",
          inputSchema: parcelInputSchema,
          async execute(input, toolContext) {
            return watchParcel(input, toolContext, words);
          },
        }),
      };
    },
  },
});
