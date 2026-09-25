import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import {
  findPlace,
  type MapPlace,
  MapServiceError,
  measureRoutes,
  routeLink,
  straightKm,
  travelModes,
} from "@agent/lib/routes/openstreetmap";

const placeSchema = z.string().trim().min(2).max(200);

/** What each result is measured on, so the reply says it honestly. */
const basisByMode = {
  cycling:
    "Cycling along OpenStreetMap roads and paths at an even pace, without stops.",
  driving:
    "Free-flow driving on OpenStreetMap roads, without live traffic: at rush hour in a big city the real drive often takes much longer. Say the time is without traffic jams and give the link, which shows the live time.",
  walking: "Walking along OpenStreetMap streets and paths at about 4.5 km/h.",
} as const;

const inputSchema = z.object({
  from: placeSchema.describe(
    "The start: a street address or a named place with its city («отель Метрополь, Москва», «метро Чистые пруды, Москва», «Tverskaya 7, Moscow»), or «lat, lon». Only places and addresses, never a person's name or phone."
  ),
  mode: z
    .enum(travelModes)
    .describe(
      "walking for «пешком» and «walking distance», cycling for a bike or a scooter, driving for a car or a taxi."
    ),
  to: z
    .array(placeSchema)
    .min(1)
    .max(5)
    .describe(
      "Destinations in the same form as from, each with its street or city; up to five are measured from the same start in one call."
    ),
});

/**
 * Words the geocoder reads as part of a name: «отель Метрополь, Москва» is
 * not on the map (live probe 25.09), «Метрополь, Москва» is.
 */
const kindOfPlace =
  /^(?:(?:отель|гостиница|хостел|ресторан|кафе|кофейня|бар|паб|бистро|пиццерия|столовая|станция|метро|м\.|hotel|hostel|restaurant|cafe|café|coffee shop|bar|pub|bistro|station|metro|subway|the)\s+)+/iu;

/**
 * «12 корп. 2», «11 стр 1», «д. 5» as OpenStreetMap writes Russian houses:
 * «12 к2», «11 с1», «5». The eval on 25.09 asked for «Чистопрудный бульвар
 * 12 корп 2», which the map does not know, while «12 к2» it does.
 */
function withHouseShorthand(query: string) {
  return query
    .replaceAll(/(\d+)\s*(?:корпус|корп\.?|к\.?)\s*(\d+)/giu, "$1 к$2")
    .replaceAll(/(\d+)\s*(?:строение|стр\.?|с\.?)\s*(\d+)/giu, "$1 с$2")
    .replaceAll(/(?<!\p{L})(?:дом|д\.)\s*(?=\d)/giu, "");
}

/**
 * House numbers a query names. «1-я Тверская-Ямская» is a street's name,
 * not a house.
 */
function askedNumbers(query: string): readonly string[] {
  return query.match(/(?<!\p{L})\d+(?![-‐]\p{L})/gu) ?? [];
}

/** The map found the street but not the house the query names. */
function missesHouse(query: string, place: MapPlace) {
  return place.streetOnly && askedNumbers(query).length > 0;
}

/**
 * What to ask the geocoder, best first: the query as given, then the
 * address alone when a name comes before it («Кафе Авокадо, Чистопрудный
 * бульвар 12к2, Москва» is found only so), then the name without the kind of
 * place and quotes. Each miss costs a second of the turn.
 */
function queryVariants(query: string) {
  const parts = withHouseShorthand(query)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const [name = "", ...address] = parts;
  const bareName = name
    .replace(kindOfPlace, "")
    .replaceAll(/[«»"“”„]/gu, "")
    .trim();
  const variants = [parts.join(", ")];
  // «Улица, 12 к2, Москва» is no name before an address: «12 к2, Москва»
  // alone would find any such house in the city.
  if (address.length >= 2 && /\p{L}{3}/u.test(address[0] ?? "")) {
    variants.push(address.join(", "));
  }
  if (bareName.length > 0) variants.push([bareName, ...address].join(", "));
  return [...new Set(variants)];
}

/**
 * Finds a place by the first variant of the query the map knows. A match on
 * the street alone is kept only when no variant finds the house: in the
 * eval «Большая Никольская 12 стр 2» came back as the street, 18 minutes
 * away instead of 8.
 */
async function locate(
  query: string,
  near: MapPlace | undefined,
  signal: AbortSignal
) {
  let streetMatch: MapPlace | undefined;
  /* oxlint-disable eslint/no-await-in-loop -- Each variant is asked only when the one before found nothing, a second apart. */
  for (const variant of queryVariants(query)) {
    const place = await findPlace(variant, near, signal);
    if (place && !missesHouse(query, place)) return place;
    streetMatch ??= place;
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return streetMatch;
}

/**
 * Whether the map matched another building of the street: «Тверская улица
 * 7» came back as «Тверская улица 12 с7» in the live probe. The route is
 * then measured to that building, and the reply must not pass it off as the
 * address asked for.
 */
function otherBuilding(query: string, place: MapPlace) {
  const matched = /^\d+/u.exec(place.houseNumber ?? "")?.[0];
  if (matched === undefined) return false;
  const asked = askedNumbers(query);
  return asked.length > 0 && !asked.includes(matched);
}

function streetOnlyNote(place: MapPlace) {
  return `the map knows only the street «${place.label}», not this house, and a time to some point of the street would be wrong: call again with the place's name and city, or «lat, lon»`;
}

function buildingWarning(query: string, place: MapPlace) {
  return otherBuilding(query, place)
    ? `the map matched «${place.label}», not the building asked for: say the time is to that building, or ask for a nearby landmark`
    : undefined;
}

async function measure(
  input: z.infer<typeof inputSchema>,
  signal: AbortSignal
) {
  const basis = basisByMode[input.mode];
  const source = "© OpenStreetMap contributors";
  let from: MapPlace | undefined;
  try {
    from = await locate(input.from, undefined, signal);
  } catch (error) {
    if (!(error instanceof MapServiceError)) throw error;
    return {
      note: `${error.message}. Say you could not measure the route right now; do not guess a time.`,
      status: "unavailable" as const,
    };
  }
  if (!from) {
    return {
      note: `The start «${input.from}» is not on the map. Call again with its street and city, or ask the person where exactly they start from.`,
      status: "not_found" as const,
    };
  }
  if (missesHouse(input.from, from)) {
    return {
      note: `For the start, ${streetOnlyNote(from)}.`,
      status: "not_found" as const,
    };
  }

  const places: {
    readonly failure?: string;
    readonly place: MapPlace | undefined;
    readonly query: string;
  }[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- One at a time on purpose: the geocoder allows one request a second. */
  for (const query of input.to) {
    try {
      places.push({ place: await locate(query, from, signal), query });
    } catch (error) {
      if (!(error instanceof MapServiceError)) throw error;
      places.push({ failure: error.message, place: undefined, query });
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  const found = places.flatMap((entry) =>
    entry.place && !missesHouse(entry.query, entry.place) ? [entry.place] : []
  );

  let measured: Awaited<ReturnType<typeof measureRoutes>> = [];
  let routerFailure: string | undefined;
  try {
    measured = await measureRoutes(input.mode, from, found, signal);
  } catch (error) {
    if (!(error instanceof MapServiceError)) throw error;
    routerFailure = error.message;
  }

  let foundIndex = 0;
  const routes = places.map((entry) => {
    const place = entry.place;
    if (!place) {
      return {
        error:
          entry.failure === undefined
            ? "not on the map: add the street and city, or pass «lat, lon»"
            : `${entry.failure}; this destination was not measured`,
        to: entry.query,
      };
    }
    if (missesHouse(entry.query, place)) {
      return { error: streetOnlyNote(place), to: entry.query };
    }
    const route = measured[foundIndex];
    foundIndex += 1;
    const link = routeLink(input.mode, from, place);
    if (routerFailure !== undefined) {
      return {
        error: `${routerFailure}: only the straight-line distance is known, so state no travel time`,
        link,
        place: place.label,
        straightKm: straightKm(from, place),
        to: entry.query,
      };
    }
    if (!route) {
      return {
        error: "no route between these places on the map",
        link,
        place: place.label,
        straightKm: straightKm(from, place),
        to: entry.query,
      };
    }
    return {
      km: route.km,
      link,
      minutes: route.minutes,
      place: place.label,
      to: entry.query,
      warning: buildingWarning(entry.query, place),
    };
  });

  return {
    basis,
    from: from.label,
    fromWarning: buildingWarning(input.from, from),
    mode: input.mode,
    routes,
    source,
    status: "ok" as const,
  };
}

export const routeTime = defineTool({
  description:
    "Measure how long it takes to walk, cycle or drive between places, and how far it is, on OpenStreetMap with no key: «пешком от отеля», «сколько идти от метро», «далеко ли от дома», commute time for a morning digest. Compare up to five destinations from one start in one call. Each result names the place it matched (`place`): check that it is the one meant, in the right city. `link` opens the route on Yandex Maps or Google Maps; for a car it shows the live time with traffic, which this tool does not know. Use the minutes and km as returned instead of estimating from the map.",
  inputSchema,
  async execute(input, ctx) {
    return measure(input, ctx.abortSignal);
  },
});

export default defineDynamic({
  events: {
    // A person's question and a digest they scheduled; Bro's own mail
    // checks and report turns never send an address anywhere.
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { route_time: routeTime },
        "scheduled-worker": { route_time: routeTime },
      }),
  },
});
