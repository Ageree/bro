import { z } from "zod";
import { defineYandexOperation } from "../operations";
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
  origin: "https://yandex.ru/maps/",
  result: z.union([
    z.object({ places: z.array(place).max(10), total: z.number() }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  ${mapsPage}
  const session = await mapsContext();
  if (session === null) return { status: "ok", data: { error: "no_session" } };
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
