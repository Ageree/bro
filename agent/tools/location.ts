import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { turnAwaitsAnswer } from "@agent/lib/delivery/questions";
import { pointAddressNow } from "@agent/lib/location/address";
import { localStamp } from "@agent/lib/location/note";
import { labelSaid } from "@agent/lib/location/words";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { openStreetMapAttribution } from "@agent/lib/routes/openstreetmap";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import {
  forgetLocation,
  labelPoint,
  latestPosition,
  locationPilot,
} from "@db/services/location";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { distanceM } from "@shared/location/geometry";

/**
 * Where the person is, as they shared it (`docs/location.md`): the latest
 * point they sent, by name too («парковка»), and their own names for points
 * and forgetting them. Only the pilot (LOCATION_WORKSPACES) gets these, in
 * an interactive turn of a person.
 */

/** A point older than this is where the person was, not where they are. */
const staleMs = 60 * 60_000;
/** A name goes only to a point this fresh: «я припарковался здесь». */
const labelFreshMs = 15 * 60_000;

/** The person's words a write is checked against (as `watch.ts` takes them). */
interface LocationWords {
  readonly heldForAnswer: boolean;
  readonly personsTurn: boolean;
  readonly said: readonly string[];
}

/** Empty and `*` are «not given»: weak models fill every optional field. */
function given(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "*"
    ? undefined
    : trimmed;
}

function locationScope(context: ToolContext) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") {
    throw new Error("Geolocation needs an authenticated workspace user.");
  }
  return scopeFromPrincipal(caller);
}

const askForPoint =
  "Ask the person to send their location: in Telegram the paperclip, then «Геопозиция»; in iMessage «Отправить мою геопозицию». Nothing else knows where they are.";

const nowInputSchema = z
  .object({
    label: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        "Only for a point the person named before, such as «парковка» or «офис»; leave out for where they are."
      ),
  })
  .strict();

async function locationNow(
  input: z.output<typeof nowInputSchema>,
  context: ToolContext
) {
  const scope = locationScope(context);
  const label = given(input.label);
  const now = new Date();
  const [latest, home, timeZone] = await Promise.all([
    latestPosition(scope, label === undefined ? { now } : { label, now }),
    label === "дом" ? undefined : latestPosition(scope, { label: "дом", now }),
    readWorkspaceTimeZone(scope),
  ]);
  if (!latest) {
    return {
      known: false,
      reply:
        label === undefined
          ? `Bro has no location the person shared. ${askForPoint}`
          : `No point the person named «${label}». Say so; ask them to send their location there next time and name it.`,
    };
  }
  const { live, point } = latest;
  const address = await pointAddressNow(scope, point);
  const ageMs = now.getTime() - point.recordedAt.getTime();
  const localTime = localStamp(point.recordedAt, timeZone);
  const homeKm =
    home && home.point.id !== point.id
      ? Math.round(distanceM(home.point, point) / 100) / 10
      : undefined;
  return {
    attribution: openStreetMapAttribution,
    ...(homeKm !== undefined && { home: { km: homeKm } }),
    known: true,
    position: {
      accuracyM: point.accuracyM,
      address,
      kind: point.kind,
      label: point.label,
      lat: point.lat,
      live,
      localTime,
      lon: point.lon,
      recordedAt: point.recordedAt.toISOString(),
      source: point.source,
      venue: point.source === "telegram_venue",
    },
    reply:
      point.kind === "place"
        ? `This is a place the person sent (${localTime}), not where they are.`
        : ageMs > staleMs
          ? `This point is from ${localTime}: say where they were then, not where they are now. ${askForPoint}`
          : point.source === "telegram_venue"
            ? `The person marked this place at ${localTime}: they are probably there.`
            : `The person shared this at ${localTime}.`,
  };
}

const editInputSchema = z
  .object({
    action: z
      .enum(["label", "forget"])
      .describe(
        "`label`: name the latest point in the person's words; `forget`: delete shared locations."
      ),
    from: z
      .string()
      .optional()
      .describe(
        "`forget` of a period only: its start, ISO 8601 with the offset."
      ),
    label: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        "`label` only: the person's name for the place, such as «парковка», «офис»."
      ),
    to: z
      .string()
      .optional()
      .describe(
        "`forget` of a period only: its end, ISO 8601 with the offset."
      ),
  })
  .strict();

const notThePerson =
  "Nothing was changed: only a turn the person's own message opened changes their locations.";

/** An ISO instant the model gave, or undefined; null when it does not read. */
function instant(value: string | undefined) {
  const text = given(value);
  if (text === undefined) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : new Date(at);
}

async function locationEdit(
  input: z.output<typeof editInputSchema>,
  context: ToolContext,
  { heldForAnswer, personsTurn, said }: LocationWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    return { changed: false, reply: notThePerson };
  }
  const scope = locationScope(context);
  if (input.action === "label") {
    const label = given(input.label);
    if (label === undefined || !labelSaid(label, said)) {
      return {
        changed: false,
        reply:
          "Nothing was changed: the name must be the person's own word for the place. Ask them what to call it.",
      };
    }
    const latest = await latestPosition(scope);
    if (
      latest?.point.kind !== "position" ||
      Date.now() - latest.point.recordedAt.getTime() > labelFreshMs
    ) {
      return {
        changed: false,
        reply: `Nothing was changed: Bro has no location of theirs from the last 15 minutes. ${askForPoint} Then name it.`,
      };
    }
    await labelPoint(scope, latest.point.id, label.toLowerCase());
    return {
      changed: true,
      reply: `The point is named «${label.toLowerCase()}». Say that «где ${label.toLowerCase()}?» will find it.`,
    };
  }
  if (heldForAnswer) {
    return {
      changed: false,
      reply:
        "Not done: you asked the person a question and wait for the answer.",
    };
  }
  const from = instant(input.from);
  const to = instant(input.to);
  if (from === null || to === null) {
    return {
      changed: false,
      reply: "Nothing was changed: the period's bounds do not read as dates.",
    };
  }
  const forgotten = await forgetLocation(scope.workspaceId, {
    ...(from && { from }),
    ...(to && { to }),
  });
  return {
    changed: true,
    points: forgotten.points,
    reply:
      "Done. Say that these points are deleted, that what was said in the chats stays in the chat history, and that live place reminders stay until cancelled (place_reminder).",
  };
}

export default defineDynamic({
  events: {
    // Only the pilot gets these, the same at every step. What the person
    // wrote is taken before each step: a point's name must be theirs.
    "step.started": async (event, context) => {
      const auth = context.session.auth.current;
      if (resolveModeValue(context, { interactive: true }) !== true) {
        return null;
      }
      if (auth?.principalType !== "user") return null;
      if (!locationPilot(scopeFromPrincipal(auth))) return null;
      const turn = personWordsThisTurn(
        context.messages,
        stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          context.session.id
        )
      );
      const words: LocationWords = {
        heldForAnswer: turnAwaitsAnswer(context.messages),
        personsTurn: turn.said !== null,
        said: [...(turn.said ?? []), ...turn.answers],
      };
      return {
        location_edit: defineTool({
          availableInSubagents: false,
          description:
            "Name the person's latest shared point in their words («я припарковался здесь» → label «парковка»; «это мой офис» → «офис»), or forget their location history («забудь, где я был», «удали геопозицию за вчера»). Forgetting cannot be undone.",
          inputSchema: editInputSchema,
          async execute(input, toolContext) {
            return locationEdit(input, toolContext, words);
          },
        }),
        location_now: defineTool({
          availableInSubagents: false,
          description:
            "Where the person is, by the location they shared themselves (a point or a place in Telegram, a location card in iMessage): address, accuracy, when; with `label`, the latest point they named so («парковка»). For «где я», «где я припарковался», «что рядом», «сколько идти отсюда», food or a taxi «сюда». A point older than an hour is where they were, not where they are; with none, ask them to send their location.",
          inputSchema: nowInputSchema,
          async execute(input, toolContext) {
            return locationNow(input, toolContext);
          },
        }),
      };
    },
  },
});
