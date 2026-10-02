import { z } from "zod";
import type {
  PriceCondition,
  PriceSource,
  priceExtractorSchema,
} from "@shared/subscriptions/price";

/**
 * The price on a product page, read by code alone: the markup shops publish
 * for search engines, in this order — JSON-LD `Product` offers, the
 * `product:price:amount` / `og:price:amount` meta tags, then `itemprop="price"`.
 * No page text is read, so nothing the page says reaches a model; only the
 * number, its currency and the product's own name and SKU, which pin the
 * product a later check must find again.
 */

export interface PriceReading {
  readonly amount: number;
  readonly currency: string | null;
  readonly extractor: z.output<typeof priceExtractorSchema>;
  readonly kind: "price";
  readonly name: string | null;
  readonly sku: string | null;
}

/**
 * A page's price, or why there is none: none of the markup is there, or it
 * names several products with different prices (a catalogue, not one
 * product).
 */
export type PriceRead =
  | PriceReading
  | { readonly kind: "no-price" }
  | { readonly kind: "several-products" };

/** «7 490,00 ₽», «7,490.00», «7.490,00», «1 500»: the amount, if any. */
export function amountFromText(text: string) {
  // «7 490 – 9 990» is a range, not one amount: one group of digits only.
  const groups = text.match(/\d(?:[\d.,\s\u00a0\u202f]*\d)?/gu) ?? [];
  if (groups.length !== 1) return undefined;
  let digits = text.replaceAll(/[^\d.,]/gu, "");
  const comma = digits.lastIndexOf(",");
  const dot = digits.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    // The separator that comes last is the decimal one.
    digits =
      comma > dot
        ? digits.replaceAll(".", "").replace(",", ".")
        : digits.replaceAll(",", "");
  } else if (comma !== -1) {
    digits = /^\d{1,3}(?:,\d{3})+$/u.test(digits)
      ? digits.replaceAll(",", "")
      : digits.replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/u.test(digits)) {
    digits = digits.replaceAll(".", "");
  }
  if (!/^\d+(?:\.\d+)?$/u.test(digits)) return undefined;
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

/** A price as JSON-LD gives it: a number, or text a shop formatted. */
const amountSchema = z
  .union([
    z
      .number()
      .transform((amount) =>
        Number.isFinite(amount) && amount > 0 ? amount : undefined
      ),
    z.string().transform(amountFromText),
  ])
  .optional()
  .catch(undefined);

const currencyAliases = new Map([
  ["$", "USD"],
  ["€", "EUR"],
  ["₽", "RUB"],
  ["RUR", "RUB"],
  ["РУБ", "RUB"],
]);

/** An ISO currency code, from a code, an alias or a sign. */
function currencyCode(text: string | undefined) {
  if (text === undefined) return null;
  const code = text.trim().toUpperCase().replace(/\.$/u, "");
  const known = currencyAliases.get(code) ?? code;
  return /^[A-Z]{3}$/u.test(known) ? known : null;
}

/** A name or SKU off the page, as short plain text. */
function plainLabel(text: string | undefined, limit: number) {
  const plain = (text ?? "")
    .replaceAll(/[\p{Cc}\p{Cf}<>]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return plain.length > 0 ? plain : null;
}

const textSchema = z
  .union([z.string(), z.number().transform(String)])
  .optional()
  .catch(undefined);

const currencySchema = z.string().optional().catch(undefined);

function listOf<Item extends z.ZodType>(item: Item) {
  return z
    .union([
      z.array(item.optional().catch(undefined)),
      item.transform((one) => [one]),
    ])
    .optional()
    .catch(undefined);
}

const optionalTextSchema = z.string().optional().catch(undefined);

const offerSchema = z.looseObject({
  availability: optionalTextSchema,
  itemCondition: optionalTextSchema,
  lowPrice: amountSchema,
  price: amountSchema,
  priceCurrency: currencySchema,
});

const typeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .catch(undefined);

const productSchema = z.looseObject({
  "@type": typeSchema,
  gtin13: textSchema,
  name: textSchema,
  offers: listOf(offerSchema),
  productID: textSchema,
  sku: textSchema,
});

/**
 * The top-level nodes of a JSON-LD block: the block itself, its array or
 * its `@graph`. Nested ones (`isRelatedTo`, `isSimilarTo`) are other
 * products a page recommends, so they are never walked into.
 */
const nodeSchema = z.looseObject({
  "@graph": z.array(z.unknown()).optional().catch(undefined),
});

const blockSchema = z
  .union([z.array(nodeSchema.catch({})), nodeSchema.transform((one) => [one])])
  .catch([]);

function isProduct(types: z.output<typeof typeSchema>) {
  return [types ?? []]
    .flat()
    .some((type) => type.replace(/^.*[/#]/u, "").toLowerCase() === "product");
}

/** Stock and condition that make an offer not the product's own price. */
const unavailable = /outofstock|soldout|discontinued|preorder|presale/iu;
const notNew = /used|refurbished|damaged/iu;

/**
 * A product's one price: of its offers in stock and new, by `price`, else
 * the lowest of an aggregate offer. Offers at several prices (sellers,
 * sizes, colours) give none: a new cheap seller or variant would read as a
 * drop. `undefined` for no price, `several` for offers that disagree.
 */
function offerPrice(offers: z.output<typeof productSchema>["offers"]) {
  const priced = (offers ?? []).flatMap((offer) => {
    if (!offer) return [];
    if (unavailable.test(offer.availability ?? "")) return [];
    if (notNew.test(offer.itemCondition ?? "")) return [];
    const amount = offer.price ?? offer.lowPrice;
    return amount === undefined
      ? []
      : [{ amount, currency: currencyCode(offer.priceCurrency) }];
  });
  const [first] = priced;
  if (!first) return undefined;
  return priced.every(
    (offer) =>
      offer.amount === first.amount && offer.currency === first.currency
  )
    ? first
    : ("several" as const);
}

function parsedJson(text: string) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function jsonLdProducts(html: string) {
  const products: PriceReading[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/giu
  )) {
    const nodes: unknown[] = [];
    for (const node of blockSchema.parse(parsedJson(match[1] ?? ""))) {
      nodes.push(node, ...(node["@graph"] ?? []));
    }
    for (const node of nodes) {
      const product = productSchema.safeParse(node).data;
      if (!product || !isProduct(product["@type"])) continue;
      const price = offerPrice(product.offers);
      if (!price) continue;
      if (price === "several") return "several-products" as const;
      products.push({
        ...price,
        extractor: "jsonld",
        kind: "price",
        name: plainLabel(product.name, 120),
        sku: plainLabel(product.sku ?? product.productID ?? product.gtin13, 64),
      });
    }
  }
  return products;
}

const htmlEntities = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

function decodeEntities(text: string) {
  return text.replaceAll(
    /&(#x[\da-f]+|#\d+|\w+);/giu,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) {
        return htmlEntities.get(entity.toLowerCase()) ?? whole;
      }
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
  );
}

/** The attributes of one tag, lower-cased names, entities decoded. */
function attributes(tag: string) {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu
  )) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || found.has(name)) continue;
    found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return found;
}

function metaContent(html: string) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/giu)].map((match) =>
    attributes(match[0])
  );
  return (...names: readonly string[]) =>
    tags
      .find((tag) =>
        names.includes(
          (tag.get("property") ?? tag.get("name") ?? "").toLowerCase()
        )
      )
      ?.get("content");
}

/** The product's name a page gives search engines (`og:title`). */
function pageTitle(html: string) {
  return plainLabel(metaContent(html)("og:title"), 120);
}

function metaPrice(html: string): PriceReading | undefined {
  const content = metaContent(html);
  const amount = amountFromText(
    content("product:price:amount", "og:price:amount") ?? ""
  );
  if (amount === undefined) return undefined;
  return {
    amount,
    currency: currencyCode(
      content("product:price:currency", "og:price:currency")
    ),
    extractor: "meta",
    kind: "price",
    name: plainLabel(content("og:title"), 120),
    sku: plainLabel(content("product:retailer_item_id"), 64),
  };
}

function itempropPrices(html: string, name: string | null) {
  const tags = [...html.matchAll(/<[a-z][^>]*\bitemprop\s*=[^>]*>/giu)].map(
    (match) => attributes(match[0])
  );
  const currency = tags.find(
    (tag) => tag.get("itemprop")?.toLowerCase() === "pricecurrency"
  );
  return tags.flatMap((tag): PriceReading[] => {
    if (tag.get("itemprop")?.toLowerCase() !== "price") return [];
    const amount = amountFromText(tag.get("content") ?? "");
    if (amount === undefined) return [];
    return [
      {
        amount,
        currency: currencyCode(currency?.get("content")),
        extractor: "itemprop",
        kind: "price",
        name,
        sku: null,
      },
    ];
  });
}

/**
 * One product's price, or why there is none. Several readings of one kind
 * that disagree are a page of several products: no guess is made which one
 * the person meant.
 */
function single(readings: readonly PriceReading[]): PriceRead | undefined {
  const [first] = readings;
  if (!first) return undefined;
  const differs = readings.some(
    (reading) =>
      reading.amount !== first.amount ||
      reading.currency !== first.currency ||
      (reading.name !== null &&
        first.name !== null &&
        reading.name !== first.name)
  );
  return differs ? { kind: "several-products" } : first;
}

export function readPrice(html: string): PriceRead {
  const products = jsonLdProducts(html);
  if (products === "several-products") return { kind: products };
  const fromJsonLd = single(products);
  if (fromJsonLd !== undefined) return fromJsonLd;
  const fromMeta = metaPrice(html);
  if (fromMeta) return fromMeta;
  return single(itempropPrices(html, pageTitle(html))) ?? { kind: "no-price" };
}

/**
 * Whether a reading is of the product the watch is pinned to: the same
 * markup, currency, SKU and name wherever the first reading had them. A
 * shop that renamed the product or sends the link to another page breaks
 * the watch rather than raising a false alarm.
 */
export function sameProduct(source: PriceSource, reading: PriceReading) {
  return (
    reading.extractor === source.extractor &&
    reading.currency === source.currency &&
    (source.sku === null || reading.sku === source.sku) &&
    (source.name === null || reading.name === source.name)
  );
}

export function conditionMet(
  condition: PriceCondition,
  amount: number,
  baseline: number
) {
  if (condition.kind === "below") return amount < condition.amount;
  return (
    amount < baseline &&
    ((baseline - amount) / baseline) * 100 >= condition.percent
  );
}

const amountFormat = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});

/** «7 490 RUB»: an amount as the report names it. */
export function priceLabel(amount: number, currency: string | null) {
  return `${amountFormat.format(amount)}${currency ? ` ${currency}` : ""}`;
}

/** What the person asked to hear about, as a report names it. */
export function conditionLabel(
  condition: PriceCondition,
  currency: string | null
) {
  if (condition.kind === "below") {
    return `below ${priceLabel(condition.amount, currency)}`;
  }
  return condition.percent > 0
    ? `a drop of at least ${String(condition.percent)}%`
    : "any drop";
}

const multipliers = new Map([
  ["k", 1_000],
  ["к", 1_000],
  ["млн", 1_000_000],
  ["т", 1_000],
  ["тр", 1_000],
  ["тыс", 1_000],
  ["тысяч", 1_000],
  ["тысячи", 1_000],
  ["тысяча", 1_000],
]);

/**
 * The numbers in the person's words, as amounts: «8к», «8 000», «8000р»,
 * «8,5 тыс», «10%». A threshold the model passes counts only when it is one
 * of these, so a page or an earlier report cannot plant one. Links are left
 * out: their digits are no amount the person named.
 */
export function amountsSaid(words: readonly string[]) {
  const found = new Set<number>();
  for (const text of words) {
    const plain = text.normalize("NFKC").replaceAll(/https?:\/\/\S+/giu, " ");
    for (const match of plain.matchAll(
      /(?<![\p{L}\d])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)|\d+(?!\d))(?:[.,](\d+))?\s*(k|к|млн|тысячи|тысяча|тысяч|тыс|тр|т)?\.?\s*(?:руб\p{L}*|р|₽)?(?!\p{L})/giu
    )) {
      const whole = (match[1] ?? "").replaceAll(/\s/gu, "");
      const fraction = match[2];
      const base = Number(fraction ? `${whole}.${fraction}` : whole);
      if (!Number.isFinite(base)) continue;
      found.add(base);
      // «7,490» with a comma of thousands reads as 7 490 as well.
      if (fraction?.length === 3) found.add(Number(`${whole}${fraction}`));
      const unit = match[3]?.toLowerCase();
      const multiplier = unit === undefined ? undefined : multipliers.get(unit);
      if (multiplier !== undefined) found.add(Math.round(base * multiplier));
    }
  }
  return found;
}
