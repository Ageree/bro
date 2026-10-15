/**
 * An iMessage location card (`*.loc.vcf`, `text/x-vlocation`): Apple's vCard
 * with a maps.apple.com link. «Отправить мою геопозицию» names the card by a
 * label of the current location («Current Location», «Моя геопозиция»), and
 * only that card is where the person is; a pin or a place they picked keeps
 * its own name and is a place they talk about.
 */

/** A card is a few hundred bytes; anything past this is no location card. */
export const locationCardByteCap = 4 * 1024;

/** How Apple names a card of where the sender is, in the languages Bro sees. */
const currentLocationNames = new Set([
  "current location",
  "my location",
  "моя геопозиция",
  "мое местоположение",
  "моё местоположение",
  "текущая геопозиция",
  "текущее местоположение",
]);

/** Whether an attachment is a location card, by its name or type. */
export function isLocationCard(
  name: string | undefined,
  mediaType: string | undefined
) {
  return (
    name?.toLowerCase().endsWith(".loc.vcf") === true ||
    mediaType === "text/x-vlocation"
  );
}

/** A vCard value with its escapes undone: «\,» is a comma. */
function unescape(value: string) {
  return value.replaceAll(/\\([,;\\:])/gu, "$1").replaceAll(/\\n/giu, " ");
}

/** The value of the first property named `name` (any parameters). */
function property(lines: readonly string[], name: string) {
  const pattern = new RegExp(`^(?:[\\w-]+\\.)?${name}(?:;[^:]*)?:(.*)$`, "iu");
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return unescape(match[1] ?? "").trim();
  }
  return undefined;
}

const number = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const pairPattern = new RegExp(`^${number},\\s*${number}$`, "u");

/** A point as a card gives it, and whether it is where the sender is. */
export interface CardPoint {
  readonly kind: "place" | "position";
  /** The card's own name of a place, or null for the current location. */
  readonly label: string | null;
  readonly lat: number;
  readonly lon: number;
}

/**
 * Reads a location card, or undefined when it is none: not UTF-8 text,
 * larger than a card, or without a maps.apple.com link with a point.
 */
export function readLocationCard(bytes: Uint8Array): CardPoint | undefined {
  if (bytes.byteLength > locationCardByteCap) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  // Folded lines continue with a space or a tab.
  const lines = text.replaceAll(/\r?\n[ \t]/gu, "").split(/\r?\n/u);
  const link = lines
    .map((line) => /:(https?:\/\/maps\.apple\.com\/\S*)$/iu.exec(line)?.[1])
    .find((found) => found !== undefined);
  if (link === undefined) return undefined;
  const url = URL.parse(unescape(link));
  if (url?.hostname.toLowerCase() !== "maps.apple.com") return undefined;
  const raw =
    url.searchParams.get("ll") ??
    url.searchParams.get("coordinate") ??
    url.searchParams.get("q");
  const match = raw === null ? null : pairPattern.exec(raw.trim());
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return undefined;
  }
  const name =
    property(lines, "FN") ??
    property(lines, "N")?.replaceAll(";", " ").trim() ??
    "";
  const current = currentLocationNames.has(name.toLowerCase());
  return {
    kind: current ? "position" : "place",
    label: current || name.length === 0 ? null : name.slice(0, 80),
    lat,
    lon,
  };
}
