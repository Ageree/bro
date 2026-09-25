import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import {
  findPlace,
  type LookupBudget,
  lookupsPerCall,
  type MapPlace,
  MapServiceError,
  measureRoutes,
  openStreetMapAttribution,
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
 * A part of the query that is a place's own name, where a number belongs to
 * the name: «Школа 57», «Городская поликлиника 2», «Бар 1703». Up to two
 * words may come before the kind («Детская городская поликлиника»).
 */
const namedPlace =
  /^(?:\p{L}+\s+){0,2}(?:кафе|ресторан|бар|паб|кофейня|пиццерия|столовая|бистро|отель|гостиница|хостел|школа|гимназия|лицей|колледж|университет|поликлиника|больница|клиника|роддом|детский сад|аптека|магазин|салон|клуб|кинотеатр|театр|музей|библиотека|school|hospital|clinic|cafe|café|bar|pub|restaurant|hotel|hostel|gym|club|museum|theatre|theater|cinema|store|shop)(?!\p{L})/iu;

/** «1-я Тверская-Ямская» names a street, not a house. */
const numberPattern = /(?<!\p{L})\d+(?![-‐]\p{L})/gu;

/**
 * «12 корп. 2», «11, стр 1», «д. 5» as OpenStreetMap writes Russian houses:
 * «12 к2», «11 с1», «5». The eval on 25.09 asked for «Чистопрудный бульвар
 * 12, корп 2», which the map does not know, while «12 к2» it does.
 */
function withHouseShorthand(query: string) {
  return query
    .replaceAll(/(\d+)\s*(?:,\s*)?(?:корпус|корп\.?)\s*(\d+)/giu, "$1 к$2")
    .replaceAll(/(\d+)\s*(?:,\s*)?(?:строение|стр\.?)\s*(\d+)/giu, "$1 с$2")
    .replaceAll(/(\d+)\s*к\.?\s*(\d+)/giu, "$1 к$2")
    .replaceAll(/(\d+)\s*с\.?\s*(\d+)/giu, "$1 с$2")
    .replaceAll(/(?<!\p{L})(?:дом|д\.)\s*(?=\d)/giu, "");
}

/**
 * The house numbers a query names, as the map would find them. A number in
 * a place's own name («Школа 57», «поликлиника № 2») is not a house: the map
 * finds the school at its real address and must not be refused for it.
 */
function houseNumbers(query: string, place: MapPlace): readonly string[] {
  const inName = new Set(place.name?.match(numberPattern) ?? []);
  return withHouseShorthand(query)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => !namedPlace.test(part))
    .flatMap(
      (part) =>
        part.replaceAll(/(?:№|No\.?|#)\s*\d+/giu, "").match(numberPattern) ?? []
    )
    .filter((number) => !inName.has(number));
}

/** The query is itself this area: «Тверь», «Москва, Россия». */
function namesArea(query: string, place: MapPlace) {
  if (/\d/u.test(query)) return false;
  const first = (query.split(",")[0] ?? "").trim().toLowerCase();
  const name = place.name?.trim().toLowerCase() ?? "";
  return (
    first.length > 0 &&
    name.length > 0 &&
    (first.includes(name) || name.includes(first))
  );
}

/**
 * Why the place the map matched is not the one asked for, or nothing when it
 * is. On 25.09 «Большая Никольская 12 стр 2» came back as the street (18
 * minutes away instead of 8), «Покровка 17» as «Покровка 50/2 с17»,
 * «Тверская 7» as «Тверская 12 с7», and a query ending in «Москва, Россия»
 * could come back as the city itself: a time to such a point is wrong, so it
 * is not given.
 */
function mismatch(query: string, place: MapPlace) {
  if (place.kind === "area") {
    return namesArea(query, place)
      ? undefined
      : `the map found only the area «${place.label}», whose centre is not the place asked for`;
  }
  if (place.kind === "street") {
    return `the map found only the street «${place.label}», some point along it, not the place asked for`;
  }
  const houses = houseNumbers(query, place);
  const matched = /^\d+/u.exec(place.houseNumber ?? "")?.[0];
  if (
    houses.length === 0 ||
    matched === undefined ||
    houses.includes(matched)
  ) {
    return undefined;
  }
  return `the map matched another building, «${place.label}»`;
}

function mismatchNote(reason: string) {
  return `${reason}, and a time to it would be wrong: call again with the place's name and city, or «lat, lon»`;
}

/** A part of the query that is a house alone: «12 к2», «7/15 с1», «26А». */
function housePart(part: string) {
  return /^\d/u.test(part) && !/\p{L}{3}/u.test(part);
}

/**
 * The address after a place's name, with its house and city, as the map
 * finds it: «Чистопрудный бульвар 12 к2, Москва» from «Чистопрудный
 * бульвар 12 к2, Москва» or «Чистопрудный бульвар, 12 к2, Москва». Nothing
 * when there is no street with a house and something after it: a name
 * before only a city must not be cut down to «Москва».
 */
function addressAfterName(address: readonly string[]) {
  const [street = "", house = "", ...rest] = address;
  if (!/\p{L}{3}/u.test(street)) return undefined;
  if (/\d/u.test(street)) {
    return address.length >= 2 ? address.join(", ") : undefined;
  }
  return housePart(house) && rest.length > 0
    ? [`${street} ${house}`, ...rest].join(", ")
    : undefined;
}

/**
 * What to ask the geocoder, best first. When a name comes before an address
 * with a house, the address alone goes first: the map finds a building by
 * its address but almost never a name and an address together. Live on
 * 25.09 «Авокадо, Чистопрудный бульвар, 12 к2, Москва», «Hedonist,
 * Покровский бульвар, 8 с1, Москва» and even «Кафе Пушкинъ, Тверской
 * бульвар 26А, Москва» were not on the map, while each address alone was;
 * in the benchmark all three places of one pick came back unmeasured so.
 * Then the query as given, then the name without the kind of place and
 * quotes. A street with its house first («Тверская 7, Москва, Россия») or a
 * name before only a city is never cut down to «Москва, Россия»: the map
 * would answer with the city. Each miss costs a lookup and two seconds of
 * the turn.
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
  const addressOnly = /\d/u.test(name) ? undefined : addressAfterName(address);
  const variants = [
    ...(addressOnly === undefined ? [] : [addressOnly]),
    parts.join(", "),
  ];
  if (bareName.length > 0) variants.push([bareName, ...address].join(", "));
  return [...new Set(variants)];
}

/**
 * Finds a place by the first variant of the query the map knows. A match
 * that is not the place asked for is kept only when no variant finds it, and
 * then gets no time.
 */
async function locate(
  query: string,
  near: MapPlace | undefined,
  budget: LookupBudget,
  signal: AbortSignal
) {
  let fallback: MapPlace | undefined;
  /* oxlint-disable eslint/no-await-in-loop -- Each variant is asked only when the one before found nothing, two seconds apart. */
  for (const variant of queryVariants(query)) {
    const place = await findPlace(variant, near, budget, signal);
    if (place && mismatch(query, place) === undefined) return place;
    fallback ??= place;
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return fallback;
}

/** An area the person named on purpose is measured to its centre, and says so. */
function areaNote(place: MapPlace) {
  return place.kind === "area"
    ? `the time is to the centre of «${place.label}», not to an address`
    : undefined;
}

async function measure(
  input: z.infer<typeof inputSchema>,
  signal: AbortSignal
) {
  const basis = basisByMode[input.mode];
  const budget: LookupBudget = { remaining: lookupsPerCall };
  let from: MapPlace | undefined;
  try {
    from = await locate(input.from, undefined, budget, signal);
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
  const startMismatch = mismatch(input.from, from);
  if (startMismatch !== undefined) {
    return {
      note: `For the start «${input.from}», ${mismatchNote(startMismatch)}.`,
      status: "not_found" as const,
    };
  }

  const places: {
    readonly failure?: string;
    readonly place: MapPlace | undefined;
    readonly query: string;
  }[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- One at a time on purpose: the geocoder allows one request a second for the whole application. */
  for (const query of input.to) {
    try {
      places.push({ place: await locate(query, from, budget, signal), query });
    } catch (error) {
      if (!(error instanceof MapServiceError)) throw error;
      places.push({ failure: error.message, place: undefined, query });
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  const found = places.flatMap((entry) =>
    entry.place && mismatch(entry.query, entry.place) === undefined
      ? [entry.place]
      : []
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
    const missed = mismatch(entry.query, place);
    if (missed !== undefined) {
      return { error: mismatchNote(missed), to: entry.query };
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
      note: areaNote(place),
      place: place.label,
      to: entry.query,
    };
  });

  return {
    attribution: openStreetMapAttribution,
    basis,
    from: from.label,
    fromNote: areaNote(from),
    mode: input.mode,
    pick: input.mode === "walking" ? pickNote(routes) : undefined,
    routes,
    status: "ok" as const,
  };
}

/** «Пешком» when the person named no limit of their own (recommendations.md). */
const walkLimitMinutes = 15;
/** Options a pick of places aims at, each passing every condition. */
const pickSize = 3;

/**
 * How many of the places measured are within a walk, and how many a pick
 * still lacks. The rule of three verified options lived only in the prompt,
 * and on 25.09 (RU d03) gpt-6-luna answered a dinner pick with one place
 * after one round of searches: the tool result the model reads last is
 * where it takes its next step from.
 */
function pickNote(routes: readonly { readonly minutes?: number }[]) {
  const measured = routes.flatMap((route) =>
    route.minutes === undefined ? [] : [route.minutes]
  );
  const near = measured.filter((minutes) => minutes <= walkLimitMinutes);
  const unmeasured = routes.length - measured.length;
  const lacking = pickSize - near.length;
  const counted = `${String(near.length)} of ${String(routes.length)} ${routes.length === 1 ? "place is" : "places are"} within a ${String(walkLimitMinutes)}-minute walk${unmeasured > 0 ? ` and ${String(unmeasured)} not measured` : ""}`;
  const next =
    lacking > 0
      ? `${String(lacking)} more ${lacking === 1 ? "is" : "are"} needed: before you reply, find other candidates near the start that fit the rest of the conditions (web_search with sites yandex.ru/maps or 2gis.ru) and measure them here in one more call. Reply with fewer only when that search found none, and say how many fit and why`
      : "Before you reply, check each of them against the rest of the conditions";
  return `If these are candidates for a pick of places («где поужинать пешком от…»): ${counted}. A pick aims at ${String(pickSize)} options that each pass every condition the person named, the walk included (${String(walkLimitMinutes)} minutes unless they named their own limit). ${next}; name whatever you could not check as not checked.`;
}

export const routeTime = defineTool({
  description:
    "Measure how long it takes to walk, cycle or drive between places, and how far it is, on OpenStreetMap with no key: «пешком от отеля», «сколько идти от метро», «далеко ли от дома», commute time for a morning digest. Compare up to five destinations from one start in one call. Each result names the place it matched (`place`): check that it is the one meant, in the right city. A destination the map found only as a street, a district or another building comes back with an error instead of minutes: never fill in a time for it. `link` opens the route on Yandex Maps or Google Maps; for a car it shows the live time with traffic, which this tool does not know. Use the minutes and km as returned instead of estimating from the map, and wherever you give them credit the map briefly with `attribution`, for example «(по данным © OpenStreetMap)».",
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
