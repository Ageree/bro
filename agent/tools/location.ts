import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { turnAwaitsAnswer } from "@agent/lib/delivery/questions";
import { pointAddressNow } from "@agent/lib/location/address";
import { localStamp } from "@agent/lib/location/note";
import {
  type LonePoint,
  type Parked,
  probableParking,
  readHistory,
  type Stay,
} from "@agent/lib/location/stays";
import { forgetSaid, labelSaid } from "@agent/lib/location/words";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  nearbyPlace,
  openStreetMapAttribution,
} from "@agent/lib/routes/openstreetmap";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import {
  forgetLocation,
  labelPoint,
  latestPosition,
  listLocationPoints,
  locationPilot,
  locationWatchPilot,
} from "@db/services/location";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { distanceM } from "@shared/location/geometry";

/**
 * Where the person is, as they shared it (`docs/location.md`): the latest
 * point they sent, by name too («парковка»), the history of where they
 * stayed and went (`location_history`), and their own names for points and
 * forgetting them. Only the pilot (LOCATION_WORKSPACES) gets these, in
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

/**
 * The same ask where Bro follows a live location (`locationWatchPilot`):
 * a live share, not a single point — while it goes, Bro writes first when
 * a move matters (`agent/lib/location/watch.ts`).
 */
const askForLiveShare =
  "Ask the person to share a live location: in Telegram the paperclip, then «Геопозиция», then «Транслировать геопозицию» (until they stop it, or for 8 hours) — while it goes, Bro sees where they are and writes first when it matters; in iMessage there is none, only «Отправить мою геопозицию». Nothing else knows where they are.";

/** How Bro asks for a location in this workspace. */
function askFor(watching: boolean) {
  return watching ? askForLiveShare : askForPoint;
}

const nowInputSchema = z
  .object({
    ask: z
      .boolean()
      .optional()
      .describe(
        "true: Bro needs the person's location now and has none fresh — in Telegram this shows them a button that sends it; nothing is read."
      ),
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

/**
 * Asks the person for their location: in Telegram the channel shows the
 * keyboard button (`locationButton`, `agent/channels/telegram.ts`), with
 * its own line; elsewhere the model says how to send one.
 */
function askForLocation(context: ToolContext, watching: boolean) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  const channel = z
    .string()
    .safeParse(caller?.attributes.conversationChannel).data;
  if (channel !== "telegram") {
    return {
      asked: false,
      reply:
        channel === "eve"
          ? "Ask the person to press the pin button by the message field in this chat: it sends their location."
          : askFor(watching),
    };
  }
  return {
    asked: true,
    locationButton: true,
    reply: watching
      ? "The person now sees a button «📍 Отправить геопозицию» under the chat, which sends a single point. In one phrase ask them rather to share a live location (the paperclip, «Геопозиция», «Транслировать геопозицию»): then Bro follows where they are and writes first when it matters; the button is for a single point. Say in a few words what you will do once it comes."
      : "The person now sees a button «📍 Отправить геопозицию» under the chat, with a line saying it sends where they are: do not explain how to send a location; say in a few words what you will do once it comes, or nothing more if that is clear.",
  };
}

async function locationNow(
  input: z.output<typeof nowInputSchema>,
  context: ToolContext,
  watching: boolean
) {
  if (input.ask === true) return askForLocation(context, watching);
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
          ? `Bro has no location the person shared. ${askFor(watching)}`
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
          ? `This point is from ${localTime}: say where they were then, not where they are now. ${askFor(watching)}`
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
  if (!forgetSaid(said)) {
    return {
      changed: false,
      reply:
        "Nothing was changed: forgetting needs the person's own request in this turn. Ask them whether to delete their location history.",
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

const historyInputSchema = z
  .object({
    from: z
      .string()
      .optional()
      .describe(
        "The period's start, ISO 8601 with the offset; leave out for 24 hours before `to`."
      ),
    near: z
      .enum(["here", "anywhere"])
      .optional()
      .describe(
        "`here`: only places within 300 m of the person's latest point («что за кофейня тут была в прошлом месяце»)."
      ),
    to: z
      .string()
      .optional()
      .describe(
        "The period's end, ISO 8601 with the offset; leave out for now."
      ),
  })
  .strict();

/** The track a call reads at most: the latest points are kept. */
const historyPointCap = 4_000;
/** What one answer lists at most: the latest. */
const historyItemCap = 40;
/** Map lookups one call makes at most (the parking first, then the latest). */
const historyLookups = 3;
const historyLookupMs = 8_000;
const defaultHistoryMs = 24 * 60 * 60_000;
/** Older points are gone (`locationRetentionDays`). */
const longestHistoryMs = 90 * 24 * 60 * 60_000;
/** «Here» in the history: this close to the latest point. */
const hereM = 300;

const historyReply =
  "Times are on the person's clock. A trip's mode and where the car was left are guesses from the speed: say «похоже». `nearbyName` is the nearest named place on the map, not necessarily where they were. Bro knows only what the person shared (points they sent, a Telegram live location), so gaps are times it did not see.";

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function rounded(degrees: number) {
  return Math.round(degrees * 1e5) / 1e5;
}

/** The period of a history call, or why it does not read. */
function historyPeriod(
  input: z.output<typeof historyInputSchema>,
  now: Date
): { readonly from: Date; readonly to: Date } | { readonly reply: string } {
  const to = instant(input.to);
  const fromGiven = instant(input.from);
  if (to === null || fromGiven === null) {
    return {
      reply:
        "The period's bounds do not read as dates: give ISO 8601 with the offset.",
    };
  }
  const end = to && to < now ? to : now;
  const from = fromGiven ?? new Date(end.getTime() - defaultHistoryMs);
  if (from >= end)
    return { reply: "The period's start is not before its end." };
  const earliest = new Date(now.getTime() - longestHistoryMs);
  return { from: from < earliest ? earliest : from, to: end };
}

interface Nearby {
  readonly address?: string;
  readonly name?: string;
}

/**
 * The nearest named place (and an address) for the first few of `places`,
 * by one map lookup each; a failed or slow lookup ends the rest.
 */
async function lookUpNames<
  Place extends { readonly lat: number; readonly lon: number },
>(places: readonly Place[], signal: AbortSignal) {
  const found = new Map<Place, Nearby>();
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(historyLookupMs),
  ]);
  for (const place of places.slice(0, historyLookups)) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The map takes one request at a time.
      found.set(place, await nearbyPlace(place.lat, place.lon, deadline));
    } catch (error) {
      console.warn("[location] nearby lookup failed", {
        name: error instanceof Error ? error.name : "error",
      });
      break;
    }
  }
  return found;
}

/** Where a place in the history is: its address, name and point. */
function whereOf(
  place: {
    readonly address: string | null;
    readonly label: string | null;
    readonly lat: number;
    readonly lon: number;
  },
  nearby: Nearby | undefined
) {
  return {
    address: place.address ?? nearby?.address ?? null,
    label: place.label,
    lat: rounded(place.lat),
    lon: rounded(place.lon),
    ...(nearby?.name !== undefined && { nearbyName: nearby.name }),
  };
}

async function locationHistory(
  input: z.output<typeof historyInputSchema>,
  context: ToolContext
) {
  const scope = locationScope(context);
  const now = new Date();
  const period = historyPeriod(input, now);
  if ("reply" in period) return { known: false, reply: period.reply };
  const [track, timeZone, latest] = await Promise.all([
    listLocationPoints(scope, { ...period, limit: historyPointCap }),
    readWorkspaceTimeZone(scope),
    input.near === "here" ? latestPosition(scope, { now }) : undefined,
  ]);
  const here = latest?.point;
  if (input.near === "here" && here?.kind !== "position") {
    return {
      known: false,
      reply: `Bro does not know where the person is now. ${askForPoint}`,
    };
  }
  const read = readHistory(track.points);
  const items = read
    .filter(
      (item) =>
        here === undefined ||
        (item.kind !== "trip" && distanceM(here, item) <= hereM)
    )
    .slice(-historyItemCap);
  if (items.length === 0) {
    return {
      known: false,
      reply:
        here === undefined
          ? "No locations the person shared in this period. Say so: Bro knows only the points they sent and a Telegram live location."
          : "No places the person shared near here in this period. Say so.",
    };
  }
  const parking = here === undefined ? probableParking(read) : null;
  const places = items
    .filter((item): item is LonePoint | Stay => item.kind !== "trip")
    .toReversed()
    .toSorted((left, right) =>
      here === undefined ? 0 : distanceM(here, left) - distanceM(here, right)
    );
  const named = await lookUpNames<LonePoint | Parked | Stay>(
    [...(parking ? [parking] : []), ...places],
    context.abortSignal
  );
  const stamp = (at: Date) => ({
    at: at.toISOString(),
    local: localStamp(at, timeZone),
  });
  return {
    attribution: openStreetMapAttribution,
    items: items.map((item) => {
      if (item.kind === "trip") {
        return {
          end: stamp(item.end),
          km: item.km,
          kind: item.kind,
          maxKmh: item.maxKmh,
          minutes: minutesBetween(item.start, item.end),
          mode: item.mode,
          start: stamp(item.start),
        };
      }
      const where = whereOf(item, named.get(item));
      return item.kind === "stay"
        ? {
            ...where,
            afterDriving: item.afterDriving,
            end: stamp(item.end),
            kind: item.kind,
            minutes: minutesBetween(item.start, item.end),
            start: stamp(item.start),
          }
        : { ...where, at: stamp(item.at), kind: item.kind };
    }),
    known: true,
    parking: parking
      ? {
          ...whereOf(
            { ...parking, address: null, label: null },
            named.get(parking)
          ),
          at: stamp(parking.at),
        }
      : null,
    period: { from: stamp(period.from), to: stamp(period.to) },
    reply: historyReply,
    truncated: track.truncated || read.length > items.length,
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
      const watching = locationWatchPilot(scopeFromPrincipal(auth));
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
        location_history: defineTool({
          availableInSubagents: false,
          description:
            "Where the person stayed and how they moved, by the locations they shared (points they sent, a Telegram live location): stays with their address and the nearest named place, trips with distance, time and a guessed mode (walk, bike, vehicle), and where the car was probably left after the last drive. For «где я оставил машину», «сколько я ехал на велике», «что за кофейня тут была в прошлом месяце», «где я был вчера».",
          inputSchema: historyInputSchema,
          async execute(input, toolContext) {
            return locationHistory(input, toolContext);
          },
        }),
        location_now: defineTool({
          availableInSubagents: false,
          description: watching
            ? "Where the person is, by the location they shared themselves (a point, a place or a live location in Telegram, a location card in iMessage): address, accuracy, when; with `label`, the latest point they named so («парковка»). For «где я», «где я припарковался», «что рядом», «сколько идти отсюда», food or a taxi «сюда». A point older than an hour is where they were, not where they are; with none, ask them to share their location — `ask: true` shows them a button for it in Telegram. While they share a live location in Telegram, Bro follows it by itself: when they stop somewhere new or leave, it looks at their calendar and memory and writes first if that matters (late for an event, arrived where they have something to do), never at night. To be followed so, they share a live location («Транслировать геопозицию»), not a single point; stopping the share stops it."
            : "Where the person is, by the location they shared themselves (a point or a place in Telegram, a location card in iMessage): address, accuracy, when; with `label`, the latest point they named so («парковка»). For «где я», «где я припарковался», «что рядом», «сколько идти отсюда», food or a taxi «сюда». A point older than an hour is where they were, not where they are; with none, ask them to send their location — `ask: true` shows them a button for it in Telegram.",
          inputSchema: nowInputSchema,
          async execute(input, toolContext) {
            return locationNow(input, toolContext, watching);
          },
        }),
      };
    },
  },
});
