import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import {
  findPlaces,
  type LookupBudget,
  lookupsPerCall,
  type MapPlace,
  MapServiceError,
  measureRoutes,
  openStreetMapAttribution,
  placeType,
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
    "The start: a street address or a named place with its city («отель Метрополь, Москва», «метро Чистые пруды, Москва», «Tverskaya 7, Moscow»), or «lat, lon». A station, an airport or a landmark goes by its own name and city («вокзал, Казань», «аэропорт Шереметьево», «Казанский кремль, Казань»), never by an address you composed for it: a guessed street is often another place. Only places and addresses, never a person's name or phone."
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
      "Destinations in the same form as from, each with its street or city and the place's name first when it has one («Флер, Чистопрудный бульвар 19 с1, Москва»), so each result says whose time it is; up to five are measured from the same start in one call."
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
  const parts = queryParts(withHouseShorthand(query));
  const [name = "", ...address] = parts;
  const bare = bareName(name);
  const addressOnly = /\d/u.test(name) ? undefined : addressAfterName(address);
  const first = addressOnly ?? parts.join(", ");
  const variants = [
    first,
    first.replaceAll(buildingPattern, "$1"),
    parts.join(", "),
  ];
  if (bare.length > 0) variants.push([bare, ...address].join(", "));
  return [...new Set(variants)];
}

function queryParts(query: string) {
  return query
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** A place's name without its kind and quotes: «Метрополь» of «гостиница «Метрополь»». */
function bareName(name: string) {
  return name
    .replace(kindOfPlace, "")
    .replaceAll(/[«»"“”„]/gu, "")
    .trim();
}

/**
 * A building of a house, «7/5 с1» or «12 к2», with the house it belongs to.
 * The map often knows only the house: live on 25.09 «Большая Дмитровка,
 * 7/5 с1, Москва» (RU d18, «7/5, стр. 1») came back as the street, and
 * «Большая Дмитровка, 7/5, Москва» as the house itself.
 */
const buildingPattern = /(?<!\d)(\d+(?:\/\d+)?\p{L}?)\s+[кс]\d+(?!\d)/gu;

/**
 * Says so when the map found the house but not the building asked for:
 * the time is to the house, a few steps from its building.
 */
function buildingNote(query: string, place: MapPlace) {
  const asked = withHouseShorthand(query).match(buildingPattern)?.[0];
  if (asked === undefined || /[кс]\d/u.test(place.houseNumber ?? "")) {
    return undefined;
  }
  return `the map knows the house «${place.houseNumber ?? place.label}» but not its building «${asked}»; the time is to that house`;
}

/** Words of a name as they are compared: «Казанский кремль» → казанский, кремль. */
function nameWords(text: string) {
  return (
    text
      .toLowerCase()
      .replaceAll("ё", "е")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Whether the place's own name has every one of these words. */
function namedAs(place: MapPlace, words: readonly string[]) {
  if (words.length === 0) return false;
  const own = new Set(nameWords(place.name ?? ""));
  return words.every((word) => own.has(word));
}

/** Stops named after what they serve: «Казанский вокзал» is a bus stop too. */
const stopTags: ReadonlySet<string> = new Set([
  "highway:bus_stop",
  "public_transport:platform",
  "public_transport:stop_position",
  "railway:platform",
  "railway:stop",
  "railway:subway_entrance",
  "railway:tram_stop",
]);

/** A place itself, not a street, an area or a stop named after it. */
function standsAlone(place: MapPlace) {
  return place.kind === "place" && !stopTags.has(place.tag ?? "");
}

/**
 * Places people name by what they are more than by an address. The map
 * ranks by words, not by what a place is: live on 25.09 «вокзал, Казань»
 * came back as «Северный вокзал» first and the city's main station second,
 * «аэропорт, Казань» as a garage cooperative called «Аэропорт», and
 * «Казанский вокзал, Казань» as nothing at all — after which the model asked
 * for «улица Привокзальная 1, Казань», a halt in Юдино 15 km out, and told
 * the person (RU d13) that every restaurant in the centre was a taxi ride
 * from the station. A kind named inside another is listed first.
 */
const landmarkKinds = [
  {
    generic: { en: "bus station", ru: "автовокзал" },
    name: "bus station",
    tags: new Set(["amenity:bus_station"]),
    words:
      /(?<!\p{L})автовокзал(?:а|е|у|ом|ы|ов)?(?!\p{L})|(?<!\p{L})(?:bus|coach)\s+station(?!\p{L})/iu,
  },
  {
    generic: { en: "ferry terminal", ru: "речной вокзал" },
    name: "river or sea port",
    tags: new Set(["amenity:ferry_terminal"]),
    words:
      /(?<!\p{L})(?:речн|морск)\p{L}*\s+(?:вокзал|порт)(?:а|е|у|ом|ы|ов)?(?!\p{L})|(?<!\p{L})ferry\s+terminal(?!\p{L})/iu,
  },
  {
    generic: { en: "railway station", ru: "вокзал" },
    name: "railway station",
    tags: new Set([
      "building:train_station",
      "railway:halt",
      "railway:station",
    ]),
    words:
      /(?<!\p{L})(?:(?:ж\/д|жд|железнодорожн\p{L}*)\s+)?вокзал(?:а|е|у|ом|ы|ов)?(?!\p{L})|(?<!\p{L})(?:railway|train)\s+station(?!\p{L})/iu,
  },
  {
    generic: { en: "airport", ru: "аэропорт" },
    name: "airport",
    tags: new Set(["aeroway:aerodrome", "aeroway:terminal"]),
    words: /(?<!\p{L})(?:аэропорт(?:а|е|у|ом|ы|ов)?|airport)(?!\p{L})/iu,
  },
] as const;

type LandmarkKind = (typeof landmarkKinds)[number];

/** «кафе Вокзал», «метро Аэропорт»: a place named after a landmark. */
const namedAfterLandmark =
  /^(?:отель|гостиница|хостел|ресторан|кафе|кофейня|бар|паб|бистро|пиццерия|столовая|метро|м\.|станция метро|hotel|hostel|restaurant|cafe|café|bar|pub|bistro|metro|subway)(?!\p{L})/iu;

/** «улица Ленина», «пр-т Мира»: a part of a query that names a street. */
const streetPart =
  /(?<!\p{L})(?:улиц|ул\.|проспект|пр-т|переул|пер\.|площад|шоссе|бульвар|проезд|набережн|street|avenue|road|square)/iu;

/** Words that name no particular station: «главный», «центральный». */
const kindQualifiers =
  /(?<!\p{L})(?:главн|центральн|пассажирск|main|central)\p{L}*/giu;

/**
 * The landmark a query names, when it names one rather than an address:
 * its kind, the words of its own name besides the kind («казанский» of
 * «Казанский вокзал»; none for «вокзал»), and where it is.
 */
function landmarkIn(query: string) {
  if (/\d/u.test(query)) return undefined;
  const [name = "", ...around] = queryParts(query);
  // «площадь Казанского вокзала» is a street.
  if (namedAfterLandmark.test(name) || streetPart.test(name)) return undefined;
  const kind = landmarkKinds.find((candidate) => candidate.words.test(name));
  if (!kind) return undefined;
  return {
    around,
    kind,
    name,
    ownWords: nameWords(
      name.replace(kind.words, " ").replaceAll(kindQualifiers, " ")
    ),
  };
}

type Landmark = NonNullable<ReturnType<typeof landmarkIn>>;

function servesAs(kind: LandmarkKind, place: MapPlace) {
  return kind.tags.has(place.tag ?? "");
}

/**
 * The landmark among the map's candidates: one of its kind with its name,
 * then another place with its name (Moscow's «Казанский вокзал» is a
 * tourist attraction on the map), then one of its kind. Asked for the kind
 * alone («вокзал, Казань»), the best known of that kind. Last, a place named
 * after the kind: the tram stop «Железнодорожный вокзал» at the station.
 */
function chooseLandmark(
  landmark: Landmark,
  candidates: readonly MapPlace[],
  ownWords = landmark.ownWords
) {
  const { kind } = landmark;
  const ofKind = candidates.filter((place) => servesAs(kind, place));
  const chosen =
    ownWords.length === 0
      ? ofKind.toSorted(
          (left, right) => (right.importance ?? 0) - (left.importance ?? 0)
        )[0]
      : (ofKind.find((place) => namedAs(place, ownWords)) ??
        candidates.find(
          (place) => standsAlone(place) && namedAs(place, ownWords)
        ) ??
        ofKind[0]);
  return (
    chosen ??
    candidates.find(
      (place) => place.kind === "place" && kind.words.test(place.name ?? "")
    )
  );
}

/**
 * The place a query without a house means among the map's candidates. The
 * map's first is kept unless it lacks a word of the name and another place
 * has them all: live on 25.09 «Кремль, Казань» came back as the metro
 * station «Кремлёвская» first and «Казанский кремль» third.
 */
function choosePlace(query: string, candidates: readonly MapPlace[]) {
  const [first] = candidates;
  const words = nameWords(bareName(queryParts(query)[0] ?? ""));
  if (first === undefined || namedAs(first, words)) return first;
  return (
    candidates.find((place) => standsAlone(place) && namedAs(place, words)) ??
    first
  );
}

/** Candidates asked for a landmark, and for a name without a house. */
const landmarkCandidates = 10;
const namedCandidates = 5;

/** A place found, with why it may not be the one meant. */
interface Located {
  readonly place: MapPlace;
  readonly uncertain?: string;
}

/**
 * Whether the landmark's own name only says which city it is in:
 * «Казанский» of «Казанский вокзал, Казань», «Курский» in Kursk — not
 * «Ленинградский» in Moscow, which is a station of its own.
 */
function namedForTheCity(landmark: Landmark) {
  const cityWords = landmark.around.flatMap(nameWords);
  return landmark.ownWords.every((word) =>
    cityWords.some(
      (city) => city.length >= 4 && word.startsWith(city.slice(0, 4))
    )
  );
}

/**
 * When a landmark named for its city is not on the map by that name, the
 * best-known one of its kind in that city: «Казанский вокзал, Казань» is
 * what people call the station of Kazan, which the map knows as
 * «Казань-Пассажирская». The time is to that one, and the result says so.
 */
async function locateKindOf(
  landmark: Landmark,
  near: MapPlace | undefined,
  budget: LookupBudget,
  signal: AbortSignal
): Promise<Located | undefined> {
  if (landmark.ownWords.length === 0 || !namedForTheCity(landmark)) {
    return undefined;
  }
  const generic = /\p{Script=Cyrillic}/u.test(landmark.name)
    ? landmark.kind.generic.ru
    : landmark.kind.generic.en;
  const candidates = await findPlaces(
    [generic, ...landmark.around].join(", "),
    near,
    budget,
    signal,
    landmarkCandidates
  );
  const place = chooseLandmark(landmark, candidates, []);
  if (!place || !servesAs(landmark.kind, place)) return undefined;
  return {
    place,
    uncertain: `the map has no «${landmark.name}» in «${landmark.around.join(", ")}»; this is the best-known ${landmark.kind.name} there, «${place.name ?? place.label}». Give its time only naming that place, and if another one was meant, ask which`,
  };
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
): Promise<Located | undefined> {
  const landmark = landmarkIn(query);
  const limit = landmark
    ? landmarkCandidates
    : /\d/u.test(query)
      ? 1
      : namedCandidates;
  let fallback: MapPlace | undefined;
  /* oxlint-disable eslint/no-await-in-loop -- Each variant is asked only when the one before found nothing, two seconds apart. */
  for (const variant of queryVariants(query)) {
    const candidates = await findPlaces(variant, near, budget, signal, limit);
    const place = landmark
      ? chooseLandmark(landmark, candidates)
      : choosePlace(query, candidates);
    if (place && mismatch(query, place) === undefined) return { place };
    fallback ??= place ?? candidates[0];
  }
  /* oxlint-enable eslint/no-await-in-loop */
  if (landmark) {
    const kindOf = await locateKindOf(landmark, near, budget, signal);
    if (kindOf) return kindOf;
  }
  if (fallback === undefined) return undefined;
  if (!landmark || mismatch(query, fallback) !== undefined) {
    return { place: fallback };
  }
  const type = placeType(fallback);
  return {
    place: fallback,
    uncertain: `the map found «${fallback.label}»${type === undefined ? "" : ` (${type})`}, not the ${landmark.kind.name} itself: its name or street only resembles «${landmark.name}». Call again with the ${landmark.kind.name}'s own name and city, or «lat, lon» from a source`,
  };
}

/** An area the person named on purpose is measured to its centre, and says so. */
function areaNote(place: MapPlace) {
  return place.kind === "area"
    ? `the time is to the centre of «${place.label}», not to an address`
    : undefined;
}

/** What the map matched, so the reply can say where a time is to. */
function matchedAs(place: MapPlace) {
  const precision = {
    area: "area: its centre",
    place: place.name
      ? "named place"
      : place.houseNumber
        ? "building"
        : "place",
    point: "coordinates as given",
    street: "street: some point along it",
  }[place.kind];
  return { district: place.district, precision, type: placeType(place) };
}

/** Farther than this in a straight line is well over an hour on foot. */
const farWalkKm = 5;

/**
 * The city a query names after its first part: «Казань» of «улица
 * Привокзальная 1, Казань», «Москва, Россия» of «Тверская 7, Москва,
 * Россия». Nothing when the query names none.
 */
function namedCity(query: string) {
  const city = queryParts(query)
    .slice(1)
    .filter((part) => !/\d/u.test(part) && !streetPart.test(part));
  return city.length > 0 ? city.join(", ") : undefined;
}

/**
 * Whether the start lies out of the city the query named, while a
 * destination lies in towards its centre: a start in Юдино for a dinner by
 * the Kremlin. Asks the map for the city once, and only for a walk that is
 * long already. A city the map does not find, or a failed lookup, is no
 * doubt.
 */
async function outOfTown(
  query: string,
  from: MapPlace,
  found: readonly MapPlace[],
  budget: LookupBudget,
  signal: AbortSignal
) {
  const city = namedCity(query);
  if (city === undefined) return false;
  let centre: MapPlace | undefined;
  try {
    [centre] = await findPlaces(city, undefined, budget, signal);
  } catch (error) {
    if (!(error instanceof MapServiceError)) throw error;
    return false;
  }
  if (centre?.kind !== "area") return false;
  const startKm = straightKm(centre, from);
  return (
    startKm > farWalkKm &&
    found.some((place) => straightKm(centre, place) < startKm / 2)
  );
}

/**
 * What to check when every destination of a walk is hours away from a
 * start that may be another place: one the map matched uncertainly, or one
 * far out of the city the query named while the destinations lie towards
 * its centre. On 25.09 (RU d13) the start was «улица Привокзальная 1,
 * Казань», a halt in Юдино, and the person heard that the three restaurants
 * by the Kremlin were 15 km from the station — they are 2 km from it. A
 * long walk from a start matched well (from the Bolshoi to ВДНХ) is left
 * alone, and a start given as coordinates or a city is taken as meant.
 */
async function farStart(
  input: z.infer<typeof inputSchema>,
  start: Located,
  found: readonly MapPlace[],
  budget: LookupBudget,
  signal: AbortSignal
) {
  const from = start.place;
  if (input.mode !== "walking" || found.length === 0) return undefined;
  if (from.kind === "point" || from.kind === "area") return undefined;
  const nearest = Math.min(...found.map((place) => straightKm(from, place)));
  if (nearest <= farWalkKm) return undefined;
  if (
    start.uncertain === undefined &&
    !(await outOfTown(input.from, from, found, budget, signal))
  ) {
    return undefined;
  }
  const where = from.district ? ` in ${from.district}` : "";
  return `every destination is at least ${String(nearest)} km in a straight line from «${from.label}»${where}: over an hour on foot. If the person starts there, these times stand: give them as they are. If the start they meant is near the destinations (a station, a hotel or a landmark in the centre), the map matched another place with a similar name or address: call again with that place's own name and city («вокзал, Казань», «Казанский кремль, Казань») or «lat, lon» from a source, and until then state none of these times as fact and do not tell the person the places are far`;
}

async function measure(
  input: z.infer<typeof inputSchema>,
  signal: AbortSignal
) {
  const basis = basisByMode[input.mode];
  const budget: LookupBudget = { remaining: lookupsPerCall };
  let start: Located | undefined;
  try {
    start = await locate(input.from, undefined, budget, signal);
  } catch (error) {
    if (!(error instanceof MapServiceError)) throw error;
    return {
      note: `${error.message}. Say you could not measure the route right now; do not guess a time.`,
      status: "unavailable" as const,
    };
  }
  if (!start) {
    return {
      note: `The start «${input.from}» is not on the map. Call again with its own name and city as a map knows it, or with an address or «lat, lon» from a source — never an address you composed, which is often another place — or ask the person where exactly they start from.`,
      status: "not_found" as const,
    };
  }
  const from = start.place;
  const startMismatch = mismatch(input.from, from);
  if (startMismatch !== undefined) {
    return {
      note: `For the start «${input.from}», ${mismatchNote(startMismatch)}.`,
      status: "not_found" as const,
    };
  }

  const places: {
    readonly failure?: MapServiceError;
    readonly located: Located | undefined;
    readonly query: string;
  }[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- One at a time on purpose: the geocoder allows one request a second for the whole application. */
  for (const query of input.to) {
    try {
      places.push({
        located: await locate(query, from, budget, signal),
        query,
      });
    } catch (error) {
      if (!(error instanceof MapServiceError)) throw error;
      places.push({ failure: error, located: undefined, query });
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  const found = places.flatMap((entry) =>
    entry.located && mismatch(entry.query, entry.located.place) === undefined
      ? [entry.located.place]
      : []
  );

  let measured: Awaited<ReturnType<typeof measureRoutes>> = [];
  let routerFailure: MapServiceError | undefined;
  try {
    measured = await measureRoutes(input.mode, from, found, signal);
  } catch (error) {
    if (!(error instanceof MapServiceError)) throw error;
    routerFailure = error;
  }

  let foundIndex = 0;
  const routes = places.map((entry) => {
    if (!entry.located) {
      return {
        error:
          entry.failure === undefined
            ? "not on the map: add the street and city from a source, or pass «lat, lon»"
            : `${entry.failure.message}; this destination was not measured`,
        to: entry.query,
      };
    }
    const { place, uncertain } = entry.located;
    const missed = mismatch(entry.query, place);
    if (missed !== undefined) {
      return { error: mismatchNote(missed), to: entry.query };
    }
    const route = measured[foundIndex];
    foundIndex += 1;
    const link = routeLink(input.mode, from, place);
    const matched = matchedAs(place);
    if (routerFailure !== undefined) {
      return {
        error: `${routerFailure.message}: only the straight-line distance is known, so state no travel time`,
        link,
        matched,
        place: place.label,
        straightKm: straightKm(from, place),
        to: entry.query,
        uncertain,
      };
    }
    if (!route) {
      return {
        error: "no route between these places on the map",
        link,
        matched,
        place: place.label,
        straightKm: straightKm(from, place),
        to: entry.query,
        uncertain,
      };
    }
    return {
      km: route.km,
      link,
      matched,
      minutes: route.minutes,
      note: areaNote(place) ?? buildingNote(entry.query, place),
      place: place.label,
      to: entry.query,
      uncertain,
    };
  });

  const startFar = await farStart(input, start, found, budget, signal);
  return {
    attribution: openStreetMapAttribution,
    basis,
    from: from.label,
    fromFar: startFar,
    fromMatched: matchedAs(from),
    fromNote: areaNote(from),
    fromUncertain: start.uncertain,
    mode: input.mode,
    pick:
      input.mode === "walking"
        ? pickNote(
            routes,
            {
              // Places the map service or this call's lookups left unmeasured.
              count:
                places.filter((entry) => entry.failure !== undefined).length +
                (routerFailure === undefined ? 0 : found.length),
              refusing: mapRefusing(
                places.flatMap((entry) =>
                  entry.failure === undefined ? [] : [entry.failure]
                ),
                routerFailure !== undefined,
                routes.some((route) => "minutes" in route)
              ),
            },
            startFar !== undefined
          )
        : undefined,
    routes,
    status: "ok" as const,
  };
}

/**
 * Whether the map service is to be taken as refusing for the rest of the
 * turn, so the pick asks for nothing more to be measured. Any router failure
 * is: its one request covers every place. So is a geocoder that refused, or
 * failed more than once, or failed where nothing was measured. Only a single
 * failed lookup among measured places, or a call out of lookups, leaves the
 * next call to measure as usual: when the router answered 502 on every call,
 * «a one-off error, measure again» sent the model round and round.
 */
function mapRefusing(
  failures: readonly MapServiceError[],
  routerFailed: boolean,
  anyMeasured: boolean
) {
  if (routerFailed) return true;
  const lookups = failures.filter((failure) => failure.failure !== "budget");
  return (
    lookups.some((failure) => failure.failure === "refusing") ||
    lookups.length > 1 ||
    (lookups.length === 1 && !anyMeasured)
  );
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
 * where it takes its next step from. A place the map service left
 * unmeasured stays a candidate rather than a place to replace. While the
 * service refuses (`mapRefusing`) nothing more is to be measured: asking for
 * replacements then sent the model to search and measure again against a
 * service that was still refusing. After a one-off error or a call out of
 * lookups the next call measures as usual. From a start that may be
 * another place (`farStart`) it looks for no candidates near it: in RU d13
 * «0 of 3 within a walk, find others near the start» would have sent the
 * model to look for dinner in Юдино. With three within a walk, on 26.09 (RU
 * d03) the reply still led with a chain and named two bills and one day's
 * hours as not checked, so the note says what the rest of the check is.
 */
function pickNote(
  routes: readonly { readonly minutes?: number }[],
  unmeasuredByService: { readonly count: number; readonly refusing: boolean },
  startFar: boolean
) {
  if (startFar) {
    return "If these are candidates for a pick of places: if the start meant is near these places, count no walks from it and look for no candidates near it — settle the start first (fromFar); if the start is right, none of them is within a walk.";
  }
  const measured = routes.flatMap((route) =>
    route.minutes === undefined ? [] : [route.minutes]
  );
  const near = measured.filter((minutes) => minutes <= walkLimitMinutes);
  const unmeasured = routes.length - measured.length;
  const { count, refusing } = unmeasuredByService;
  const lacking = pickSize - near.length - count;
  const counted = `${String(near.length)} of ${String(routes.length)} ${routes.length === 1 ? "place is" : "places are"} within a ${String(walkLimitMinutes)}-minute walk${unmeasured > 0 ? ` and ${String(unmeasured)} not measured` : ""}`;
  const them = count === 1 ? "it" : "them";
  const candidates = count === 1 ? "a candidate" : "candidates";
  const service =
    count === 0
      ? ""
      : refusing
        ? ` ${String(count)} of them went unmeasured because the map service is refusing now: keep ${them} as ${candidates} with the walk named as not checked, never guess minutes, look for no replacement for ${them} and do not measure ${them} again in this turn.`
        : ` ${String(count)} of them went unmeasured because of a one-off map error or this call's lookup limit, not because of where ${count === 1 ? "it is" : "they are"}: keep ${them} as ${candidates} and measure ${them} again in one more call; never guess minutes.`;
  const next =
    lacking > 0
      ? `${String(lacking)} more ${lacking === 1 ? "is" : "are"} needed: before you reply, find other candidates near the start that fit the rest of the conditions (web_search with sites yandex.ru/maps or 2gis.ru)${refusing ? ", and while the map service refuses give their walk as not checked instead of measuring them" : " and measure them here in one more call"}. Reply with fewer only when that search found none, and say how many fit and why`
      : "Before you reply, check each of them against the rest of the conditions — its bill and its hours that day from a result about that very place, and «не сеть» by the branch count on its own map card (2 or more branches is a chain) — searching by its name for what no result has shown yet, and replace one that fails with the next candidate rather than keep it with a minus";
  return `If these are candidates for a pick of places («где поужинать пешком от…»): ${counted}. A pick aims at ${String(pickSize)} options that each pass every condition the person named, the walk included (${String(walkLimitMinutes)} minutes unless they named their own limit).${service} ${next}; give each option only the minutes of its own row — one not measured here has no walk to state — and name whatever you could not check as not checked.`;
}

export const routeTime = defineTool({
  description:
    "Measure how long it takes to walk, cycle or drive between places, and how far it is, on OpenStreetMap with no key: «пешком от отеля», «сколько идти от метро», «далеко ли от дома», commute time for a morning digest. Compare up to five destinations from one start in one call. Each result names the place it matched (`place`, and in `matched` what it is, how precise and in which district; `from` and `fromMatched` for the start): check that it is the one meant, in the right city, and name it with the time. A result with `uncertain` (`fromUncertain` for the start) may be another place: state none of its times or distances as fact and do what it says. `fromFar` says what to check when every walk is long. A destination the map found only as a street, a district or another building comes back with an error instead of minutes: never fill in a time for it. `link` opens the route on Yandex Maps or Google Maps; for a car it shows the live time with traffic, which this tool does not know. Use the minutes and km as returned instead of estimating from the map, and wherever you give them credit the map briefly with `attribution`, for example «(по данным © OpenStreetMap)».",
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
