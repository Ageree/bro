import { z } from "zod";

/**
 * What a price watch keeps (`subscriptions`): the agent reads and decides
 * (`agent/lib/subscriptions/`), the database stores them as JSON.
 */

/** Which markup of the page the price came from. */
export const priceExtractorSchema = z.enum(["jsonld", "meta", "itemprop"]);

/**
 * The product a watch is pinned to: a later reading counts only when the
 * same markup gives the same currency and, where the page names it, the same
 * SKU. Otherwise the shop changed the page, and a price off it may be
 * another product's.
 */
const priceSourceSchema = z.strictObject({
  currency: z.string().nullable(),
  extractor: priceExtractorSchema,
  name: z.string().nullable(),
  sku: z.string().nullable(),
  url: z.url(),
});

/**
 * What counts as news: the price below an amount the person named, or any
 * drop (or one of at least `percent`) from the price when the watch began.
 */
const priceConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ amount: z.number().positive(), kind: z.literal("below") }),
  z.strictObject({
    kind: z.literal("drop"),
    percent: z.number().min(0).max(90),
  }),
]);

/** The first and the latest reading. */
const priceStateSchema = z.strictObject({
  baseline: z.number().positive(),
  last: z.number().positive(),
  lastSeenAt: z.iso.datetime({ offset: true }),
});

export type PriceSource = z.output<typeof priceSourceSchema>;
export type PriceCondition = z.output<typeof priceConditionSchema>;
export type PriceState = z.output<typeof priceStateSchema>;
