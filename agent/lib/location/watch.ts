import * as z from "zod";
import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import { nearbyPlace } from "@agent/lib/routes/openstreetmap";
import {
  labelNear,
  locationWatchPilot,
  readShareTrack,
} from "@db/services/location";
import { type ProactiveSignal, queueLocationRun } from "@db/services/proactive";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { distanceM } from "@shared/location/geometry";
import { pointAddressNow } from "./address";
import { localStamp, locationLinePrefix, quoted, whereWords } from "./note";
import { type HistoryItem, readHistory, type Stay } from "./stays";

/**
 * Bro following the person's Telegram live location (`docs/location.md`,
 * «Бро следит за трансляцией»; pilot `LOCATION_WATCH_WORKSPACES`). Each
 * stored point of a live share is read with the share's last hours
 * (`readHistory`), and a move that may matter wakes Bro's own check: the
 * person stopped somewhere new (`arrive`) or left where they had been
 * (`leave`). The check's worker reads the move as code tells it
 * (`liveMoveLines`) with their calendar and memory, and writes first only
 * when the move changes something for them now. Nothing at night, a cap of
 * runs a day of its own and one run per ten minutes (`queueLocationRun`);
 * stopping the share or turning proactive messages off stops it all.
 */

type Trip = Extract<HistoryItem, { readonly kind: "trip" }>;

/** A move worth a look: where the person stopped, or where they left. */
export type LiveMove =
  | {
      readonly kind: "arrive";
      /** Where they stayed before the trip here, if the window shows it. */
      readonly before: Stay | undefined;
      readonly stay: Stay;
      readonly trip: Trip;
    }
  | { readonly from: Stay; readonly kind: "leave"; readonly trip: Trip };

/** The share's hours a move is read from. */
const trackWindowMs = 3 * 60 * 60_000;
/** Points of a share one read takes at most: the latest. */
const trackLimit = 2_000;
/** The latest point this old says where the person was, not where they are. */
const quietShareMs = 10 * 60_000;
/** A stop that began longer ago is no news. */
const arriveWithinMs = 30 * 60_000;
/** A departure that began longer ago is no news. */
const leaveWithinMs = 20 * 60_000;
/**
 * A new place is at least this far from the last one; a departure has gone
 * this far. Walking round a mall or a park is not a move.
 */
const movedM = 500;
/** A share is read for moves at most this often by its own time. */
const watchEveryMs = 60_000;
/** A live location's runs a day, and the spacing between them. */
const locationRunsPerDay = 12;
const locationRunSpacingMs = 10 * 60_000;
/** Within this of a place the person named, they are there. */
const namedPlaceM = 150;
const nearbyLookupMs = 8_000;
/** Shares whose last read this instance remembers. */
const rememberedShares = 1_000;

/**
 * When each live share was last read for a move, by its key: the time of
 * the point read. One eve serves the database (`docs/dev-notes.md`); after a
 * restart a share is read once more, and a move already handed over is
 * `seen`.
 */
const watched = new Map<string, number>();

function rememberWatched(liveKey: string, at: number) {
  watched.delete(liveKey);
  watched.set(liveKey, at);
  for (const oldest of watched.keys()) {
    if (watched.size <= rememberedShares) break;
    watched.delete(oldest);
  }
}

/**
 * The move the share's history (`readHistory`, oldest first) ends on, if it
 * is one to look at now: `arrive` — the person has stayed five minutes or
 * more at a place they came to, 500 m or more from where they stayed
 * before, within the last half hour; `leave` — they left where they stayed
 * and went 500 m or more from it, within the last 20 minutes. A share that
 * has been quiet for 10 minutes says neither: it is where they were. The
 * place a share began at is no arrival: nothing brought them there.
 */
export function liveMove(
  items: readonly HistoryItem[],
  latest: {
    readonly lat: number;
    readonly lon: number;
    readonly recordedAt: Date;
  },
  now: Date
): LiveMove | undefined {
  const last = items.at(-1);
  const previous = items.at(-2);
  if (!last || now.getTime() - latest.recordedAt.getTime() > quietShareMs) {
    return undefined;
  }
  if (last.kind === "stay" && previous?.kind === "trip") {
    if (now.getTime() - last.start.getTime() > arriveWithinMs) return undefined;
    const earlier = items.at(-3);
    const before = earlier?.kind === "stay" ? earlier : undefined;
    if (before && distanceM(before, last) < movedM) return undefined;
    return { before, kind: "arrive", stay: last, trip: previous };
  }
  if (last.kind === "trip" && previous?.kind === "stay") {
    if (now.getTime() - last.start.getTime() > leaveWithinMs) return undefined;
    if (distanceM(previous, latest) < movedM) return undefined;
    return { from: previous, kind: "leave", trip: last };
  }
  return undefined;
}

/**
 * The signal of a move: one per stop (when it began) and one per departure
 * (the last point at the place left: the start of a long stay slides with
 * the window read), on the share's key, so a move is handed over once.
 */
export function liveMoveSignal(
  liveKey: string,
  move: LiveMove
): ProactiveSignal {
  const at = move.kind === "arrive" ? move.stay.start : move.from.end;
  return {
    dedupeKey: `${liveKey}#${move.kind}@${String(at.getTime())}`,
    itemId: liveKey,
    source: "location",
    threadId: null,
  };
}

const moveKindSchema = z.enum(["arrive", "leave"]);

/** Which move a location signal was, by its key. */
function moveKindOf(dedupeKey: string) {
  return moveKindSchema.safeParse(/#(\w+)@\d+$/u.exec(dedupeKey)?.[1]).data;
}

/**
 * Reads a live share for a move once a point of it is stored, and queues
 * Bro's check for a move that may matter. Returns what happened, for the
 * route's log line; never throws on a failed read (logged).
 */
export async function noticeLiveMove(
  scope: AccessScope,
  liveKey: string,
  at: Date,
  now = new Date()
) {
  if (!locationWatchPilot(scope)) return "off";
  const last = watched.get(liveKey);
  if (last !== undefined && at.getTime() - last < watchEveryMs) {
    return "throttled";
  }
  rememberWatched(liveKey, at.getTime());
  try {
    const timeZone = await readWorkspaceTimeZone(scope);
    if (quietHoursEnd(now, timeZone)) return "night";
    const track = await readShareTrack(scope, liveKey, {
      limit: trackLimit,
      since: new Date(now.getTime() - trackWindowMs),
    });
    const latest = track.at(-1);
    const move = latest && liveMove(readHistory(track), latest, now);
    if (!move) return "still";
    const queued = await queueLocationRun({
      now,
      perDay: locationRunsPerDay,
      sameMove: {
        keyPrefix: `${liveKey}#${move.kind}@`,
        withinMs: move.kind === "arrive" ? arriveWithinMs : leaveWithinMs,
      },
      signal: liveMoveSignal(liveKey, move),
      spacingMs: locationRunSpacingMs,
      workspaceId: scope.workspaceId,
    });
    return `${move.kind}:${queued.status}`;
  } catch (error) {
    console.warn("[location] watch failed", {
      name: error instanceof Error ? error.name : "error",
      workspaceId: scope.workspaceId,
    });
    return "failed";
  }
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** «14:05» on the person's clock. */
function clock(at: Date, timeZone: string) {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    });
    clockFormats.set(timeZone, format);
  }
  return format.format(at);
}

function minutes(from: Date, to: Date) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

const modeWords = {
  bike: "похоже, на велосипеде или самокате",
  vehicle: "похоже, на машине или транспорте",
  walk: "похоже, пешком",
} as const;

function tripWords(trip: Trip) {
  return `${String(minutes(trip.start, trip.end))} мин, ≈ ${String(trip.km)} км, ${modeWords[trip.mode]}`;
}

/** Where a stay was, with the person's own name for it when they gave one. */
async function stayWords(scope: AccessScope, stay: Stay, timeZone: string) {
  const named = stay.label ?? (await labelNear(scope, stay, namedPlaceM));
  const name =
    named === undefined
      ? ""
      : ` (он сам называл это место ${quoted(named, 40) ?? ""})`;
  return `${whereWords(stay)}${name}, с ${clock(stay.start, timeZone)} до ${clock(stay.end, timeZone)}`;
}

/** The nearest named place on the map, or nothing when the map is slow. */
async function nearbyName(lat: number, lon: number) {
  try {
    const place = await nearbyPlace(
      lat,
      lon,
      AbortSignal.timeout(nearbyLookupMs)
    );
    return place.name;
  } catch (error) {
    console.warn("[location] nearby lookup failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return undefined;
  }
}

/**
 * What the worker of a location run reads of the move, as context lines
 * (`locationLinePrefix`: logs fold them): where the person is now by the
 * share's latest point — its address, the nearest named place on the map,
 * their own name for it, and the coordinates `route_time` takes — and how
 * they got there or where they left. Read when the run starts, not when the
 * move was seen: the person may have moved on since. Empty when the share's
 * points are gone (forgotten) or the signal is no move.
 */
export async function liveMoveLines(
  scope: AccessScope,
  signal: Pick<ProactiveSignal, "dedupeKey" | "itemId">,
  timeZone: string,
  now = new Date()
): Promise<string[]> {
  const kind = moveKindOf(signal.dedupeKey);
  if (kind === undefined) return [];
  const track = await readShareTrack(scope, signal.itemId, {
    limit: trackLimit,
    since: new Date(now.getTime() - trackWindowMs),
  });
  const latest = track.at(-1);
  if (!latest) return [];
  const items = readHistory(track);
  const [address, nearby, named] = await Promise.all([
    pointAddressNow(scope, latest),
    nearbyName(latest.lat, latest.lon),
    labelNear(scope, latest, namedPlaceM),
  ]);
  const quiet = now.getTime() - latest.recordedAt.getTime() > quietShareMs;
  const lines = [
    `${locationLinePrefix} ${kind === "arrive" ? "человек остановился на новом месте" : "человек ушёл оттуда, где был, и в пути"} — по его трансляции геопозиции в Telegram, адреса и названия ниже — данные карты.`,
    `${locationLinePrefix} последняя точка — ${localStamp(latest.recordedAt, timeZone)}: ${whereWords({ ...latest, address })}${latest.accuracyM === null ? "" : `, ±${String(latest.accuracyM)} м`}${nearby === undefined ? "" : `; ближайшее место на карте — ${quoted(nearby, 80) ?? ""} (не обязательно то, где он)`}${named === undefined ? "" : `; это место он сам называл ${quoted(named, 40) ?? ""}`}. Координаты для route_time: ${latest.lat.toFixed(5)}, ${latest.lon.toFixed(5)}.`,
    ...(quiet
      ? [
          `${locationLinePrefix} с тех пор новых точек нет: трансляция закончилась или молчит, это где он был, а не где он сейчас.`,
        ]
      : []),
  ];
  const last = items.at(-1);
  const before = items.at(-2);
  if (last?.kind === "stay") {
    lines.push(
      `${locationLinePrefix} здесь с ${clock(last.start, timeZone)} (${String(minutes(last.start, latest.recordedAt))} мин).${before?.kind === "trip" ? ` Добирался ${tripWords(before)}.` : ""}`
    );
    const earlier = items.at(-3);
    if (before?.kind === "trip" && earlier?.kind === "stay") {
      lines.push(
        `${locationLinePrefix} до этого был: ${await stayWords(scope, earlier, timeZone)}.`
      );
    }
  } else if (last?.kind === "trip") {
    lines.push(
      `${locationLinePrefix} в пути с ${clock(last.start, timeZone)}: ${tripWords(last)}.`
    );
    if (before?.kind === "stay") {
      lines.push(
        `${locationLinePrefix} ушёл оттуда, где был: ${await stayWords(scope, before, timeZone)}.`
      );
    }
  }
  return lines;
}
