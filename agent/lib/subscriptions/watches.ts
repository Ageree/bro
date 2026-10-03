import type { ClaimedSubscription } from "@db/services/subscriptions";
import {
  flightConditionSchema,
  flightSourceSchema,
  flightStateSchema,
} from "@shared/subscriptions/flight";
import {
  priceConditionSchema,
  priceSourceSchema,
  priceStateSchema,
} from "@shared/subscriptions/price";

/**
 * A claimed watch of one template, its JSON read through that template's
 * schemas: a row whose JSON no longer fits is no watch to act on, and the
 * tick ends it rather than guessing (`agent/schedules/subscriptions.ts`).
 */

/** What a watch's row must carry to be read. */
type StoredWatch = Pick<
  ClaimedSubscription,
  "condition" | "source" | "state" | "template"
>;

export function priceWatchOf<Row extends StoredWatch>(row: Row) {
  if (row.template !== "price") return undefined;
  const source = priceSourceSchema.safeParse(row.source).data;
  const condition = priceConditionSchema.safeParse(row.condition).data;
  const state = priceStateSchema.safeParse(row.state).data;
  if (!source || !condition || !state) return undefined;
  return { ...row, condition, source, state };
}

export function flightWatchOf<Row extends StoredWatch>(row: Row) {
  if (row.template !== "flight") return undefined;
  const source = flightSourceSchema.safeParse(row.source).data;
  const condition = flightConditionSchema.safeParse(row.condition).data;
  const state = flightStateSchema.safeParse(row.state).data;
  if (!source || !condition || !state) return undefined;
  return { ...row, condition, source, state };
}

export type PriceWatch = NonNullable<
  ReturnType<typeof priceWatchOf<ClaimedSubscription>>
>;
export type FlightWatch = NonNullable<
  ReturnType<typeof flightWatchOf<ClaimedSubscription>>
>;
