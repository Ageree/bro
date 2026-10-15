import { latestPosition } from "@db/services/location";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { distanceM } from "@shared/location/geometry";
import { localStamp } from "./note";

/**
 * Where a «рядом» search on Yandex Maps looks (`maps.search`, whose `near` is
 * [longitude, latitude] and defaults to central Moscow): the person's own
 * point within two hours when the model gave none, and the model's pair
 * turned round when it gave latitude first and that lands next to the
 * point. Undefined when the search keeps what it was given.
 */

/** `maps.search`'s own default: eve parses it in before the tool runs. */
const defaultNear = [37.6177, 55.755863] as const;
const freshMs = 2 * 60 * 60_000;
const swappedWithinM = 2_000;

export async function nearFromPosition(
  scope: AccessScope,
  near: readonly [number, number] | undefined,
  now = new Date()
) {
  const latest = await latestPosition(scope, { now });
  if (
    latest?.point.kind !== "position" ||
    now.getTime() - latest.point.recordedAt.getTime() > freshMs
  ) {
    return undefined;
  }
  const { point } = latest;
  const timeZone = await readWorkspaceTimeZone(scope);
  const stamp = localStamp(point.recordedAt, timeZone);
  if (
    near === undefined ||
    (near[0] === defaultNear[0] && near[1] === defaultNear[1])
  ) {
    const around: [number, number] = [point.lon, point.lat];
    return { near: around, said: `the person's shared location of ${stamp}` };
  }
  const given = distanceM({ lat: near[1], lon: near[0] }, point);
  const turned = distanceM({ lat: near[0], lon: near[1] }, point);
  if (given > swappedWithinM && turned <= swappedWithinM) {
    const turnedRound: [number, number] = [near[1], near[0]];
    return {
      near: turnedRound,
      said: "near turned round to [longitude, latitude]",
    };
  }
  return undefined;
}
