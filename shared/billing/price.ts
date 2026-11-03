import { env } from "@shared/environment";

/**
 * Share of a card payment YooKassa keeps. The card price covers it so the
 * base price stays the SBP one: a card simply costs more.
 */
const cardAcquiringShare = 0.035;

/**
 * Whole roubles a month costs when paid by bank card. `PRICE_CARD_RUB` wins;
 * otherwise the base price grossed up for the card share, rounded up to tens.
 */
export function cardPriceRub() {
  if (env.PRICE_CARD_RUB !== undefined) return env.PRICE_CARD_RUB;
  return Math.ceil(env.PRICE_RUB / (1 - cardAcquiringShare) / 10) * 10;
}
