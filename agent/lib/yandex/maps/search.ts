import { z } from "zod";
import { defineYandexOperation, type JsonValue } from "../operations";
import { mapsPage } from "./page";

const coordinates = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

const place = z.object({
  address: z.string().nullable(),
  bookable: z.boolean(),
  category: z.string().nullable(),
  coordinates: coordinates.nullable(),
  hours: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  openNow: z.boolean().nullable(),
  openText: z.string().nullable(),
  phone: z.string().nullable(),
  rating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  site: z.string().nullable(),
  url: z.string(),
});

/** Places closer than this stand in one building, for `sameBuildingNote`. */
const sameBuildingMetres = 60;

/**
 * 23.10: «в моём доме есть парикмахерская, запиши меня» — two salons stand
 * at Мичуринский, 56, and Bro went to book at the one it found first, not
 * the one the person meant. When places of a result stand in one building,
 * a note that names them building by building, so Bro asks which one when
 * the person meant a particular place without naming it; undefined when no
 * two places stand together.
 */
export function sameBuildingNote(result: JsonValue) {
  const found = z.object({ places: z.array(place) }).safeParse(result);
  if (!found.success) return undefined;
  const located = found.data.places.flatMap((one) =>
    one.coordinates === null ? [] : [{ ...one, at: one.coordinates }]
  );
  // A building is every place within reach of another of it.
  const buildings: (typeof located)[] = [];
  for (const one of located) {
    const near = buildings.filter((building) =>
      building.some(
        (other) => metresBetween(one.at, other.at) < sameBuildingMetres
      )
    );
    const merged = [...near.flat(), one];
    for (const building of near)
      buildings.splice(buildings.indexOf(building), 1);
    buildings.push(merged);
  }
  const shared = buildings.filter((building) => building.length > 1);
  if (shared.length === 0) return undefined;
  const lines = shared.map((building) => {
    const address =
      building.find((one) => one.address !== null)?.address ?? undefined;
    const names = building.map((one) => `«${one.name}»`).join(", ");
    return address === undefined ? names : `${names} (${address})`;
  });
  return `Note: these places share a building — ${lines.join("; ")}. When the person means one particular place there («в моём доме», one they go to) without naming it, ask which one before you book, call or write there; when any of them will do, choose yourself.`;
}

/** Metres between two [longitude, latitude] points a short way apart. */
function metresBetween(
  [lonA, latA]: readonly [number, number],
  [lonB, latB]: readonly [number, number]
) {
  const north = (latA - latB) * 111_320;
  const east =
    (lonA - lonB) * 111_320 * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
  return Math.hypot(north, east);
}

/**
 * Places on Yandex Maps for a text query around a point: the name, rating,
 * hours, whether it is open now and whether it takes online bookings. The
 * search needs no sign-in. The place's own page and its booking come from
 * maps.org.
 */
export const mapsSearchOperation = defineYandexOperation({
  about:
    "Places on Yandex Maps for a query (for example «пиццерия») around a point: name, rating, hours, open now, phone, whether it takes online bookings, and the card's id for maps.org. Takes query, an optional near as [longitude, latitude] (default central Moscow), an optional span as [width, height] in degrees (default 0.06 × 0.03, about a district), and limit (1 to 10, default 10).",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(10).default(10),
    near: coordinates.default([37.6177, 55.755863]),
    query: z.string().min(1).max(200),
    span: z
      .tuple([z.number().min(0.001).max(10), z.number().min(0.001).max(10)])
      .default([0.06, 0.03]),
  }),
  id: "maps.search",
  origin: "https://yandex.ru/robots.txt",
  result: z.union([
    z.object({ places: z.array(place).max(10), total: z.number() }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  ${mapsPage}
  const session = mapsContext();
  const d = await mapsCall(session, "/maps/api/search", [
    ["lang", "ru_RU"],
    ["ll", args.near.join(",")],
    ["spn", args.span.join(",")],
    ["origin", "maps-form"],
    ["results", "10"],
    ["snippets", "businessrating/1.x,bookings/1.x"],
    ["text", args.query],
    ["z", "14"],
  ]);
  const bad = mapsAnswer(d);
  if (bad) return bad;
  const places = (d.items || [])
    .filter((i) => i.type === "business")
    .slice(0, args.limit)
    .map((i) => ({
      address: i.fullAddress || i.address || null,
      bookable: !!i.booking,
      category: (i.categories || [])[0] ? i.categories[0].name : null,
      coordinates: i.coordinates || null,
      hours: i.workingTimeText || null,
      id: i.id,
      name: i.title,
      openNow: i.currentWorkingStatus ? i.currentWorkingStatus.isOpenNow : null,
      openText: i.currentWorkingStatus ? i.currentWorkingStatus.text : null,
      phone: (i.phones || [])[0] ? i.phones[0].number : null,
      rating: i.ratingData ? Math.round(i.ratingData.ratingValue * 10) / 10 : null,
      ratingCount: i.ratingData ? i.ratingData.ratingCount : null,
      site: (i.urls || [])[0] ? i.urls[0].split("?")[0] : null,
      url: "https://yandex.ru/maps/org/" + i.seoname + "/" + i.id + "/",
    }));
  return { status: "ok", data: { places, total: d.totalResultCount } };
}`,
  service: "maps",
});
