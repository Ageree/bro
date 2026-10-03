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
 * A page's price, or why there is none: none of the markup is there, it
 * names several products with different prices (a catalogue, not one
 * product), or the product is out of stock (`unavailable`), whatever other
 * markup on the page may still say.
 */
export type PriceRead =
  | PriceReading
  | { readonly kind: "no-price" }
  | { readonly kind: "several-products" }
  | { readonly kind: "unavailable" };

/** «7 490,00 ₽», «7,490.00», «7.490,00», «1 500»: the amount, if any. */
export function amountFromText(text: string) {
  // A price is short; a long text is no price, and is never scanned.
  if (text.length > 64) return undefined;
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

/**
 * A price as JSON-LD gives it: a number, or text. Plain digits with a dot
 * are schema.org's decimal number («990.000» is 990), never thousands; other
 * text a shop formatted («7 490,00 ₽») is read as a shop writes it.
 */
const amountSchema = z
  .union([
    z
      .number()
      .transform((amount) =>
        Number.isFinite(amount) && amount > 0 ? amount : undefined
      ),
    z.string().transform((text) => {
      const plain = text.trim();
      if (!/^\d{1,15}(?:\.\d{1,15})?$/u.test(plain))
        return amountFromText(text);
      const amount = Number(plain);
      return amount > 0 ? amount : undefined;
    }),
  ])
  .optional()
  .catch(undefined);

const countSchema = z
  .union([z.number(), z.string().transform(Number)])
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
    .slice(0, limit * 4)
    .replaceAll(/[\p{Cc}\p{Cf}<>]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return plain.length > 0 ? plain : null;
}

/** A phone number: ten digits or more, however grouped. */
const phonePattern = /\+?\d[\d\s()\u00a0-]{8,}\d/gu;

/**
 * A product's name as a report may carry it. On a marketplace a seller
 * writes the name, so links, domains and phone numbers in it are cut: the
 * report turn reads it as data, and nothing in it may send the person
 * anywhere.
 */
function productName(text: string | undefined) {
  // Full-width «．» and digits are a dot and digits like any other.
  const label = plainLabel(
    text
      ?.slice(0, 800)
      .normalize("NFKC")
      // «shop。ru», «shop[.]ru», «shop(.)ru» are shop.ru.
      .replaceAll(/\s*(?:[。｡]|\[\.\]|\(\.\)|\[dot\]|\(dot\))\s*/giu, "."),
    200
  );
  if (label === null) return null;
  return plainLabel(
    label
      .replaceAll(/\S*(?:https?:\/\/|www\.|(?:t|wa)\.me\/)\S*/giu, " ")
      .replaceAll(/(?<![\p{L}\d])@[\p{L}\d_.]+/gu, " ")
      .replaceAll(
        /(?<![\p{L}\d])[\p{L}\d-]+(?:\.[\p{L}\d-]+)*\.(?:[a-z]{2,24}|рф|рус|москва|онлайн|сайт|орг|дети)(?![\p{L}\d])/giu,
        " "
      )
      .replaceAll(phonePattern, (phone) =>
        phone.replaceAll(/\D/gu, "").length >= 10 ? " " : phone
      ),
    120
  );
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
  highPrice: amountSchema,
  itemCondition: optionalTextSchema,
  lowPrice: amountSchema,
  offerCount: countSchema,
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
  offers: listOf(z.unknown()),
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

function isProduct(types: z.output<typeof typeSchema>) {
  return [types ?? []]
    .flat()
    .some((type) => type.replace(/^.*[/#]/u, "").toLowerCase() === "product");
}

/** Stock and condition that make an offer not the product's own price. */
const unavailable = /outofstock|soldout|discontinued|preorder|presale/iu;
const notNew = /used|refurbished|damaged/iu;

/**
 * An offer's one amount: its `price`, else an aggregate offer's `lowPrice`,
 * when that is the only price it spans. «from 5 000» over twelve sellers up
 * to 9 000 is `several`, whatever `price` it names too: a new cheap seller
 * would read as a drop.
 */
function offerAmount(offer: z.output<typeof offerSchema>) {
  const amount = offer.price ?? offer.lowPrice;
  if (amount === undefined) return undefined;
  const spans =
    (offer.lowPrice !== undefined && offer.lowPrice !== amount) ||
    (offer.highPrice !== undefined && offer.highPrice !== amount) ||
    // «many», «12 sellers» is no count of one.
    (offer.offerCount !== undefined && !(offer.offerCount <= 1));
  return spans ? ("several" as const) : amount;
}

/**
 * The most a page's JSON-LD is read for: blocks, nodes in all of them and
 * offers of one product. A product page has a handful; past these the page
 * is a catalogue or a trap, and reading on would hold the process.
 */
const maximumJsonLdBlocks = 100;
const maximumJsonLdNodes = 1_000;
const maximumOffers = 1_000;

/**
 * A product's one price: of its new offers, by `price`, else a one-price
 * aggregate offer. New offers at several prices (sellers, sizes, colours)
 * give none, sold out or not: a size back in stock at another price is no
 * drop. Of one price, it counts while some offer of it is in stock;
 * `unavailable` when every offer is sold out, `undefined` for no price.
 */
function offerPrice(offers: z.output<typeof productSchema>["offers"]) {
  if ((offers?.length ?? 0) > maximumOffers) return "several" as const;
  const listed = (offers ?? []).flatMap((raw) => {
    const offer = offerSchema.safeParse(raw).data;
    return offer ? [offer] : [];
  });
  const priced = [];
  for (const offer of listed) {
    if (notNew.test(offer.itemCondition ?? "")) continue;
    const amount = offerAmount(offer);
    if (amount === "several") return amount;
    if (amount === undefined) continue;
    priced.push({
      amount,
      currency: currencyCode(offer.priceCurrency),
      inStock: !unavailable.test(offer.availability ?? ""),
    });
  }
  const [first] = priced;
  if (
    first &&
    priced.some(
      (offer) =>
        offer.amount !== first.amount || offer.currency !== first.currency
    )
  ) {
    return "several" as const;
  }
  if (
    listed.length > 0 &&
    listed.every((offer) => unavailable.test(offer.availability ?? ""))
  ) {
    return "unavailable" as const;
  }
  const inStock = priced.find((offer) => offer.inStock);
  return inStock
    ? { amount: inStock.amount, currency: inStock.currency }
    : undefined;
}

function parsedJson(text: string) {
  try {
    return z.unknown().parse(JSON.parse(text));
  } catch {
    // Not JSON, or too deep for the parser.
    return null;
  }
}

const nodeListSchema = z.array(z.unknown());

/**
 * The top-level nodes of the page's JSON-LD blocks and their `@graph`s, in
 * order, or `too-many` past the cap: a loop, not a spread, so a `@graph` of
 * 700 000 items cannot overflow the stack.
 */
function jsonLdNodes(blocks: readonly string[]) {
  const nodes: unknown[] = [];
  for (const block of blocks) {
    const parsed = parsedJson(block);
    const top = nodeListSchema.safeParse(parsed).data ?? [parsed];
    if (nodes.length + top.length > maximumJsonLdNodes) {
      return "too-many" as const;
    }
    for (const item of top) {
      const graph = nodeSchema.safeParse(item).data?.["@graph"] ?? [];
      if (nodes.length + 1 + graph.length > maximumJsonLdNodes) {
        return "too-many" as const;
      }
      nodes.push(item);
      for (const node of graph) nodes.push(node);
    }
  }
  return nodes;
}

/** A label every one of `labels` agrees with, or none to tell apart by. */
function labelFits(label: string | null, labels: ReadonlySet<string>) {
  return (
    label === null ||
    labels.size === 0 ||
    (labels.size === 1 && labels.has(label))
  );
}

/**
 * Whether a sold-out node is the product in stock, by name and SKU: a
 * missing one tells nothing apart. `names` and `skus` are those of the
 * products in stock, so each node is one lookup, not a pass over them all.
 */
function sameProductInStock(
  gone: Pick<PriceReading, "name" | "sku">,
  names: ReadonlySet<string>,
  skus: ReadonlySet<string>
) {
  return labelFits(gone.name, names) && labelFits(gone.sku, skus);
}

/**
 * The page's products, decided once all are read: a sold-out node of the
 * product in stock (a variant, a seller) leaves its price, a sold-out node
 * of another product makes the page as ambiguous as a catalogue, and only
 * a page whose every product is sold out is `unavailable`.
 */
function jsonLdProducts(blocks: readonly string[]) {
  const nodes = jsonLdNodes(blocks);
  if (nodes === "too-many") return "several-products" as const;
  const products: PriceReading[] = [];
  const soldOut: Pick<PriceReading, "name" | "sku">[] = [];
  for (const node of nodes) {
    const product = productSchema.safeParse(node).data;
    if (!product || !isProduct(product["@type"])) continue;
    const price = offerPrice(product.offers);
    if (!price) continue;
    if (price === "several") return "several-products" as const;
    const labels = {
      name: productName(product.name),
      sku: plainLabel(product.sku ?? product.productID ?? product.gtin13, 64),
    };
    if (price === "unavailable") {
      soldOut.push(labels);
      continue;
    }
    products.push({ ...price, ...labels, extractor: "jsonld", kind: "price" });
  }
  if (products.length === 0) {
    // A sold-out product is not priced by other markup on its page.
    return soldOut.length > 0 ? ("unavailable" as const) : products;
  }
  const names = new Set(products.flatMap(({ name }) => (name ? [name] : [])));
  const skus = new Set(products.flatMap(({ sku }) => (sku ? [sku] : [])));
  return soldOut.every((gone) => sameProductInStock(gone, names, skus))
    ? products
    : ("several-products" as const);
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

/** The most of a tag whose attributes are read: a real one is far shorter. */
const maximumTagLength = 4_096;

/** Lower-cases ASCII letters only, so every index stays the same. */
function asciiLower(text: string) {
  // One native pass, unless a letter grew in lower case («İ» is two units).
  const lower = text.toLowerCase();
  return lower.length === text.length
    ? lower
    : text.replaceAll(/[A-Z]+/gu, (letters) => letters.toLowerCase());
}

/**
 * Where a tag opened at `open` ends: the first `>` outside a quoted value
 * (`content="a > b"` is one value) within the tag's first 4 KB, or -1 when
 * a quote does not close or no `>` stands outside one there.
 */
function quotedTagEnd(html: string, open: number) {
  const stop = Math.min(html.length, open + 1 + maximumTagLength);
  let quote = "";
  for (let index = open + 1; index < stop; index += 1) {
    const character = html[index];
    if (quote !== "") {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

/** The most meta and itemprop tags read: a product page has dozens. */
const maximumMarkedTags = 2_000;

const tagName = /[a-z][a-z\d-]{0,31}/uy;

/**
 * What the price is read from, in one linear pass over the page, as
 * `pageText` reads one (`agent/lib/sandbox/router.ts`): the JSON-LD blocks,
 * the meta tags' attributes and those of tags marked `itemprop`. A page is a
 * stranger's text, and one made to stall a regular expression, or to hand
 * over a million tags, would stall the whole process: a deadline cannot stop
 * synchronous code. So no other tag is kept. Past the JSON-LD caps the page
 * is `overflow`, no product page; past the meta and itemprop cap those are
 * no longer kept (`markedOverflow`: 500 reviews in microdata are no
 * catalogue), but JSON-LD is read on. A comment is skipped; a script's body runs to
 * its own end tag, as JSON-LD may hold `<` and `>`.
 */
function scanPage(html: string) {
  const lower = asciiLower(html);
  const jsonLd: string[] = [];
  const metas: ReadonlyMap<string, string>[] = [];
  const marked: ReadonlyMap<string, string>[] = [];
  const page = {
    jsonLd,
    marked,
    markedOverflow: false,
    metas,
    overflow: false,
  };
  let at = 0;
  // Where quotes are no longer followed: a window whose quotes did not end
  // the tag is never scanned for them again, so no character is twice.
  let plainUntil = 0;
  // The next «itemprop» on the page (its length when there is none left),
  // searched for again only once passed: each search starts past the last.
  let itemprop = -1;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    let close = open < plainUntil ? -1 : quotedTagEnd(html, open);
    if (close === -1) {
      // An unclosed quote, or every `>` in one: the first `>` ends the tag.
      plainUntil = Math.max(plainUntil, open + 1 + maximumTagLength);
      close = html.indexOf(">", open + 1);
    }
    // No tag after this one closes either.
    if (close === -1) break;
    at = close + 1;
    tagName.lastIndex = open + 1;
    const name = tagName.exec(lower)?.[0];
    if (name === undefined || open + 1 + name.length > close) continue;
    const inner = () =>
      html.slice(open + 1, Math.min(close, open + 1 + maximumTagLength));
    if (name === "script" || name === "style") {
      const end = lower.indexOf(`</${name}`, at);
      const stop = end === -1 ? html.length : end;
      const type = attributes(inner()).get("type")?.trim().toLowerCase();
      if (name === "script" && type === "application/ld+json") {
        if (jsonLd.length === maximumJsonLdBlocks) {
          page.overflow = true;
          break;
        }
        jsonLd.push(html.slice(at, stop));
      }
      at = stop;
      continue;
    }
    if (itemprop < open) {
      const next = lower.indexOf("itemprop", open);
      itemprop = next === -1 ? html.length : next;
    }
    const isMarked = itemprop < close;
    if (name !== "meta" && !isMarked) continue;
    if (metas.length + marked.length === maximumMarkedTags) {
      page.markedOverflow = true;
      continue;
    }
    const found = attributes(inner());
    if (name === "meta") metas.push(found);
    if (isMarked) marked.push(found);
  }
  return page;
}

const attributeName = /[^\s"'<>/=]+/uy;
const attributeEquals = /\s*=\s*/uy;
const bareValue = /[^\s>]*/uy;

/**
 * The attributes of one tag, lower-cased names, entities decoded, the first
 * of a repeated one. Read left to right without backtracking: an unclosed
 * quote runs to the end of the tag.
 */
function attributes(inner: string) {
  const found = new Map<string, string>();
  // The tag's own name comes first.
  let at = /^[^\s/>]*/u.exec(inner)?.[0].length ?? 0;
  while (at < inner.length) {
    attributeName.lastIndex = at;
    const name = attributeName.exec(inner)?.[0];
    if (name === undefined) {
      at += 1;
      continue;
    }
    at = attributeName.lastIndex;
    let value = "";
    attributeEquals.lastIndex = at;
    if (attributeEquals.exec(inner) !== null) {
      at = attributeEquals.lastIndex;
      const quote = inner[at];
      if (quote === '"' || quote === "'") {
        const end = inner.indexOf(quote, at + 1);
        const stop = end === -1 ? inner.length : end;
        value = inner.slice(at + 1, stop);
        at = stop + 1;
      } else {
        bareValue.lastIndex = at;
        value = bareValue.exec(inner)?.[0] ?? "";
        at = bareValue.lastIndex;
      }
    }
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, decodeEntities(value));
  }
  return found;
}

function metaName(tag: ReadonlyMap<string, string>) {
  return (tag.get("property") ?? tag.get("name") ?? "").toLowerCase();
}

/** The content of the first meta tag of one of `names`. */
function metaContent(
  metas: readonly ReadonlyMap<string, string>[],
  ...names: readonly string[]
) {
  return metas.find((tag) => names.includes(metaName(tag)))?.get("content");
}

const priceMetaNames = new Set(["product:price:amount", "og:price:amount"]);

/**
 * The prices of the meta tags, one reading each: several that disagree are
 * no one price (`single`).
 */
function metaPrices(
  metas: readonly ReadonlyMap<string, string>[]
): PriceReading[] {
  const currency = currencyCode(
    metaContent(metas, "product:price:currency", "og:price:currency")
  );
  const name = productName(metaContent(metas, "og:title"));
  const sku = plainLabel(metaContent(metas, "product:retailer_item_id"), 64);
  return metas.flatMap((tag): PriceReading[] => {
    if (!priceMetaNames.has(metaName(tag))) return [];
    const amount = amountFromText(tag.get("content") ?? "");
    return amount === undefined
      ? []
      : [{ amount, currency, extractor: "meta", kind: "price", name, sku }];
  });
}

function itempropPrices(
  marked: readonly ReadonlyMap<string, string>[],
  name: string | null
) {
  const currency = marked.find(
    (tag) => tag.get("itemprop")?.toLowerCase() === "pricecurrency"
  );
  return marked.flatMap((tag): PriceReading[] => {
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
        reading.name !== first.name) ||
      (reading.sku !== null && first.sku !== null && reading.sku !== first.sku)
  );
  return differs ? { kind: "several-products" } : first;
}

export function readPrice(html: string): PriceRead {
  const page = scanPage(html);
  // Past the caps a page is a catalogue or a trap: no one product's price.
  if (page.overflow) return { kind: "several-products" };
  const products = jsonLdProducts(page.jsonLd);
  if (products === "several-products" || products === "unavailable") {
    return { kind: products };
  }
  const fromJsonLd = single(products);
  if (fromJsonLd !== undefined) return fromJsonLd;
  // Too many tags to tell one price among them.
  if (page.markedOverflow) return { kind: "several-products" };
  const fromMeta = single(metaPrices(page.metas));
  if (fromMeta !== undefined) return fromMeta;
  const title = productName(metaContent(page.metas, "og:title"));
  return single(itempropPrices(page.marked, title)) ?? { kind: "no-price" };
}

/**
 * Whether a reading is of the product the watch is pinned to: the same
 * markup, currency and SKU wherever the first reading had one, and the same
 * JSON-LD product name. A page title (`og:title`, which names meta and
 * itemprop readings) is no pin: Russian shops put the price in it («…
 * купить по цене 7 490 ₽»), so it changes with the very drop a watch waits
 * for; the page the link lands on pins those (`judgePriceCheck`). A shop
 * that renamed the product or sends the link to another page breaks the
 * watch rather than raising a false alarm.
 */
export function sameProduct(source: PriceSource, reading: PriceReading) {
  return (
    reading.extractor === source.extractor &&
    reading.currency === source.currency &&
    (source.sku === null || reading.sku === source.sku) &&
    (source.extractor !== "jsonld" ||
      source.name === null ||
      reading.name === source.name)
  );
}

export function conditionMet(
  condition: PriceCondition,
  amount: number,
  baseline: number
) {
  // «до 5000» is met by a price of exactly 5 000.
  if (condition.kind === "below") return amount <= condition.amount;
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
    return `at or below ${priceLabel(condition.amount, currency)}`;
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
 * The numbers in the person's words: `amounts` — «8к», «8 000», «8000р»,
 * «8,5 тыс» — and `percents` — «10%», «на 10 процентов». A
 * threshold or a term the model passes counts only when it is one of these,
 * of its own kind, so a page or an earlier report cannot plant one and «10%»
 * never reads as a price of 10. Links are left out: their digits are no
 * amount the person named.
 */
export function amountsSaid(words: readonly string[]) {
  const amounts = new Set<number>();
  const percents = new Set<number>();
  for (const text of words) {
    const plain = text.normalize("NFKC").replaceAll(/https?:\/\/\S+/giu, " ");
    for (const match of plain.matchAll(
      /(?<![\p{L}\d])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)|\d+(?!\d))(?:[.,](\d+))?\s*(?:(%|процент\p{L}*)|(k|к|млн|тысячи|тысяча|тысяч|тыс|тр|т)?\.?\s*(?:руб\p{L}*|р|₽)?)(?!\p{L})/giu
    )) {
      const whole = (match[1] ?? "").replaceAll(/\s/gu, "");
      const fraction = match[2];
      const base = Number(fraction ? `${whole}.${fraction}` : whole);
      if (!Number.isFinite(base)) continue;
      if (match[3] !== undefined) {
        percents.add(base);
        continue;
      }
      const unit = match[4]?.toLowerCase();
      const multiplier = unit === undefined ? undefined : multipliers.get(unit);
      // «8к» is 8 000 and never 8; «7,490» with a comma of thousands is
      // 7 490, never 7.49: a threshold no price ever meets is no watch.
      if (multiplier !== undefined) {
        amounts.add(Math.round(base * multiplier));
      } else if (fraction?.length === 3) {
        amounts.add(Number(`${whole}${fraction}`));
      } else {
        amounts.add(base);
      }
    }
  }
  return { amounts, percents };
}

const termUnits = new Map([
  ["д", 1],
  ["м", 30],
  ["н", 7],
]);

/**
 * The terms in the person's words, in days: «14 дней», «2 недели»,
 * «на месяц», «неделю». A watch's term counts only when it is one of these.
 */
export function daysSaid(words: readonly string[]) {
  const days = new Set<number>();
  for (const text of words) {
    const plain = text.normalize("NFKC").replaceAll(/https?:\/\/\S+/giu, " ");
    for (const match of plain.matchAll(
      /(?<![\p{L}\d])(?:(\d{1,3})\s?(дн(?:я|ей)|день|сут(?:ки|ок)|недел[ьяиюе]|месяц(?:а|ев)?)|(неделю|месяц))(?!\p{L})/giu
    )) {
      const unit = (match[2] ?? match[3] ?? "").toLowerCase();
      const per = termUnits.get(unit.startsWith("с") ? "д" : unit.charAt(0));
      if (per === undefined) continue;
      days.add(Number(match[1] ?? "1") * per);
    }
  }
  return days;
}
