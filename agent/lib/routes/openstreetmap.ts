/**
 * Travel time and distance between places, with no API key: OpenStreetMap's
 * Nominatim finds the places and the OSRM servers FOSSGIS runs for
 * openstreetmap.org measure the route on foot, by bike or by car. Both ask
 * for an identifying User-Agent, at most one request per second for the whole
 * application, cached results and the attribution «© OpenStreetMap»
 * (operations.osmfoundation.org/policies/nominatim,
 * routing.openstreetmap.de/about.html). The spacing and the cache here live
 * in one instance, and several instances may run at once (morning digests
 * start together), so each instance keeps to half the allowed rate, a call
 * makes a bounded number of lookups, and a host that says «slow down» is left
 * alone for a while. The car time is free-flow: no live traffic.
 */

import { z } from "zod";
import { applicationOrigin } from "@shared/environment/origin";

export const travelModes = ["walking", "cycling", "driving"] as const;

type TravelMode = (typeof travelModes)[number];

const geocoderUrl = "https://nominatim.openstreetmap.org/search";
const routerOrigin = "https://routing.openstreetmap.de";
/** The FOSSGIS router keeps one OSRM instance per profile. */
const routerProfiles: Readonly<Record<TravelMode, string>> = {
  cycling: "routed-bike",
  driving: "routed-car",
  walking: "routed-foot",
};

/**
 * Both policies allow one request per second for the whole application. One
 * instance keeps to one every two seconds, so two instances at once still
 * stay within it.
 */
const requestSpacingMs = 2000;
/** A 429 or 503 is tried once more after this pause plus up to the jitter. */
const backoffMs = 1500;
const backoffJitterMs = 1500;
/** A longer Retry-After is not waited out inside a turn. */
const longestRetryAfterMs = 5000;
/** A host that refused twice in a row is not asked again for this long. */
const coolDownMs = 2 * 60_000;
const longestCoolDownMs = 20 * 60_000;
/** Geocoder requests one call may make; the rest of its places go unmeasured. */
export const lookupsPerCall = 8;
/** A turn waits on these calls; a slow service is given up on, not waited out. */
const requestTimeoutMs = 8000;
/** A place stays where it is; one that was not found may be added to the map. */
const placeMemoryMs = 24 * 60 * 60_000;
const missingPlaceMemoryMs = 60 * 60_000;
const routeMemoryMs = 6 * 60 * 60_000;
/** Plenty for the conversations one instance serves; the oldest go first. */
const maximumRemembered = 500;
/** How far around the start a destination is looked for first, in degrees. */
const nearbyLatitude = 0.3;
const nearbyLongitude = 0.5;

/** Credit the services' terms ask for wherever their data is shown. */
export const openStreetMapAttribution = "© OpenStreetMap";

/** Countries where people open Yandex Maps rather than Google Maps. */
const yandexCountries: ReadonlySet<string> = new Set([
  "am",
  "by",
  "kg",
  "kz",
  "ru",
  "uz",
]);

/**
 * What the map matched: a building or a named place, a whole street (its
 * point is somewhere along it), an area such as a city or a district (its
 * point is the centre), or coordinates as given.
 */
type PlaceKind = "area" | "place" | "point" | "street";

/** A place found on the map, with the name that says which one it is. */
export interface MapPlace {
  readonly countryCode: string | undefined;
  /** The district it lies in, such as «Юдино, Кировский район». */
  readonly district: string | undefined;
  /** The building the map matched, such as «12 с7», when it has one. */
  readonly houseNumber: string | undefined;
  /** How well known the map takes it to be, 0 to 1. */
  readonly importance: number | undefined;
  readonly kind: PlaceKind;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  /** The place's own name, such as «Городская поликлиника № 2». */
  readonly name: string | undefined;
  /** What it is on the map, as an OSM tag: «railway:station», «amenity:cafe». */
  readonly tag: string | undefined;
}

/** Geocoder requests one call may still make; shared by all its places. */
export interface LookupBudget {
  remaining: number;
}

/** One route: the distance on roads or paths and the time it takes. */
interface MeasuredRoute {
  readonly km: number;
  readonly minutes: number;
}

/**
 * How a map request failed: the service refusing or out of reach (it asked
 * to slow down or is left alone after that, forbade access, timed out or
 * could not be reached), so the next request fails too; any other failure —
 * a 5xx, an answer that cannot be read, a route the router cannot measure —
 * which may or may not be one-off; or a call that used up its lookups, while
 * the service itself works.
 */
type MapFailure = "budget" | "failed" | "refusing";

/** A map service that did not answer or refused; the model hears the reason. */
export class MapServiceError extends Error {
  readonly failure: MapFailure;

  constructor(message: string, failure: MapFailure) {
    super(message);
    this.name = "MapServiceError";
    this.failure = failure;
  }
}

const nominatimResultsSchema = z.array(
  z.object({
    address: z
      .object({
        city: z.string().optional(),
        city_district: z.string().optional(),
        country_code: z.string().optional(),
        house_number: z.string().optional(),
        road: z.string().optional(),
        state: z.string().optional(),
        suburb: z.string().optional(),
        town: z.string().optional(),
        village: z.string().optional(),
      })
      .optional(),
    addresstype: z.string().optional(),
    category: z.string().optional(),
    display_name: z.string(),
    importance: z.coerce.number().optional(),
    lat: z.coerce.number(),
    lon: z.coerce.number(),
    name: z.string().optional(),
    place_rank: z.coerce.number().optional(),
    type: z.string().optional(),
  })
);

type NominatimResult = z.infer<typeof nominatimResultsSchema>[number];

/**
 * Nominatim's `addresstype` for areas; a `place_rank` below 26 says the same
 * (4 a country, 16 a city, 20 a neighbourhood, 25 a postcode), 26–27 is a
 * street and 30 a building or a named place.
 */
const areaTypes: ReadonlySet<string> = new Set([
  "borough",
  "city",
  "city_block",
  "city_district",
  "country",
  "county",
  "district",
  "hamlet",
  "municipality",
  "neighbourhood",
  "postcode",
  "province",
  "quarter",
  "region",
  "state",
  "suburb",
  "town",
  "village",
]);

function placeKind(result: NominatimResult): PlaceKind {
  const rank = result.place_rank;
  if (result.addresstype === "road" || rank === 26 || rank === 27) {
    return "street";
  }
  if (
    (rank !== undefined && rank < 26) ||
    areaTypes.has(result.addresstype ?? "")
  ) {
    return "area";
  }
  return "place";
}

const tableSchema = z.object({
  code: z.string(),
  distances: z.array(z.array(z.number().nullable())).optional(),
  durations: z.array(z.array(z.number().nullable())).optional(),
  message: z.string().optional(),
});

const nextRequestAt = new Map<string, number>();
/** Hosts that asked to slow down, until when. */
const coolingUntil = new Map<string, number>();
const rememberedPlaces = new Map<
  string,
  { readonly places: readonly MapPlace[]; readonly until: number }
>();
const rememberedRoutes = new Map<
  string,
  { readonly route: MeasuredRoute | undefined; readonly until: number }
>();

/** Names the application and where to reach whoever runs it. */
function userAgent() {
  try {
    return `Bro/1.0 (personal assistant, route times; contact: ${applicationOrigin()})`;
  } catch {
    return "Bro/1.0 (personal assistant, route times)";
  }
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Aborted.")
      );
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Aborted.")
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Waits until this host may be asked again. The slot is taken before the
 * wait, so calls made at once line up two seconds apart instead of all going.
 */
async function waitForTurn(host: string, signal: AbortSignal) {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt.get(host) ?? 0);
  nextRequestAt.set(host, at + requestSpacingMs);
  if (at > now) await pause(at - now, signal);
}

/** A remembered entry while it is fresh. */
function recall<T>(
  memory: Map<string, { readonly until: number } & T>,
  key: string
) {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (Date.now() < entry.until) return entry;
  memory.delete(key);
  return undefined;
}

function remember<T>(
  memory: Map<string, { readonly until: number } & T>,
  key: string,
  entry: { readonly until: number } & T
) {
  memory.delete(key);
  memory.set(key, entry);
  // A Map iterates in insertion order, so the first keys are the oldest.
  for (const oldest of memory.keys()) {
    if (memory.size <= maximumRemembered) break;
    memory.delete(oldest);
  }
}

/** The Retry-After a host sent, in milliseconds, when it sent one. */
function retryAfterMs(response: Response) {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function slowDown(status: number) {
  return status === 429 || status === 503;
}

async function fetchOnce(url: URL, service: string, signal: AbortSignal) {
  await waitForTurn(url.host, signal);
  try {
    return await fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent() },
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MapServiceError(
      error instanceof Error && error.name === "TimeoutError"
        ? `${service} did not answer in time`
        : `${service} could not be reached`,
      "refusing"
    );
  }
}

/**
 * One GET to a map service, parsed with `schema`. A 429 or 503 is tried once
 * more after a jittered pause, or after the host's own Retry-After when it is
 * short; a second refusal or a long Retry-After leaves the host alone for a
 * while. OSRM explains a route it cannot measure in a 400 body, so that body
 * is read like any other.
 */
async function request<Schema extends z.ZodType>(
  url: URL,
  service: string,
  schema: Schema,
  signal: AbortSignal
): Promise<z.infer<Schema>> {
  if (Date.now() < (coolingUntil.get(url.host) ?? 0)) {
    throw new MapServiceError(
      `${service} asked to slow down a few minutes ago and is not asked again yet`,
      "refusing"
    );
  }
  let response = await fetchOnce(url, service, signal);
  if (slowDown(response.status)) {
    const asked = retryAfterMs(response);
    if (asked === undefined || asked <= longestRetryAfterMs) {
      await pause(asked ?? backoffMs + Math.random() * backoffJitterMs, signal);
      response = await fetchOnce(url, service, signal);
    }
    if (slowDown(response.status)) {
      const wait = Math.min(
        Math.max(coolDownMs, asked ?? 0),
        longestCoolDownMs
      );
      coolingUntil.set(url.host, Date.now() + wait);
    }
  }
  const text = await response.text();
  if (!response.ok && response.status !== 400) {
    throw new MapServiceError(
      `${service} answered HTTP ${String(response.status)}`,
      slowDown(response.status) || response.status === 403
        ? "refusing"
        : "failed"
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MapServiceError(`${service} sent an unreadable answer`, "failed");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new MapServiceError(`${service} sent an unexpected answer`, "failed");
  }
  return parsed.data;
}

/** «55.7648, 37.6380» as a place, without asking anyone. */
function coordinates(text: string): MapPlace | undefined {
  const match =
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/u.exec(text);
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return {
    countryCode: undefined,
    district: undefined,
    houseNumber: undefined,
    importance: undefined,
    kind: "point",
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    lat,
    lon,
    name: undefined,
    tag: undefined,
  };
}

/** «Metropol, Театральный проезд 2, Москва»: enough to tell which place it is. */
function placeLabel(result: NominatimResult) {
  const address = result.address;
  if (!address) return result.display_name.split(", ").slice(0, 4).join(", ");
  const street = [address.road, address.house_number]
    .filter((part) => part !== undefined)
    .join(" ");
  const settlement =
    address.city ?? address.town ?? address.village ?? address.state;
  const parts = [result.name, street, settlement].filter(
    (part): part is string => part !== undefined && part.length > 0
  );
  return [...new Set(parts)].join(", ") || result.display_name;
}

/** «Юдино, Кировский район»: where in the city a place lies. */
function districtOf(result: NominatimResult) {
  const parts = [result.address?.suburb, result.address?.city_district].filter(
    (part): part is string => part !== undefined && part.length > 0
  );
  return parts.length > 0 ? [...new Set(parts)].join(", ") : undefined;
}

function mapPlace(result: NominatimResult): MapPlace {
  return {
    countryCode: result.address?.country_code?.toLowerCase(),
    district: districtOf(result),
    houseNumber: result.address?.house_number,
    importance: result.importance,
    kind: placeKind(result),
    label: placeLabel(result),
    lat: result.lat,
    lon: result.lon,
    name: result.name === "" ? undefined : result.name,
    tag:
      result.category && result.type
        ? `${result.category}:${result.type}`
        : undefined,
  };
}

/** OSM tags whose own words would mislead: «aeroway:aerodrome» is an airport. */
const tagNames: ReadonlyMap<string, string> = new Map([
  ["aeroway:aerodrome", "airport"],
  ["aeroway:terminal", "airport terminal"],
  ["amenity:bus_station", "bus station"],
  ["amenity:ferry_terminal", "ferry terminal"],
  ["building:train_station", "railway station building"],
  ["highway:bus_stop", "bus stop"],
  ["public_transport:platform", "public transport stop"],
  ["public_transport:stop_position", "public transport stop"],
  ["railway:halt", "railway halt"],
  ["railway:platform", "railway platform"],
  ["railway:station", "railway station"],
  ["railway:stop", "railway stop"],
  ["railway:subway_entrance", "metro entrance"],
  ["railway:tram_stop", "tram stop"],
]);

/** What the place is, in words: «railway station», «cafe», «building». */
export function placeType(place: MapPlace) {
  if (place.tag === undefined) return undefined;
  const known = tagNames.get(place.tag);
  if (known !== undefined) return known;
  const [category = "", type = ""] = place.tag.split(":");
  return type === "yes" || type.length === 0
    ? category
    : type.replaceAll("_", " ");
}

/**
 * Finds places by address, name or «lat, lon», best first as the map ranks
 * them, at most `limit`. With `near`, a place around it ranks first, so
 * «Кафе Пушкинъ» is looked for in the start's city before the rest of the
 * world. An empty list means the map has no such place. A lookup that has
 * to go to the geocoder spends one of `budget`.
 */
export async function findPlaces(
  query: string,
  near: MapPlace | undefined,
  budget: LookupBudget,
  signal: AbortSignal,
  limit = 1
): Promise<readonly MapPlace[]> {
  const given = coordinates(query);
  if (given) return [given];
  const text = query.trim().replaceAll(/\s+/gu, " ");
  const url = new URL(geocoderUrl);
  url.searchParams.set("q", text);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("addressdetails", "1");
  // Names come back in the language the place was asked in, so an English
  // reply is not handed «Таймс-сквер».
  url.searchParams.set(
    "accept-language",
    /\p{Script=Cyrillic}/u.test(text) ? "ru,en" : "en,ru"
  );
  if (near) {
    url.searchParams.set(
      "viewbox",
      [
        near.lon - nearbyLongitude,
        near.lat + nearbyLatitude,
        near.lon + nearbyLongitude,
        near.lat - nearbyLatitude,
      ]
        .map((value) => value.toFixed(1))
        .join(",")
    );
  }
  const key = url.search.toLowerCase();
  const known = recall(rememberedPlaces, key);
  if (known) return known.places;
  if (budget.remaining <= 0) {
    throw new MapServiceError(
      `This call already made ${String(lookupsPerCall)} map lookups; measure the rest in another call`,
      "budget"
    );
  }
  budget.remaining -= 1;

  const results = await request(
    url,
    "The OpenStreetMap geocoder",
    nominatimResultsSchema,
    signal
  );
  const places = results.slice(0, limit).map(mapPlace);
  remember(rememberedPlaces, key, {
    places,
    until:
      Date.now() + (places.length > 0 ? placeMemoryMs : missingPlaceMemoryMs),
  });
  return places;
}

function routePoint(place: MapPlace) {
  return `${place.lat.toFixed(5)},${place.lon.toFixed(5)}`;
}

function routeKey(mode: TravelMode, from: MapPlace, to: MapPlace) {
  return `${mode} ${routePoint(from)} ${routePoint(to)}`;
}

/** OSRM reads coordinates as longitude first. */
function osrmPoint(place: MapPlace) {
  return `${place.lon.toFixed(6)},${place.lat.toFixed(6)}`;
}

/**
 * Distance and time from one start to each destination along OpenStreetMap
 * roads or paths, in one request for all that are not remembered yet. A
 * destination the router cannot reach (an island, no path) comes back
 * `undefined`.
 */
export async function measureRoutes(
  mode: TravelMode,
  from: MapPlace,
  destinations: readonly MapPlace[],
  signal: AbortSignal
) {
  const routes = destinations.map((to) =>
    recall(rememberedRoutes, routeKey(mode, from, to))
  );
  const missing = destinations.filter((_to, index) => !routes[index]);
  if (missing.length > 0) {
    const url = new URL(
      `${routerOrigin}/${routerProfiles[mode]}/table/v1/driving/${[from, ...missing].map(osrmPoint).join(";")}`
    );
    url.searchParams.set("sources", "0");
    url.searchParams.set(
      "destinations",
      missing.map((_to, index) => String(index + 1)).join(";")
    );
    url.searchParams.set("annotations", "duration,distance");
    const table = await request(
      url,
      "The OpenStreetMap router",
      tableSchema,
      signal
    );
    if (table.code !== "Ok") {
      throw new MapServiceError(
        `The OpenStreetMap router could not measure the route: ${table.message ?? table.code}`,
        "failed"
      );
    }
    const durations = table.durations?.[0] ?? [];
    const distances = table.distances?.[0] ?? [];
    for (const [index, to] of missing.entries()) {
      const seconds = durations[index];
      const meters = distances[index];
      const route =
        seconds === null ||
        seconds === undefined ||
        meters === null ||
        meters === undefined
          ? undefined
          : {
              km: Math.round(meters / 100) / 10,
              minutes: Math.max(1, Math.round(seconds / 60)),
            };
      remember(rememberedRoutes, routeKey(mode, from, to), {
        route,
        until: Date.now() + routeMemoryMs,
      });
    }
  }
  return destinations.map(
    (to) => recall(rememberedRoutes, routeKey(mode, from, to))?.route
  );
}

function radians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/** Straight-line distance in kilometres, for when the router is down. */
export function straightKm(from: MapPlace, to: MapPlace) {
  const dLat = radians(to.lat - from.lat);
  const dLon = radians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) *
      Math.cos(radians(to.lat)) *
      Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(a));
  return Math.round(km * 10) / 10;
}

/**
 * The route on the maps the person uses: Yandex Maps where it is the usual
 * map, Google Maps elsewhere. Both show the car route with live traffic.
 */
export function routeLink(mode: TravelMode, from: MapPlace, to: MapPlace) {
  if (yandexCountries.has(from.countryCode ?? to.countryCode ?? "")) {
    const type = { cycling: "bc", driving: "auto", walking: "pd" }[mode];
    return `https://yandex.ru/maps/?rtext=${from.lat.toFixed(6)},${from.lon.toFixed(6)}~${to.lat.toFixed(6)},${to.lon.toFixed(6)}&rtt=${type}`;
  }
  const type = { cycling: "bicycling", driving: "driving", walking: "walking" }[
    mode
  ];
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat.toFixed(6)},${from.lon.toFixed(6)}&destination=${to.lat.toFixed(6)},${to.lon.toFixed(6)}&travelmode=${type}`;
}
