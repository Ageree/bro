import * as z from "zod";
import type { BrowserVmSiteRead } from "@agent/lib/browser-vm/worker";
import type { SiteOperation } from "./operation";

type SiteCard = Extract<BrowserVmSiteRead, { ok: true }>["cards"][number];

const priceSchema = z.union([z.number(), z.string()]);

/** What the errand asks the site's results for, as the fill reads it. */
export interface SiteAsk {
  /** The page past the first one: 0 is the first. */
  readonly page: number;
  readonly priceMax: number | null;
  readonly priceMin: number | null;
  readonly sort: "price_asc" | "price_desc" | "site";
}

/** No ceiling the errand named: a range key needs one (wildberries.ru's own `100000000` kopecks). */
const noCeilingRub = 1_000_000;

/**
 * The results page with what the site applies itself (`inputs` of a
 * reviewed operation): its pairs for the order the errand asks, its keys
 * for the price bounds, its page. ozon.ru, wildberries.ru, labirint.ru and
 * petrovich.ru sorted their whole search by price so on the stand (26.10),
 * where sorting the first page's cards here gives the cheapest of the most
 * relevant ones only. `applied` says which of them the address now holds.
 */
export function withSiteInputs(
  operation: SiteOperation,
  address: string,
  ask: SiteAsk
) {
  const applied = { page: false, price: false, sort: false };
  const url = URL.parse(address);
  const { inputs } = operation;
  if (url === null || inputs === undefined) return { address, applied };
  const pairs =
    ask.sort === "price_asc"
      ? inputs.sort?.asc
      : ask.sort === "price_desc"
        ? inputs.sort?.desc
        : undefined;
  if (pairs !== undefined) {
    for (const pair of pairs.split("&")) {
      const [key = "", value = ""] = pair.split("=");
      url.searchParams.set(key, value);
    }
    applied.sort = true;
  }
  const { price } = inputs;
  if (price !== undefined && (ask.priceMin !== null || ask.priceMax !== null)) {
    if ("range" in price) {
      const scale = price.unit === "kop" ? 100 : 1;
      const write = (rub: number) =>
        (Math.round(rub) * scale).toFixed(price.decimals);
      url.searchParams.set(
        price.range,
        `${write(ask.priceMin ?? 0)};${write(ask.priceMax ?? noCeilingRub)}`
      );
      applied.price = true;
    } else {
      if (price.min !== undefined && ask.priceMin !== null) {
        url.searchParams.set(price.min, String(Math.floor(ask.priceMin)));
        applied.price = true;
      }
      if (price.max !== undefined && ask.priceMax !== null) {
        url.searchParams.set(price.max, String(Math.ceil(ask.priceMax)));
        applied.price = true;
      }
    }
  }
  if (inputs.page !== undefined && ask.page > 0) {
    url.searchParams.set(inputs.page.key, String(inputs.page.first + ask.page));
    applied.page = true;
  }
  return { address: url.href, applied };
}

/** The search without its page: two reads of one search differ only in it. */
export function withoutSitePage(operation: SiteOperation, address: string) {
  const url = URL.parse(address);
  const key = operation.inputs?.page?.key;
  if (url === null || key === undefined) return address;
  url.searchParams.delete(key);
  return url.href;
}

/** A card's price as a number of roubles, as the worker gives it: a number, or the site's text («14 090 ₽», «от 1 668»). */
export function cardPrice(price: SiteCard["price"]) {
  const given = priceSchema.safeParse(price);
  if (!given.success) return null;
  const digits = /\d[\d\s  ]*(?:[.,]\d+)?/u.exec(String(given.data))?.[0];
  if (digits === undefined) return null;
  const value = Number(digits.replace(/[\s  ]/gu, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether the cards come in the order asked, as the site sorted them: four
 * pairs in five of neighbouring prices at least (a card priced by the
 * site's own card or a discount breaks a pair now and then: ozon.ru).
 * Undefined with fewer than four priced cards: nothing to tell by.
 */
export function inSiteOrder(
  cards: readonly SiteCard[],
  sort: "price_asc" | "price_desc"
) {
  const prices = cards
    .map(({ price }) => cardPrice(price))
    .filter((price) => price !== null);
  if (prices.length < 4) return undefined;
  let kept = 0;
  for (let index = 1; index < prices.length; index += 1) {
    const [before = 0, after = 0] = [prices[index - 1], prices[index]];
    if (sort === "price_asc" ? after >= before : after <= before) kept += 1;
  }
  return kept / (prices.length - 1) >= 0.8;
}

/** The cards sorted by price here, the ones with no price last. */
export function sortedByPrice(
  cards: readonly SiteCard[],
  sort: "price_asc" | "price_desc"
) {
  const sign = sort === "price_asc" ? 1 : -1;
  return cards.toSorted((a, b) => {
    const one = cardPrice(a.price);
    const two = cardPrice(b.price);
    if (one === null || two === null) {
      return (one === null ? 1 : 0) - (two === null ? 1 : 0);
    }
    return sign * (one - two);
  });
}
