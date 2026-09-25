/**
 * Travel time and distance between places, with no API key: OpenStreetMap's
 * Nominatim finds the places and the OSRM servers FOSSGIS runs for
 * openstreetmap.org measure the route on foot, by bike or by car. Both ask
 * for an identifying User-Agent, at most one request per second and cached
 * results (operations.osmfoundation.org/policies/nominatim,
 * routing.openstreetmap.de/about.html), so every request here waits its turn
 * per host and a place or a route already measured is answered from memory.
 * The car time is free-flow: no live traffic.
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

/** Both policies allow one request per second at most; a little over is safe. */
const requestSpacingMs = 1100;
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

/** Countries where people open Yandex Maps rather than Google Maps. */
const yandexCountries: ReadonlySet<string> = new Set([
  "am",
  "by",
  "kg",
  "kz",
  "ru",
  "uz",
]);

/** A place found on the map, with the name that says which one it is. */
export interface MapPlace {
  readonly countryCode: string | undefined;
  /** The building the map matched, such as «12 с7», when it has one. */
  readonly houseNumber: string | undefined;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
}

/** One route: the distance on roads or paths and the time it takes. */
interface MeasuredRoute {
  readonly km: number;
  readonly minutes: number;
}

/** A map service that did not answer or refused; the model hears the reason. */
export class MapServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapServiceError";
  }
}

const nominatimResultsSchema = z.array(
  z.object({
    address: z
      .object({
        city: z.string().optional(),
        country_code: z.string().optional(),
        house_number: z.string().optional(),
        road: z.string().optional(),
        state: z.string().optional(),
        town: z.string().optional(),
        village: z.string().optional(),
      })
      .optional(),
    display_name: z.string(),
    lat: z.coerce.number(),
    lon: z.coerce.number(),
    name: z.string().optional(),
  })
);

const tableSchema = z.object({
  code: z.string(),
  distances: z.array(z.array(z.number().nullable())).optional(),
  durations: z.array(z.array(z.number().nullable())).optional(),
  message: z.string().optional(),
});

const nextRequestAt = new Map<string, number>();
const rememberedPlaces = new Map<
  string,
  { readonly place: MapPlace | undefined; readonly until: number }
>();
const rememberedRoutes = new Map<
  string,
  { readonly route: MeasuredRoute | undefined; readonly until: number }
>();

function userAgent() {
  try {
    return `Bro/1.0 (personal assistant; +${applicationOrigin()})`;
  } catch {
    return "Bro/1.0 (personal assistant)";
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
 * wait, so calls made at once line up a second apart instead of all going.
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

/**
 * One GET to a map service, parsed with `schema`. OSRM explains a route it
 * cannot measure in a 400 body, so that body is read like any other.
 */
async function request<Schema extends z.ZodType>(
  url: URL,
  service: string,
  schema: Schema,
  signal: AbortSignal
): Promise<z.infer<Schema>> {
  await waitForTurn(url.host, signal);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent() },
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MapServiceError(
      error instanceof Error && error.name === "TimeoutError"
        ? `${service} did not answer in time`
        : `${service} could not be reached`
    );
  }
  const text = await response.text();
  if (!response.ok && response.status !== 400) {
    throw new MapServiceError(
      `${service} answered HTTP ${String(response.status)}`
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MapServiceError(`${service} sent an unreadable answer`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new MapServiceError(`${service} sent an unexpected answer`);
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
    houseNumber: undefined,
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    lat,
    lon,
  };
}

/** «Metropol, Театральный проезд 2, Москва»: enough to tell which place it is. */
function placeLabel(result: z.infer<typeof nominatimResultsSchema>[number]) {
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

/**
 * Finds one place by address, name or «lat, lon». With `near`, a place
 * around it ranks first, so «Кафе Пушкинъ» is looked for in the start's city
 * before the rest of the world. `undefined` means the map has no such place.
 */
export async function findPlace(
  query: string,
  near: MapPlace | undefined,
  signal: AbortSignal
) {
  const given = coordinates(query);
  if (given) return given;
  const text = query.trim().replaceAll(/\s+/gu, " ");
  const url = new URL(geocoderUrl);
  url.searchParams.set("q", text);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "ru,en");
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
  if (known) return known.place;

  const [result] = await request(
    url,
    "The OpenStreetMap geocoder",
    nominatimResultsSchema,
    signal
  );
  const place: MapPlace | undefined = result && {
    countryCode: result.address?.country_code?.toLowerCase(),
    houseNumber: result.address?.house_number,
    label: placeLabel(result),
    lat: result.lat,
    lon: result.lon,
  };
  remember(rememberedPlaces, key, {
    place,
    until: Date.now() + (place ? placeMemoryMs : missingPlaceMemoryMs),
  });
  return place;
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
        `The OpenStreetMap router could not measure the route: ${table.message ?? table.code}`
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
