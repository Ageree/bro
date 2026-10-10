import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { marketRun } from "./prologue";

const priceSchema = z.number().nullable();

/**
 * Market's search: up to ten offers for a query, cheapest or most popular
 * first, from the search resolver the search page calls. Every result is one
 * offer: the same product from another seller is another offer here too.
 */
export const marketSearchOperation = defineYandexOperation({
  about:
    "Searches Yandex Market for a product: up to 10 offers with price, rating, the earliest delivery date and a url for market.product. One card is one seller; the same product from another seller is another offer in this list. Arguments: query (text), sort (popular, price_asc, price_desc or rating), priceFrom and priceTo in rubles, limit (1-10).",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(10).optional(),
    priceFrom: z.number().int().min(0).max(10_000_000).optional(),
    priceTo: z.number().int().min(0).max(10_000_000).optional(),
    query: z.string().trim().min(1).max(200),
    sort: z.enum(["popular", "price_asc", "price_desc", "rating"]).optional(),
  }),
  id: "market.search",
  origin: "https://market.yandex.ru/",
  result: z.object({
    count: z.number().int(),
    items: z
      .array(
        z.object({
          delivery: z
            .object({
              from: z.string().nullable(),
              text: z.string(),
              to: z.string().nullable(),
              type: z.string().nullable(),
            })
            .nullable(),
          flags: z.array(z.string()),
          offerId: z.string(),
          oldPrice: priceSchema,
          price: priceSchema,
          priceCard: priceSchema,
          rating: z
            .object({
              bought: z.number().nullable(),
              count: z.number().nullable(),
              value: z.number().nullable(),
            })
            .nullable(),
          shop: z.string().nullable(),
          sku: z.string().nullable(),
          title: z.string(),
          url: z.string(),
        })
      )
      .max(10),
    query: z.string(),
    total: z.number().nullable(),
  }),
  run: marketRun(String.raw`const HOW = {
  popular: "dpop",
  price_asc: "aprice",
  price_desc: "dprice",
  rating: "rating",
};
const limit = args.limit || 10;
const how = HOW[args.sort] || "dpop";
const filters = {};
if (args.priceFrom != null) filters.pricefrom = String(args.priceFrom);
if (args.priceTo != null) filters.priceto = String(args.priceTo);
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
const path = "/search?text=" + encodeURIComponent(args.query) + "&how=" + how;
const num = (v) =>
  v == null || v === "" ? null : Number(String(v).replace(/\s/g, ""));
const nano = (v) => (v == null ? null : Math.round(Number(v) / 1e7));
const items = [];
const seen = new Set();
let total = null;
for (let page = 1; page <= 3 && items.length < limit; page++) {
  if (page > 1) await sleep(1100);
  const r = await fetch(
    "/api/resolve/?r=../../../b2c-shared/src/resolvers/search/resolvePoorRemoteSearchApphost:resolvePoorRemoteSearchApphost",
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        sk,
        "x-market-page-id": "market:search",
        "x-market-apphost-target": "SEARCH",
        "x-market-core-service": "mf-search-desktop",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({
        params: [
          {
            text: args.query,
            how,
            searchPlace: "__standalone__",
            filters,
            page,
            withResults: true,
            viewtype: "list",
            urlParams: {},
            noSearchFilters: "1",
            noSearchResults: false,
            omitFilters: false,
          },
        ],
        path,
      }),
    }
  );
  if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
    return fail("captcha", "search resolver");
  if (r.status === 401 || r.status === 403)
    return fail("not_signed_in", "resolver " + r.status);
  if (!r.ok) return fail("http_" + r.status, "search resolver");
  const j = await r.json();
  const d = j.results && j.results[0] && j.results[0].data;
  const col = d && d.search && d.search.collections;
  if (!col || !Array.isArray(col.widgets))
    return fail("bad_response", JSON.stringify(j).slice(0, 200));
  const vsr = Object.values(col.visibleSearchResult || {})[0];
  if (vsr) total = vsr.total ?? null;
  let added = 0;
  for (const w of col.widgets) {
    if (w.type !== "product" || !w.product) continue;
    const p = w.product.productPayload;
    const cb = p.cartButton || {};
    if (!cb.offerId || seen.has(cb.offerId) || items.length >= limit) continue;
    seen.add(cb.offerId);
    added++;
    const price = num(cb.price && cb.price.valueFmt);
    const old = nano(cb.oldPrice);
    const ap = p.price && p.price.actualPrice;
    const cardPrice =
      ap && ap.suffix === "YA_PAY" ? num(ap.amount.intPart) : null;
    const bought = ((p.productRating && p.productRating.descriptionList) || [])
      .map((s) => s.match(/^(\d+)\s+купил/))
      .find(Boolean);
    const opt =
      p.deliveryInfo && p.deliveryInfo.options && p.deliveryInfo.options[0];
    const bm = opt && opt.baobabModel;
    const sku =
      p.offerParams &&
      (p.offerParams.oskuId || p.offerParams.legacyOfferParams.skuId);
    items.push({
      offerId: cb.offerId,
      sku: sku || null,
      title: p.title.value,
      price,
      priceCard: cardPrice && cardPrice !== price ? cardPrice : null,
      oldPrice: old && old > price ? old : null,
      shop: (p.signals && p.signals.shop && p.signals.shop.text.text) || null,
      rating: p.rating
        ? {
            value: p.rating.ratingValue ?? null,
            count: p.rating.ratingCount ?? null,
            bought: bought ? Number(bought[1]) : null,
          }
        : null,
      delivery: bm
        ? {
            text: bm.deliveryText.replace(/[\s ]*\*[\s ]*/g, ", "),
            type: bm.deliveryType ?? null,
            from: bm.deliveryDateFrom ?? null,
            to: bm.deliveryDateTo ?? null,
          }
        : null,
      flags: [
        p.signals && p.signals.crossborder ? "crossborder" : null,
        cb.isSponsored ? "sponsored" : null,
        p.signals && p.signals.resale ? "resale" : null,
        p.signals && p.signals.lastStock ? p.signals.lastStock.text.text : null,
      ].filter(Boolean),
      url:
        "/card/" + p.offerParams.slug + "/" + sku + "?do-waremd5=" + cb.offerId,
    });
  }
  if (!added) break;
}
return ok({ query: args.query, total, count: items.length, items });`),
  service: "market",
});
