import { createHash } from "node:crypto";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { mapPointsIn } from "@agent/lib/location/links";
import { addressSaid, textSaid } from "@agent/lib/location/words";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  findPlaces,
  lookupsPerCall,
  type MapPlace,
} from "@agent/lib/routes/openstreetmap";
import {
  scheduleDelivery,
  scheduleOwner,
  scheduleReplyAnchor,
  scheduleScope,
} from "@agent/lib/schedules/tools";
import { daysSaid } from "@agent/lib/subscriptions/price";
import { placeWatchOf } from "@agent/lib/subscriptions/watches";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import {
  latestPosition,
  latestSharedPoint,
  liveSharingSeen,
  locationPilot,
  locationWatchPilot,
} from "@db/services/location";
import {
  createSubscription,
  listLiveSubscriptions,
  setSubscriptionStatus,
} from "@db/services/subscriptions";
import {
  readUserProfile,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";
import { distanceM, pointSide } from "@shared/location/geometry";
import { emptyPlaceState, type PlaceSource } from "@shared/subscriptions/place";
import { localRunLabel } from "@shared/schedules/timing";

/**
 * A reminder at a place (`docs/location.md`): the person's own words, said
 * back to them when a location they share shows them arriving at a place or
 * leaving it. The place and the words come from the person only — their
 * point, their home address, a point they just sent, an address or a map
 * link in their message — never from a page or an email read in the turn.
 */

const defaultDays = 14;
const maximumDays = 90;
const defaultRadiusM = 150;
/** The tick reads no place: it only ends one at its term. */
const checkEverySeconds = 24 * 60 * 60;
/** «here» takes the person's point this fresh. */
const hereFreshMs = 30 * 60_000;
/** «shared» takes a point they sent this recently. */
const sharedFreshMs = 15 * 60_000;
/** A point this fresh says on which side the person is right now. */
const sideFreshMs = 2 * 60 * 60_000;
/** Matches farther apart than this are different places: ask which. */
const ambiguousM = 1_000;
/** Matches within this of the person's last point are in their city. */
const ownCityM = 60_000;

const inputSchema = z
  .object({
    action: z
      .enum(["create", "list", "cancel"])
      .describe(
        "`create` a reminder, `list` the person's reminders at places, `cancel` one by `id`."
      ),
    days: z
      .number()
      .int()
      .optional()
      .describe(
        "How many days the reminder waits, only if the person said; 14 otherwise."
      ),
    id: z.string().optional().describe("`cancel` only: the reminder's id."),
    on: z
      .enum(["arrive", "leave"])
      .optional()
      .describe("When it fires: on arriving (default) or on leaving."),
    place: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe(
        "`here` (where the person is now), `home` (their address in Personal Info), `shared` (the place or point they just sent), or an address or a map link exactly as they wrote it."
      ),
    radiusM: z
      .number()
      .int()
      .optional()
      .describe(
        "The circle around the place in metres, 75 to 2000; 150 otherwise."
      ),
    text: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe("What to remind of, in the person's own words."),
  })
  .strict();

type Input = z.output<typeof inputSchema>;

/** The person's words the reminder is checked against, taken per step. */
interface ReminderWords {
  readonly personsTurn: boolean;
  readonly said: readonly string[];
}

function given(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "*"
    ? undefined
    : trimmed;
}

const askForPoint =
  "in Telegram the paperclip, then «Геопозиция»; in iMessage «Отправить мою геопозицию»";

/** Where a reminder is: its point, how it was given, and its name. */
type Place = Pick<PlaceSource, "address" | "label" | "lat" | "lon" | "origin">;

type Resolved =
  | { readonly kind: "place"; readonly place: Place }
  | { readonly kind: "reply"; readonly reply: string };

function reply(text: string): Resolved {
  return { kind: "reply", reply: text };
}

/**
 * The map's match for an address, or a question when it is not one place.
 * Matches in several cities, some of them near the person's last point,
 * are the ones in their city: «Центральный телеграф» is Moscow's for a
 * person in Moscow, not Tashkent's (live check 15.10).
 */
function onePlace(
  matches: readonly MapPlace[],
  origin: Place["origin"],
  label: string,
  near?: Pick<MapPlace, "lat" | "lon">
): Resolved {
  const local =
    near === undefined
      ? []
      : matches.filter((place) => distanceM(place, near) <= ownCityM);
  const found =
    local.length > 0 && local.length < matches.length ? local : matches;
  const [first] = found;
  if (!first) {
    return reply(
      "The map does not know this address. Ask the person for the street and house, or to send their location there."
    );
  }
  const far = found.some((other) => distanceM(first, other) > ambiguousM);
  if (first.kind === "area" || first.kind === "street" || far) {
    return reply(
      `The address matches ${far ? "several places" : "a whole street or area"} (${found
        .map((place) => place.label)
        .join(
          "; "
        )}). If the person's message names the house or the city, call again with them added to \`place\`, and add no street or house they did not write; otherwise ask the person which one. Nothing was set up.`
    );
  }
  return {
    kind: "place",
    place: {
      address: first.label.slice(0, 200),
      label,
      lat: first.lat,
      lon: first.lon,
      origin,
    },
  };
}

/**
 * The keyword a place stands for. The model writes them in the person's
 * language as often as not («сюда», «домой»: live check 15.10), or the
 * address `location_now` gave for the person's own point — that is «here»
 * too, not an address the person wrote.
 */
const placeKeywords: ReadonlyMap<string, "here" | "home" | "shared"> = new Map([
  ["here", "here"],
  ["сюда", "here"],
  ["здесь", "here"],
  ["тут", "here"],
  ["где я", "here"],
  ["где я сейчас", "here"],
  ["текущее место", "here"],
  ["мое место", "here"],
  ["current location", "here"],
  ["home", "home"],
  ["дом", "home"],
  ["домой", "home"],
  ["дома", "home"],
  ["мой дом", "home"],
  ["shared", "shared"],
  ["это место", "shared"],
  ["присланное место", "shared"],
  ["эта точка", "shared"],
]);

function folded(text: string) {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function placeKeyword(wanted: string, ownAddress: string | null) {
  const key = folded(wanted);
  const keyword = placeKeywords.get(key);
  if (keyword !== undefined) return keyword;
  return ownAddress !== null && folded(ownAddress) === key ? "here" : key;
}

async function resolvePlace(
  wanted: string,
  context: ToolContext,
  said: readonly string[]
): Promise<Resolved> {
  const scope = scheduleScope(context);
  const now = Date.now();
  const latest = await latestPosition(scope);
  const lowered = placeKeyword(wanted, latest?.point.address ?? null);
  if (lowered === "here") {
    if (!latest || now - latest.point.recordedAt.getTime() > hereFreshMs) {
      return reply(
        `Bro has no location of the person's from the last 30 minutes. Ask them to send it (${askForPoint}), then set the reminder. Nothing was set up.`
      );
    }
    const { point } = latest;
    return {
      kind: "place",
      place: {
        address: point.address,
        label: point.label ?? point.address ?? "это место",
        lat: point.lat,
        lon: point.lon,
        origin: "here",
      },
    };
  }
  if (lowered === "shared") {
    const point = await latestSharedPoint(scope, new Date(now - sharedFreshMs));
    if (!point) {
      return reply(
        `The person sent no place or location in the last 15 minutes. Ask them to send it (${askForPoint}). Nothing was set up.`
      );
    }
    return {
      kind: "place",
      place: {
        address: point.address,
        label: point.label ?? point.address ?? "присланное место",
        lat: point.lat,
        lon: point.lon,
        origin: "shared",
      },
    };
  }
  if (lowered === "home") {
    const profile = await readUserProfile(scope);
    const query = [profile.addressLine1, profile.city]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(", ");
    if (profile.addressLine1 === null || query.length === 0) {
      return reply(
        "Personal Info has no home address. Ask the person for it, and offer to save it there. Nothing was set up."
      );
    }
    const found = await findPlaces(
      query,
      undefined,
      { remaining: lookupsPerCall },
      context.abortSignal,
      3
    );
    return onePlace(found, "home", "дом");
  }
  const [link] = mapPointsIn(wanted);
  if (link) {
    if (!said.some((words) => words.includes(wanted))) {
      return reply(
        "Nothing was set up: the map link must be one the person sent in this message."
      );
    }
    return {
      kind: "place",
      place: {
        address: null,
        label: link.label ?? "место по ссылке",
        lat: link.lat,
        lon: link.lon,
        origin: "link",
      },
    };
  }
  if (!addressSaid(wanted, said)) {
    return reply(
      "Nothing was set up: the address must be written as the person wrote it in this message. Ask them for it."
    );
  }
  const found = await findPlaces(
    wanted,
    undefined,
    { remaining: lookupsPerCall },
    context.abortSignal,
    3
  );
  return onePlace(found, "address", wanted.slice(0, 80), latest?.point);
}

/**
 * Whether a stored point came from where a leave is seen later too: a
 * Telegram live share, or a Telegram GPS fix with its accuracy. iMessage, a
 * venue and the web never say the person left (`placeStep`).
 */
function leavesSeen(point: {
  readonly accuracyM: number | null;
  readonly source: string;
}) {
  return (
    point.source === "telegram_live" ||
    (point.source === "telegram" && point.accuracyM !== null)
  );
}

/**
 * Which side of the circle the person is on right now, by a fresh point of
 * theirs: a reminder made where they already are fires on the next arrival.
 * «Inside» only from a source that will later see them leave: otherwise the
 * reminder would stay inside for good and never fire; unknown lets the
 * first point decide (`placeStep`).
 */
async function sideNow(
  context: ToolContext,
  place: Place,
  radiusM: number
): Promise<boolean | null> {
  const latest = await latestPosition(scheduleScope(context));
  if (
    latest?.point.kind !== "position" ||
    Date.now() - latest.point.recordedAt.getTime() > sideFreshMs
  ) {
    return null;
  }
  const side =
    place.origin === "here"
      ? "in"
      : pointSide({
          accuracyM: latest.point.accuracyM,
          distanceM: distanceM(place, latest.point),
          radiusM,
        });
  if (side === "out") return false;
  return side === "in" && leavesSeen(latest.point) ? true : null;
}

/**
 * A reminder's key: its crossing, its place to about 100 m, and its words,
 * so a second reminder at the same place is one more, and only the same one
 * asked again renews it.
 */
function reminderKey(
  on: "arrive" | "leave",
  place: Pick<Place, "lat" | "lon">,
  text: string
) {
  const words = createHash("sha256")
    .update(text.trim().toLowerCase().replaceAll(/\s+/gu, " "))
    .digest("hex")
    .slice(0, 16);
  return `${on}:${place.lat.toFixed(3)},${place.lon.toFixed(3)}:${words}`;
}

async function createReminder(
  input: Input,
  context: ToolContext,
  { personsTurn, said }: ReminderWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    return {
      created: false,
      reply:
        "Nothing was set up: a reminder at a place starts only in a turn the person's own message opened.",
    };
  }
  const text = given(input.text);
  if (text === undefined || !textSaid(text, said)) {
    return {
      created: false,
      reply:
        "Nothing was set up: the reminder's text must be the person's own words from their message. Ask them what to remind of.",
    };
  }
  const placeGiven = given(input.place);
  if (placeGiven === undefined) {
    return {
      created: false,
      reply:
        "Nothing was set up: say where — here, home, the place they just sent, or an address. Ask the person.",
    };
  }
  const resolved = await resolvePlace(placeGiven, context, said);
  if (resolved.kind === "reply")
    return { created: false, reply: resolved.reply };
  const { place } = resolved;
  const on = input.on ?? "arrive";
  const radiusM =
    input.radiusM !== undefined && input.radiusM > 0
      ? Math.min(Math.max(input.radiusM, 75), 2_000)
      : defaultRadiusM;
  const days =
    input.days !== undefined && daysSaid(said).has(input.days)
      ? Math.min(Math.max(input.days, 1), maximumDays)
      : defaultDays;
  const inside = await sideNow(context, place, radiusM);
  const owner = scheduleOwner(context);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60_000);
  const { created, subscription } = await createSubscription(
    owner.scope,
    {
      checkEverySeconds,
      condition: { on, repeat: false, text },
      conversation: owner.conversation,
      dedupeKey: reminderKey(on, place, text),
      // No address and no point: the description is shown in lists.
      description: `Place reminder: when the person ${on === "arrive" ? "arrives at" : "leaves"} «${place.label}»`,
      expiresAt,
      replyAnchorMessageId: scheduleReplyAnchor(context),
      source: { ...place, label: place.label.slice(0, 80), radiusM },
      state: {
        ...emptyPlaceState,
        changedAt: inside === null ? null : now.toISOString(),
        inside,
      },
      template: "place",
      wake: "urgent_at_night",
    },
    now
  );
  const [timeZone, delivery, liveSeen] = await Promise.all([
    readWorkspaceTimeZone(owner.scope),
    scheduleDelivery({
      ...owner.conversation,
      replyAnchorMessageId: null,
      workspaceId: owner.scope.workspaceId,
    }),
    liveSharingSeen(owner.scope),
  ]);
  const where =
    place.address === null
      ? `«${place.label}»`
      : `«${place.label}» (${place.address})`;
  const already =
    on === "arrive" && inside === true
      ? " The person is there now: it fires the next time they arrive; say so."
      : on === "leave" && inside === false
        ? " The person is not there now: it fires after they arrive and then leave; say so."
        : "";
  const condition = liveSeen
    ? "It works while they share a live location in Telegram («Транслировать геопозицию»), or when they send a point there."
    : locationWatchPilot(owner.scope)
      ? "It works while they share a live location in Telegram: ask them to turn it on when they head out (the paperclip, «Геопозиция», «Транслировать геопозицию»), or to send their location when they are there."
      : `Bro does not follow them all the time: tell them to send their location when they are there (${askForPoint}), and Bro reminds them then.${on === "leave" ? " A leave is noticed only from a Telegram point sent already outside; suggest a time-based reminder instead if that suits better." : ""}`;
  return {
    created: true,
    id: subscription.id,
    reply: `${created ? "The reminder is set up" : "The same reminder already existed; its term is renewed"}. Say: when they ${on === "arrive" ? "arrive at" : "leave"} ${where} (within ${String(radiusM)} m), Bro reminds them «${text}», until ${localRunLabel(expiresAt, timeZone)}, in ${delivery.deliversTo}. ${condition}${already}`,
  };
}

async function listReminders(context: ToolContext) {
  const scope = scheduleScope(context);
  const [rows, timeZone] = await Promise.all([
    listLiveSubscriptions(scope),
    readWorkspaceTimeZone(scope),
  ]);
  const reminders = rows.flatMap((row) => {
    const watch = placeWatchOf(row);
    if (!watch) return [];
    return [
      {
        address: watch.source.address,
        id: watch.id,
        label: watch.source.label,
        on: watch.condition.on,
        radiusM: watch.source.radiusM,
        status: watch.status,
        text: watch.condition.text,
        untilLocal: localRunLabel(watch.expiresAt, timeZone),
      },
    ];
  });
  return {
    reminders,
    reply:
      reminders.length === 0
        ? "The person has no reminders at places."
        : "List them in plain words; cancel one only on the person's word.",
  };
}

async function cancelReminder(
  input: Input,
  context: ToolContext,
  { personsTurn }: ReminderWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    return {
      cancelled: false,
      reply:
        "Nothing was changed: only a turn the person's own message opened cancels a reminder.",
    };
  }
  const id = z.uuid().safeParse(given(input.id)).data;
  const scope = scheduleScope(context);
  const rows = id === undefined ? [] : await listLiveSubscriptions(scope);
  const reminder = rows.find(
    (row) => row.id === id && row.template === "place"
  );
  if (!reminder || id === undefined) {
    return {
      cancelled: false,
      reply:
        "No live reminder at a place has this id: list them (`list`) first.",
    };
  }
  await setSubscriptionStatus(scope, id, "deleted");
  return { cancelled: true, reply: "The reminder is cancelled: say so." };
}

export default defineDynamic({
  events: {
    // Only the pilot (LOCATION_WORKSPACES) gets the tool, the same at every
    // step. The person's words are taken before each step: the reminder's
    // words and place are checked against them, never the model's.
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
      const words: ReminderWords = {
        personsTurn: turn.said !== null,
        said: [...(turn.said ?? []), ...turn.answers],
      };
      return {
        place_reminder: defineTool({
          availableInSubagents: false,
          description:
            "A reminder at a place: say the person's own words back to them when they arrive at a place or leave it, by the location they share. `place`: `here` (where they are now), `home` (the address in Personal Info), `shared` (a place or point they just sent), or an address or a map link from their message. Only on the person's request. Tell them the condition from `reply`. `list` shows their reminders at places, `cancel` cancels one by id.",
          inputSchema,
          async execute(input, toolContext) {
            if (input.action === "list") return listReminders(toolContext);
            if (input.action === "cancel") {
              return cancelReminder(input, toolContext, words);
            }
            return createReminder(input, toolContext, words);
          },
        }),
      };
    },
  },
});
