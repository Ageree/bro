import type { locationPoints } from "@db";
import { cachedAddressNear, setPointAddress } from "@db/services/location";
import { reverseGeocode } from "@agent/lib/routes/openstreetmap";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * The address of a shared point. A channel's `onMessage` never waits on the
 * map: it takes the point's own address or one of the person's points
 * within 30 m, and otherwise leaves the lookup to the background, which asks
 * only when the map can be asked at once (`wait: false`), so a turn never
 * queues behind `route_time`. `location_now` may wait for one lookup.
 */

type StoredPoint = Pick<
  typeof locationPoints.$inferSelect,
  "address" | "id" | "lat" | "lon"
>;

const lookupTimeoutMs = 3_000;

/** The point's own address or a nearby point's, without any request. */
async function knownAddress(scope: AccessScope, point: StoredPoint) {
  if (point.address !== null) return point.address;
  const cached = await cachedAddressNear(scope, point.lat, point.lon);
  if (cached === undefined) return null;
  await setPointAddress(point.id, cached);
  return cached;
}

/** The address without any request, or null; a lookup may follow later. */
export async function pointAddress(scope: AccessScope, point: StoredPoint) {
  const known = await knownAddress(scope, point);
  if (known === null) void fillAddressLater(point);
  return known;
}

async function fillAddressLater(point: StoredPoint) {
  try {
    const address = await reverseGeocode(
      point.lat,
      point.lon,
      AbortSignal.timeout(lookupTimeoutMs * 3),
      { wait: false }
    );
    console.info("[location] reverse", {
      found: address !== undefined,
      waited: false,
    });
    if (address !== undefined) await setPointAddress(point.id, address);
  } catch (error) {
    console.warn("[location] reverse failed", {
      name: error instanceof Error ? error.name : "error",
    });
  }
}

/**
 * The address for a tool's answer: the stored or a nearby one, else one
 * lookup that may wait its turn (at most 3 s), written to the point.
 */
export async function pointAddressNow(scope: AccessScope, point: StoredPoint) {
  const known = await knownAddress(scope, point);
  if (known !== null) return known;
  try {
    const address = await reverseGeocode(
      point.lat,
      point.lon,
      AbortSignal.timeout(lookupTimeoutMs)
    );
    console.info("[location] reverse", {
      found: address !== undefined,
      waited: true,
    });
    if (address === undefined) return null;
    await setPointAddress(point.id, address);
    return address;
  } catch (error) {
    console.warn("[location] reverse failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return null;
  }
}
