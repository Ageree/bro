import type { PlaceState } from "@shared/subscriptions/place";

/**
 * The geometry of shared locations (`docs/location.md`): distances, the key
 * of a Telegram live share, and the geofence of a place reminder as one pure
 * step (`placeStep`). Shared because the database service and the agent both
 * decide with it.
 */

const earthRadiusM = 6_371_000;

interface Coordinates {
  readonly lat: number;
  readonly lon: number;
}

function radians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/** The great-circle distance in metres. */
export function distanceM(a: Coordinates, b: Coordinates) {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) *
      Math.cos(radians(b.lat)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The key of one Telegram live share: its chat and message. eve hands the
 * channel both as strings, the Bot API's JSON as numbers; either gives one key.
 */
export function liveKeyOf(chatId: number | string, messageId: number | string) {
  return `${String(chatId)}:${String(messageId)}`;
}

/** «55.7612, 37.6099»: four places, about 11 m. */
export function pointLabel(lat: number, lon: number) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** A point coarser than this says nothing about a circle. */
const unusableAccuracyM = 500;

/**
 * Which side of a circle a point is on. `edge` is the band where a point
 * neither enters nor leaves (hysteresis: jitter on the line never fires),
 * `unusable` a point too coarse to tell.
 */
export function pointSide({
  accuracyM,
  distanceM: distance,
  radiusM,
}: {
  readonly accuracyM: number | null;
  readonly distanceM: number;
  readonly radiusM: number;
}): "edge" | "in" | "out" | "unusable" {
  if (accuracyM !== null && accuracyM > unusableAccuracyM) return "unusable";
  if (distance <= radiusM && (accuracyM ?? 0) <= radiusM / 2) return "in";
  if (distance >= radiusM + Math.max(100, accuracyM ?? 50)) return "out";
  return "edge";
}

/** One shared point as the geofence reads it. */
export interface FencePoint extends Coordinates {
  readonly accuracyM: number | null;
  /** Whether this point may say the person arrived: any shared position. */
  readonly arriveAllowed: boolean;
  /** Whether it may say they left: a Telegram GPS point or a live edit. */
  readonly leaveAllowed: boolean;
  /** A live share's edit: a side change needs two of them in a row. */
  readonly live: boolean;
  readonly recordedAt: Date;
}

/** A point older than this updates the state but never fires. */
const freshForMs = 10 * 60_000;
/**
 * Faster than this between two live edits is a jump of the receiver. Only
 * against a point at most `outlierWindowMs` old: after a flight the old
 * anchor says nothing, and a wrong anchor must not veto every later point.
 */
const outlierKmh = 200;
const outlierMinimumSeconds = 5;
const outlierWindowMs = 15 * 60_000;
/** Two live edits on the new side at least this far apart confirm it. */
const debounceMs = 30_000;
/** A reminder this young does not fire on a point that finds it inside. */
const settleMs = 10 * 60_000;
/** How far back an edit outside lets a live share fire from no side yet. */
const recentOutMs = 24 * 60 * 60_000;
/** Beyond the radius by this much is a real trip, not jitter. */
const farBeyondM = 300;
/** How far back a far point makes an arrival a real trip. */
const farWithinMs = 3 * 60 * 60_000;

/** What one point did to a reminder: its new state and, maybe, the hit. */
export interface PlaceStepResult {
  readonly hit?: { readonly at: Date; readonly movedFar: boolean };
  readonly state: PlaceState;
}

/**
 * The geofence of one reminder, as a pure step over one shared point:
 * - a point not newer than the last one taken changes nothing;
 * - a live edit faster than 200 km/h from the last point, taken at most 15
 *   minutes before, is a jump, and dropped; a point the person sent is
 *   trusted, and becomes the new last point;
 * - a point older than 10 minutes moves the state but never fires;
 * - a side change this point has no right to say (a leave from iMessage or
 *   a venue, an arrival from a coarse web point) changes nothing;
 * - a live edit changes the side only on the second edit in a row on the
 *   new side, 30 s or more apart; a point the person sent, at once;
 * - from no side yet, a point inside fires an arrival only when the person
 *   sent it and the reminder is older than 10 minutes, or for a live edit
 *   after a point outside in the last 24 hours; otherwise it settles;
 * - `movedFar` (may wake at night): an arrival after a point beyond the
 *   radius and 300 m in the last 3 hours, a leave to beyond it.
 */
export function placeStep(
  state: PlaceState,
  point: FencePoint,
  options: {
    readonly center: Coordinates;
    readonly createdAt: Date;
    readonly now: Date;
    readonly on: "arrive" | "leave";
    readonly radiusM: number;
  }
): PlaceStepResult {
  const at = point.recordedAt.getTime();
  if (state.last !== null && at <= Date.parse(state.last.at)) {
    return { state };
  }
  if (state.last !== null && point.live) {
    const seconds = (at - Date.parse(state.last.at)) / 1000;
    const kmh = (distanceM(state.last, point) / 1000 / seconds) * 3600;
    if (
      seconds >= outlierMinimumSeconds &&
      seconds * 1000 <= outlierWindowMs &&
      kmh > outlierKmh
    ) {
      return { state };
    }
  }
  const distance = distanceM(options.center, point);
  const side = pointSide({
    accuracyM: point.accuracyM,
    distanceM: distance,
    radiusM: options.radiusM,
  });
  if (side === "unusable") return { state };
  const iso = point.recordedAt.toISOString();
  const far = distance > options.radiusM + farBeyondM;
  const farBefore =
    state.farAt !== null && at - Date.parse(state.farAt) <= farWithinMs;
  const outBefore =
    state.recentOut !== null && at - Date.parse(state.recentOut) <= recentOutMs;
  const moved: PlaceState = {
    ...state,
    farAt: far ? iso : state.farAt,
    last: { at: iso, lat: point.lat, lon: point.lon, side },
    recentOut: side === "out" ? iso : state.recentOut,
    sawPosition: true,
  };
  if (side === "edge") return { state: moved };
  const inside = side === "in";
  if (state.inside === inside) return { state: { ...moved, pending: null } };
  const allowed = inside ? point.arriveAllowed : point.leaveAllowed;
  if (!allowed) return { state: moved };
  const settled: PlaceState = {
    ...moved,
    changedAt: iso,
    inside,
    pending: null,
  };
  if (options.now.getTime() - at > freshForMs) return { state: settled };
  if (point.live) {
    const pending = state.pending;
    const sameSide = pending?.side === side;
    const confirmed = sameSide && at - Date.parse(pending.at) >= debounceMs;
    if (!confirmed) {
      return {
        state: {
          ...moved,
          pending: sameSide
            ? pending
            : { at: iso, lat: point.lat, lon: point.lon, side },
        },
      };
    }
  }
  if (state.inside === null) {
    const fires =
      inside &&
      options.on === "arrive" &&
      (point.live ? outBefore : at - options.createdAt.getTime() >= settleMs);
    if (!fires) return { state: settled };
    return {
      hit: { at: point.recordedAt, movedFar: farBefore },
      state: settled,
    };
  }
  const crossing = inside ? "arrive" : "leave";
  if (crossing !== options.on) return { state: settled };
  return {
    hit: { at: point.recordedAt, movedFar: inside ? farBefore : far },
    state: settled,
  };
}
