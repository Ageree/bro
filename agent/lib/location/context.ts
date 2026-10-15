import {
  latestPosition,
  latestWebShare,
  sharedBefore,
} from "@db/services/location";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { webShareText } from "@shared/location/share";
import { pointAddress } from "./address";
import { sharedLine, whereLine } from "./note";

/**
 * Words of a message about places around the person: «что рядом», «где я»,
 * «сколько идти», food or a taxi «сюда». Only then does a turn get the line
 * of where they last were; a line in every turn would read where they were
 * into turns that are not about it, an injected page's among them.
 */
const placeWordsPattern =
  /(?<!\p{L})(?:рядом|поблизост|недалеко|где я|где мы|отсюда|сюда|до меня|ко мне|сколько (?:идти|ехать|добираться)|такси|доставк|поесть|пообедать|позавтракать|поужинать|перекусить|кофе|кофейн|аптек|банкомат|near|nearby|where am i|around me)/iu;

/** Whether a message speaks of places around the person. */
export function speaksOfPlaces(words: string) {
  return placeWordsPattern.test(words);
}

/** How old a point may be for the line of where the person is. */
const whereFreshMs = 2 * 60 * 60_000;

/**
 * The context line of where the person last was, for a message about places
 * near them that brings no point of its own: their latest position within
 * two hours. Otherwise nothing, and the model asks `location_now` or the
 * person. A failed read is no line.
 */
export async function locationContext(
  scope: AccessScope,
  words: string,
  now = new Date()
): Promise<string[]> {
  if (!speaksOfPlaces(words)) return [];
  try {
    const latest = await latestPosition(scope, { now });
    if (!latest) return [];
    const { point } = latest;
    if (now.getTime() - point.recordedAt.getTime() > whereFreshMs) return [];
    const [timeZone, address] = await Promise.all([
      readWorkspaceTimeZone(scope),
      pointAddress(scope, point),
    ]);
    return [whereLine({ ...point, address }, timeZone)];
  } catch (error) {
    console.warn("[location] context failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return [];
  }
}

/** The button's message reads a point shared this recently. */
const webShareFreshMs = 2 * 60_000;

/**
 * The web chat's context lines: for the message the «поделиться
 * геопозицией» button sends, the point it stored just before, as the
 * person's own shared point (a reminder it fired reports on its own, a
 * minute later); for any other message, where they last were
 * (`locationContext`).
 */
export async function webLocationContext(
  scope: AccessScope,
  words: string,
  now = new Date()
): Promise<string[]> {
  if (words.trim() !== webShareText) return locationContext(scope, words, now);
  try {
    const point = await latestWebShare(
      scope,
      new Date(now.getTime() - webShareFreshMs)
    );
    if (!point) return [];
    const [timeZone, address, before] = await Promise.all([
      readWorkspaceTimeZone(scope),
      pointAddress(scope, point),
      sharedBefore(scope, point.id),
    ]);
    return [
      sharedLine(
        { ...point, address },
        { firstEver: !before, liveSeen: false, timeZone }
      ),
    ];
  } catch (error) {
    console.warn("[location] context failed", {
      name: error instanceof Error ? error.name : "error",
    });
    return [];
  }
}
