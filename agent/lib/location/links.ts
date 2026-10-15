/**
 * Points in map links the person wrote: Apple Maps, Google Maps, Yandex
 * Maps, 2GIS, OpenStreetMap and `geo:` URIs, read from the link alone,
 * without a request. A short link (maps.app.goo.gl, yandex.ru/maps/-/…)
 * carries no point and gives none. `place_reminder` reads these from the
 * person's own words only; a link is never stored as where they are.
 */

interface MapPoint {
  readonly label?: string;
  readonly lat: number;
  readonly lon: number;
}

const maximumPoints = 3;
const number = String.raw`-?\d{1,3}(?:\.\d+)?`;
const pairPattern = new RegExp(`^\\s*(${number})\\s*,\\s*(${number})`, "u");

function valid(lat: number, lon: number) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** «55.75,37.61» in that order, or undefined. */
function pair(value: string | null, order: "latlon" | "lonlat") {
  if (value === null) return undefined;
  const match = pairPattern.exec(value);
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const [lat, lon] = order === "latlon" ? [first, second] : [second, first];
  return valid(lat, lon) ? { lat, lon } : undefined;
}

function hostIs(host: string, domains: readonly string[]) {
  const bare = host.toLowerCase().replace(/^www\./u, "");
  return domains.some(
    (domain) => bare === domain || bare.endsWith(`.${domain}`)
  );
}

function label(value: string | null) {
  const plain = value?.trim();
  if (plain === undefined || plain.length === 0) return undefined;
  if (pairPattern.test(plain)) return undefined;
  return plain.slice(0, 80);
}

function applePoint(url: URL) {
  const query = url.searchParams;
  const point =
    pair(query.get("coordinate"), "latlon") ??
    pair(query.get("ll"), "latlon") ??
    pair(query.get("q"), "latlon") ??
    pair(query.get("sll"), "latlon") ??
    pair(query.get("daddr"), "latlon");
  if (!point) return undefined;
  const name = label(query.get("name")) ?? label(query.get("q"));
  return name === undefined ? point : { ...point, label: name };
}

function googlePoint(url: URL) {
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/u.exec(url.href);
  if (pin) {
    const lat = Number(pin[1]);
    const lon = Number(pin[2]);
    if (valid(lat, lon)) return { lat, lon };
  }
  const query = url.searchParams;
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/u.exec(url.pathname);
  return (
    pair(query.get("q"), "latlon") ??
    pair(query.get("query"), "latlon") ??
    pair(query.get("ll"), "latlon") ??
    (at ? pair(`${at[1] ?? ""},${at[2] ?? ""}`, "latlon") : undefined)
  );
}

function yandexPoint(url: URL) {
  const query = url.searchParams;
  return (
    pair(query.get("pt"), "lonlat") ??
    pair(query.get("whatshere[point]"), "lonlat") ??
    pair(query.get("rtext")?.split("~").at(-1) ?? null, "latlon") ??
    pair(query.get("ll"), "lonlat")
  );
}

function twoGisPoint(url: URL) {
  const inPath = /\/geo\/[^/]+\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/u.exec(
    url.pathname
  );
  if (inPath) return pair(`${inPath[1] ?? ""},${inPath[2] ?? ""}`, "lonlat");
  return pair(url.searchParams.get("m"), "lonlat");
}

function osmPoint(url: URL) {
  const lat = url.searchParams.get("mlat");
  const lon = url.searchParams.get("mlon");
  if (lat !== null && lon !== null) {
    return pair(`${lat},${lon}`, "latlon");
  }
  const map = /map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/u.exec(
    url.hash
  );
  return map ? pair(`${map[1] ?? ""},${map[2] ?? ""}`, "latlon") : undefined;
}

/** The point of one map link, or undefined for any other link. */
function linkPoint(url: URL): MapPoint | undefined {
  if (url.protocol === "geo:") {
    return pair(url.pathname, "latlon");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname;
  if (hostIs(host, ["maps.apple.com"])) return applePoint(url);
  if (
    hostIs(host, ["maps.google.com"]) ||
    (hostIs(host, ["google.com", "google.ru"]) &&
      url.pathname.startsWith("/maps"))
  ) {
    return googlePoint(url);
  }
  if (
    hostIs(host, [
      "yandex.ru",
      "yandex.com",
      "yandex.kz",
      "yandex.by",
      "yandex.uz",
    ]) &&
    url.pathname.includes("/maps")
  ) {
    return yandexPoint(url);
  }
  if (hostIs(host, ["2gis.ru", "2gis.kz", "2gis.com"])) return twoGisPoint(url);
  if (hostIs(host, ["openstreetmap.org", "osm.org"])) return osmPoint(url);
  return undefined;
}

/** The map points in a text, as its links give them, at most three. */
export function mapPointsIn(text: string): readonly MapPoint[] {
  const points: MapPoint[] = [];
  const links = text.matchAll(/(?:https?:\/\/|geo:)[^\s<>"'«»]+/giu);
  for (const match of links) {
    if (points.length >= maximumPoints) break;
    const url = URL.parse(match[0].replace(/[).,;!]+$/u, ""));
    if (!url) continue;
    const point = linkPoint(url);
    if (point) points.push(point);
  }
  return points;
}
