import { z } from "zod";
import { defineYandexOperation } from "../operations";

const menuItem = z.object({
  available: z.boolean(),
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  needsOptions: z.boolean(),
  oldPrice: z.number().nullable(),
  price: z.number(),
  section: z.string(),
  weight: z.string().nullable(),
});

const menuPlace = z.object({
  minOrder: z.number(),
  name: z.string(),
  rating: z.number(),
  ratingCount: z.number(),
});

const menuAnswer = z.union([
  z.object({ error: z.literal("place_not_found") }),
  z.object({
    delivery: z
      .object({
        available: z.boolean(),
        fees: z.array(z.string()),
        minutes: z.string().nullable(),
      })
      .nullable(),
    items: z.array(menuItem).max(30),
    place: menuPlace.nullable(),
    sections: z.array(z.string()),
  }),
]);

/**
 * One place's menu on Yandex Eda, up to 30 dishes, with its delivery terms.
 * The slug comes from `food.eda_search`.
 */
export const edaMenuOperation = defineYandexOperation({
  about:
    "A place's menu on Yandex Eda: up to 30 dishes with prices, and its delivery time and fees. Arguments: slug (the place's slug from food.eda_search), lat and lon (the same coordinates as the search). A dish with needsOptions has required choices (size, dough) and cannot be ordered as it is.",
  access: "read",
  args: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    slug: z.string().min(1).max(200),
  }),
  id: "food.eda_menu",
  origin: "https://eda.yandex.ru/",
  result: menuAnswer,
  run: `async function (args) {
  const headers = {
    "X-Platform": "desktop_web",
    "X-App-Version": "18.50.1",
    "X-Ya-Coordinates": "latitude=" + args.lat + ",longitude=" + args.lon,
  };
  const query = "latitude=" + args.lat + "&longitude=" + args.lon;
  const slug = encodeURIComponent(args.slug);
  const menuResponse = await fetch("/api/v2/menu/retrieve/" + slug + "?" + query + "&autoTranslate=false", { headers });
  if (menuResponse.status === 404) return { status: "ok", data: { error: "place_not_found" } };
  if (menuResponse.status >= 400 && /html/.test(menuResponse.headers.get("content-type") || "")) return { status: "captcha" };
  if (menuResponse.status !== 200) throw new Error("http " + menuResponse.status);
  const menu = await menuResponse.json();
  // The site's own pause between the two requests: the catalog is asked after it.
  await new Promise((done) => setTimeout(done, 1100));
  const catalogResponse = await fetch("/api/v2/catalog/" + slug + "?" + query + "&shippingType=delivery", { headers });
  const found = catalogResponse.status === 200 ? (await catalogResponse.json()).payload.foundPlace : null;
  const sections = (menu.payload.categories || []).filter(
    (category) => category.id != null && category.name && (category.items || []).length
  );
  const items = [];
  for (const category of sections) {
    for (const item of category.items) {
      if (items.length >= 30) break;
      items.push({
        section: category.name,
        id: item.id,
        name: item.name,
        price: Number(item.decimalPromoPrice || item.decimalPrice),
        oldPrice: item.decimalPromoPrice ? Number(item.decimalPrice) : null,
        weight: item.weight || null,
        available: item.available !== false,
        needsOptions: (item.optionsGroups || []).length > 0,
      });
    }
  }
  const place = found && found.place;
  const location = found && found.locationParams;
  return {
    status: "ok",
    data: {
      place: place
        ? {
            name: place.name,
            rating: place.rating,
            ratingCount: Number(place.ratingCount),
            minOrder: place.minimalOrderPrice,
          }
        : null,
      delivery: location
        ? {
            available: location.available,
            minutes: location.deliveryTime
              ? location.deliveryTime.min + "–" + location.deliveryTime.max
              : null,
            fees: ((location.shippingInfo || [])[0] || { thresholds: [] }).thresholds.map(
              (threshold) => threshold.name + ": " + threshold.value
            ),
          }
        : null,
      sections: sections.map((category) => category.name),
      items,
    },
  };
}`,
  service: "yandex-eda",
});
