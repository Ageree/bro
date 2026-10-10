import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { marketRun } from "./prologue";

/**
 * A card's url as search returns it: `/card/<slug>/<sku>?do-waremd5=<offer>`,
 * with or without the origin. Only Market's own card paths pass, so the
 * page is always one of Market's and the call never leaves its origin.
 */
export const marketCardUrl = z
  .string()
  .max(500)
  .regex(
    /^(https:\/\/market\.yandex\.ru)?\/card\/[^/?#\s]+\/\d+(\?do-waremd5=[\w-]+)?$/u
  )
  .describe(
    "The card's url from market.search: /card/<slug>/<sku>?do-waremd5=<offerId>."
  );

/**
 * The card's purchase option, read from the page's `buyOption` patch: the
 * offer, its price and the token a cart add needs. Source for the body of
 * an operation that runs on a card page, which defines `doc` first.
 */
export const buyOptionSource = String.raw`let buy = null;
doc.querySelectorAll('noframes[data-apiary="patch"]').forEach((n) => {
  if (buy || !n.textContent.includes('"buyOption"')) return;
  try {
    const c = JSON.parse(n.textContent).collections;
    if (c && c.buyOption) buy = Object.values(c.buyOption)[0];
  } catch (e) {}
});`;

/**
 * One card of Market: price, card price, stock, rating, the seller and the
 * delivery price. A card is one seller (schema.org `offerCount = 1`): other
 * sellers of the same product are other cards, found by a search.
 */
export const marketProductOperation = defineYandexOperation({
  about:
    "Reads one Yandex Market card: title, price (and the price with the Yandex Pay card), stock, rating, shop with its rating, delivery text and price, and the main specs. One card is one seller; other sellers of the same product are other cards from market.search. Argument: url, the card's url from market.search.",
  access: "read",
  args: z.object({ url: marketCardUrl }),
  id: "market.product",
  origin: "https://market.yandex.ru/",
  result: z.object({
    available: z.boolean(),
    brand: z.string().nullable(),
    delivery: z
      .object({ price: z.number().nullable(), text: z.string() })
      .nullable(),
    flags: z.array(z.string()),
    maxQty: z.number().nullable(),
    minQty: z.number().nullable(),
    offerId: z.string().nullable(),
    oldPrice: z.number().nullable(),
    price: z.number().nullable(),
    priceCard: z.number().nullable(),
    rating: z
      .object({ count: z.number().nullable(), value: z.number().nullable() })
      .nullable(),
    shop: z.object({
      name: z.string().nullable(),
      rating: z.string().nullable(),
    }),
    sku: z.string().nullable(),
    specs: z.array(z.object({ name: z.string(), value: z.string() })),
    title: z.string(),
    url: z.string(),
  }),
  run: marketRun(String.raw`const path = args.url.replace(/^https:\/\/market\.yandex\.ru/, "");
if (!/^\/card\/[^/?#]+\/\d+/.test(path))
  return fail("bad_argument", "url must look like /card/<slug>/<sku>?do-waremd5=<offerId>");
const pg = await getPage(path);
if (pg.error) return pg.error;
const { doc } = pg;
const text = (sel) => {
  const e = doc.querySelector(sel);
  return e ? e.textContent.replace(/\s+/g, " ").trim() : null;
};
const ldText = [...doc.querySelectorAll('script[type="application/ld+json"]')]
  .map((s) => s.textContent)
  .find((t) => /"@type"\s*:\s*"Product"/.test(t) && t.includes('"offers"'));
if (!ldText) return fail("not_found", "no Product JSON-LD (card removed or not a card page)");
const ld = JSON.parse(ldText);
${buyOptionSource}
const specBox = doc.querySelector('[data-auto="specs-list-minimal"]');
let specs = [];
if (specBox) {
  specBox.querySelectorAll("script,noframes,svg").forEach((x) => x.remove());
  const leaf = [...specBox.querySelectorAll("*")]
    .filter((x) => !x.children.length)
    .map((x) => x.textContent.trim())
    .filter((t) => t && t !== "Все характеристики" && !t.startsWith("Внешний вид товаров"));
  for (let i = 0; i + 1 < leaf.length; i += 2)
    specs.push({ name: leaf[i], value: leaf[i + 1] });
}
const dBox = doc.querySelector('[data-auto="snippet-delivery-options"]');
let delivery = null;
if (dBox) {
  dBox.querySelectorAll("script,noframes,svg").forEach((x) => x.remove());
  const t = [...dBox.querySelectorAll("*")]
    .filter((x) => !x.children.length)
    .map((x) => x.textContent.trim())
    .filter(Boolean)
    .join(" ");
  const pm = t.match(/(\d[\d ]*)\s*₽/);
  delivery = {
    text: t.slice(0, 160),
    price: pm ? Number(pm[1].replace(/\s/g, "")) : null,
  };
}
const rate = ld.aggregateRating;
return ok({
  title: ld.name,
  brand: ld.brand || null,
  sku: ld.sku || null,
  offerId: buy ? buy.offerId : null,
  available: /InStock/.test(ld.offers.availability),
  price: buy ? buy.price.value : ld.offers.price ?? null,
  priceCard:
    buy && buy.analytics && buy.analytics.yaBankPrice
      ? Number(buy.analytics.yaBankPrice)
      : null,
  oldPrice: buy && buy.basePrice ? buy.basePrice.value : null,
  minQty: buy ? buy.minimum ?? null : null,
  maxQty: buy ? buy.maximum ?? null : null,
  rating: rate
    ? { value: rate.ratingValue ?? null, count: rate.ratingCount ?? null }
    : null,
  shop: {
    name: buy ? buy.supplierName ?? null : text('[data-auto="shop-info-title"]'),
    rating: text('[data-auto="shop-info-rating"]'),
  },
  delivery,
  specs: specs.slice(0, 8),
  flags: buy ? buy.flags || [] : [],
  url: ld.url + (buy ? "?do-waremd5=" + buy.offerId : ""),
});`),
  service: "market",
});
