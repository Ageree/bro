import type { locationPoints } from "@db";
import { distanceM } from "@shared/location/geometry";

/**
 * Where the person stayed and how they moved, read from the positions they
 * shared (`location_history`, `docs/location.md`). Pure: the tool reads the
 * points and the addresses. A stay is five minutes or more within 150 m; a
 * trip is the movement between, while points keep coming at most half an
 * hour apart (a longer silence is a pause in sharing, not a trip); a point
 * that is neither is one the person sent on its own. The mode of a trip and
 * where the car was left are guesses from the speed, and are called so.
 */

type TrackPoint = Pick<
  typeof locationPoints.$inferSelect,
  "accuracyM" | "address" | "id" | "label" | "lat" | "lon" | "recordedAt"
>;

/** A stay: five minutes or more in one place. */
export interface Stay {
  /** It began right after a trip by car: the car is probably near. */
  readonly afterDriving: boolean;
  readonly address: string | null;
  readonly end: Date;
  readonly kind: "stay";
  readonly label: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly points: number;
  readonly start: Date;
}

/** Where a car trip probably ended: the last point it still moved fast. */
export interface Parked {
  readonly at: Date;
  readonly lat: number;
  readonly lon: number;
}

/** A trip between stays. */
interface Trip {
  readonly end: Date;
  readonly kind: "trip";
  readonly km: number;
  readonly maxKmh: number;
  readonly mode: TripMode;
  readonly parked: Parked | null;
  readonly start: Date;
}

/** A point the person sent on its own, neither a stay nor on a trip. */
export interface LonePoint {
  readonly address: string | null;
  readonly at: Date;
  readonly kind: "point";
  readonly label: string | null;
  readonly lat: number;
  readonly lon: number;
}

type TripMode = "bike" | "vehicle" | "walk";

export type HistoryItem = LonePoint | Stay | Trip;

/** Within this of a stay's centre a point is still the stay. */
const stayRadiusM = 150;
/** A stay is at least this long. */
const stayMinimumMs = 5 * 60_000;
/** Points this far apart inside one place are still one stay. */
const stayGapMs = 60 * 60_000;
/** Points this far apart are not one trip: the sharing paused. */
const tripGapMs = 30 * 60_000;
/** A trip shorter than this is jitter around one place. */
const tripMinimumM = 200;
/** A segment shorter than its points' accuracy says no speed. */
const noiseFloorM = 30;
/** Faster than walking. */
const walkKmh = 8;
/** Faster than a bike. */
const bikeKmh = 28;
/** A speed from points closer in time than this is noise. */
const speedMinimumS = 20;

interface Cluster {
  lat: number;
  lon: number;
  readonly points: TrackPoint[];
}

function closeEnough(cluster: Cluster, point: TrackPoint) {
  const last = cluster.points.at(-1);
  return (
    last !== undefined &&
    point.recordedAt.getTime() - last.recordedAt.getTime() <= stayGapMs &&
    distanceM(cluster, point) <= stayRadiusM
  );
}

function add(cluster: Cluster, point: TrackPoint) {
  cluster.points.push(point);
  const count = cluster.points.length;
  cluster.lat += (point.lat - cluster.lat) / count;
  cluster.lon += (point.lon - cluster.lon) / count;
}

function spanMs(points: readonly TrackPoint[]) {
  const first = points[0];
  const last = points.at(-1);
  return first && last
    ? last.recordedAt.getTime() - first.recordedAt.getTime()
    : 0;
}

/** Points in order, grouped into stays and the loose points between. */
function clusters(points: readonly TrackPoint[]) {
  const runs: ({ stay: Cluster } | { loose: TrackPoint })[] = [];
  let current: Cluster | undefined;
  const close = () => {
    if (!current) return;
    if (spanMs(current.points) >= stayMinimumMs) runs.push({ stay: current });
    else for (const point of current.points) runs.push({ loose: point });
    current = undefined;
  };
  for (const point of points) {
    if (current && closeEnough(current, point)) {
      add(current, point);
      continue;
    }
    close();
    current = { lat: point.lat, lon: point.lon, points: [point] };
  }
  close();
  return runs;
}

function segmentKmh(from: TrackPoint, to: TrackPoint) {
  const seconds = (to.recordedAt.getTime() - from.recordedAt.getTime()) / 1000;
  const metres = distanceM(from, to);
  const noise = Math.max(
    noiseFloorM,
    (from.accuracyM ?? 0) + (to.accuracyM ?? 0)
  );
  if (seconds < speedMinimumS || metres < noise) return { kmh: 0, metres };
  return { kmh: (metres / 1000 / seconds) * 3600, metres };
}

function modeOf(kmh: number): TripMode {
  if (kmh < walkKmh) return "walk";
  return kmh < bikeKmh ? "bike" : "vehicle";
}

/**
 * One trip over consecutive points: its distance, the mode most of that
 * distance went at, the top speed and, by car, where it probably stopped.
 */
function trip(points: readonly TrackPoint[]): Trip | undefined {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return undefined;
  const byMode: Record<TripMode, number> = { bike: 0, vehicle: 0, walk: 0 };
  let metres = 0;
  let maxKmh = 0;
  let lastFast: TrackPoint | undefined;
  for (const [index, to] of points.entries()) {
    const from = points[index - 1];
    if (!from) continue;
    const segment = segmentKmh(from, to);
    metres += segment.metres;
    byMode[modeOf(segment.kmh)] += segment.metres;
    maxKmh = Math.max(maxKmh, segment.kmh);
    if (segment.kmh >= walkKmh) lastFast = to;
  }
  if (metres < tripMinimumM) return undefined;
  const mode = (["vehicle", "bike", "walk"] as const).reduce((best, next) =>
    byMode[next] > byMode[best] ? next : best
  );
  const parked = mode === "vehicle" ? (lastFast ?? last) : undefined;
  return {
    end: last.recordedAt,
    kind: "trip",
    km: Math.round(metres / 100) / 10,
    maxKmh: Math.round(maxKmh),
    mode,
    parked: parked
      ? { at: parked.recordedAt, lat: parked.lat, lon: parked.lon }
      : null,
    start: first.recordedAt,
  };
}

function stayOf(cluster: Cluster, afterDriving: boolean): Stay {
  const first = cluster.points[0];
  const last = cluster.points.at(-1);
  if (!first || !last) throw new Error("A stay has points.");
  return {
    address:
      cluster.points.find((point) => point.address !== null)?.address ?? null,
    afterDriving,
    end: last.recordedAt,
    kind: "stay",
    label: cluster.points.find((point) => point.label !== null)?.label ?? null,
    lat: cluster.lat,
    lon: cluster.lon,
    points: cluster.points.length,
    start: first.recordedAt,
  };
}

function lonePoint(point: TrackPoint): LonePoint {
  return {
    address: point.address,
    at: point.recordedAt,
    kind: "point",
    label: point.label,
    lat: point.lat,
    lon: point.lon,
  };
}

function gap(from: TrackPoint | undefined, to: TrackPoint | undefined) {
  return (
    from === undefined ||
    to === undefined ||
    to.recordedAt.getTime() - from.recordedAt.getTime() > tripGapMs
  );
}

/**
 * The history of positions (oldest first) as stays, trips and lone points,
 * oldest first. A trip runs from the last point of the stay before it to the
 * first point of the stay after it, when no silence of half an hour breaks it.
 */
export function readHistory(points: readonly TrackPoint[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  // The points since the last stay; the first is that stay's last point
  // when `fromStay`, which is the stay's, never a lone point.
  let moving: TrackPoint[] = [];
  let fromStay = false;
  let lastTrip: Trip | undefined;
  const flush = (next: TrackPoint | undefined) => {
    const run =
      next === undefined || gap(moving.at(-1), next)
        ? moving
        : [...moving, next];
    const found = trip(run);
    lastTrip = found;
    if (found) items.push(found);
    else {
      for (const point of moving.slice(fromStay ? 1 : 0)) {
        items.push(lonePoint(point));
      }
    }
    moving = [];
    fromStay = false;
  };
  for (const run of clusters(points)) {
    if ("loose" in run) {
      if (moving.length > 0 && gap(moving.at(-1), run.loose)) flush(undefined);
      moving.push(run.loose);
      continue;
    }
    const first = run.stay.points[0];
    if (moving.length > 0) flush(first);
    const drove =
      lastTrip?.mode === "vehicle" &&
      first !== undefined &&
      first.recordedAt.getTime() - lastTrip.end.getTime() <= tripGapMs;
    items.push(stayOf(run.stay, drove));
    lastTrip = undefined;
    const last = run.stay.points.at(-1);
    if (last) {
      moving = [last];
      fromStay = true;
    }
  }
  if (moving.length > 0) flush(undefined);
  return items;
}

/** The latest car trip's stop, unless the person drove on after it. */
export function probableParking(items: readonly HistoryItem[]) {
  for (const item of items.toReversed()) {
    if (item.kind === "trip" && item.mode === "vehicle") return item.parked;
  }
  return null;
}
