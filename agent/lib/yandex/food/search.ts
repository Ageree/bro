import { z } from "zod";
import { defineYandexOperation } from "../operations";

const coordinate = {
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
};

const edaPlace = z.object({
  available: z.boolean(),
  deliveryTime: z.string().nullable(),
  items: z.array(
    z.object({
      name: z.string(),
      price: z.number().nullable(),
      weight: z.string().nullable(),
    })
  ),
  kind: z.string(),
  price: z.string().nullable(),
  rating: z.string().nullable(),
  slug: z.string(),
  tags: z.array(z.string()),
  title: z.string(),
});

const lavkaProduct = z.object({
  amount: z.string(),
  available: z.boolean(),
  id: z.string(),
  name: z.string(),
  oldPrice: z.number().nullable(),
  price: z.number(),
});

/**
 * Restaurants and shops on Yandex Eda near a place. Eda does not know the
 * person's address, so the coordinates come from the caller (see
 * `food.lavka_addresses`).
 */
export const edaSearchOperation = defineYandexOperation({
  about:
    "Search Yandex Eda for restaurants and shops (and their dishes) for a text, near a location. Arguments: query (text), lat and lon (the person's address coordinates: take them from food.lavka_addresses), limit (1-10, default 10). Returns place slugs for food.eda_menu.",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(10).default(10),
    lat: coordinate.lat,
    lon: coordinate.lon,
    query: z.string().min(1).max(200),
  }),
  id: "food.eda_search",
  origin: "https://eda.yandex.ru/",
  result: z.object({
    places: z.array(edaPlace),
    total: z.string().nullable(),
  }),
  run: `async function (args) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Platform": "desktop_web",
    "X-App-Version": "18.50.1",
    "X-Ya-Coordinates": "latitude=" + args.lat + ",longitude=" + args.lon,
  };
  const response = await fetch("/eats/v1/full-text-search/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: args.query,
      filters: [],
      location: { longitude: args.lon, latitude: args.lat },
    }),
  });
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const body = await response.json();
  const block = (body.blocks || []).find((candidate) => candidate.type === "places");
  const places = ((block && block.payload) || []).slice(0, args.limit).map((place) => {
    const meta = (place.lower_meta || [])
      .map((entry) => entry.payload && entry.payload.text && entry.payload.text.value)
      .filter(Boolean);
    return {
      slug: place.slug,
      title: place.title,
      kind: place.business,
      available: place.available !== false,
      rating: meta.find((text) => /^\\d(\\.\\d)? \\(/.test(text)) || null,
      deliveryTime: (place.delivery && place.delivery.text) || null,
      price: (place.price_category && place.price_category.title) || null,
      tags: (place.tags || []).map((tag) => tag.title).slice(0, 4),
      items: (place.items || []).slice(0, 3).map((item) => ({
        name: item.title,
        price: item.decimal_price == null ? null : Number(item.decimal_price),
        weight: item.weight || null,
      })),
    };
  });
  return {
    status: "ok",
    data: { total: (body.header && body.header.text) || null, places },
  };
}`,
  service: "yandex-eda",
});

/**
 * Grocery products on Lavka for a text. Lavka takes the address the person
 * chose on its own page, so there is no location argument.
 */
export const lavkaSearchOperation = defineYandexOperation({
  about:
    "Search Yandex Lavka grocery products for a text, at the delivery address chosen in the person's Lavka account. Arguments: query (text), limit (1-20, default 10).",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(20).default(10),
    query: z.string().min(1).max(200),
  }),
  id: "food.lavka_search",
  origin: "https://lavka.yandex.ru/",
  result: z.object({
    found: z.number().int().min(0),
    products: z.array(lavkaProduct),
  }),
  run: `async function (args) {
  const page = window.__PAGE_PROPS__;
  const startup = window.__REACT_QUERY_STATE__.queries.find(
    (entry) => entry.queryKey[0] === "CommonStartup"
  );
  if (!startup) throw new Error("no address in the page");
  const headers = {
    "Content-Type": "application/json",
    "X-Csrf-Token-Bff": page.csrfToken,
    "X-Lavka-Web-City": String(page.pageEnv.cityId),
    "X-Lavka-Web-Locale": "ru-RU",
    "X-Requested-With": "XMLHttpRequest",
    "X-Grocery-Trusted-User": "true",
    "X-Captcha-Service": "lavka",
    "X-Captcha-Language": "ru",
  };
  const response = await fetch("/api/v1/providers/search/v3/lavka", {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: args.query,
      productsLimit: 32,
      subcategoriesLimit: 0,
      position: { location: [startup.queryKey[1], startup.queryKey[2]] },
      depotType: "regular",
      source: "manual_input",
    }),
  });
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const body = await response.json();
  const byId = new Map((body.cacheProducts || []).map((product) => [product.id, product]));
  const ids = (body.layoutItems || []).filter((item) => item.type === "good").map((item) => item.id);
  const products = ids
    .slice(0, args.limit)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((product) => ({
      id: product.id,
      name: product.longTitle || product.title,
      amount: product.amount,
      price: Number(product.currentPrice),
      oldPrice: product.fullPrice ? Number(product.fullPrice) : null,
      available: product.available !== false,
    }));
  return { status: "ok", data: { found: ids.length, products } };
}`,
  service: "yandex-lavka",
});
