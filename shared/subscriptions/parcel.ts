import { z } from "zod";

/**
 * What a parcel watch keeps (`subscriptions`, template `parcel`): the
 * carrier and the number, and what code last read of it. The carrier is read
 * and judged in `agent/lib/subscriptions/parcel/`. Only Russian Post for now:
 * CDEK answers a plain request with a bot check from any address in Russia,
 * and its API serves only a contract holder's own orders.
 */

/** A Russian Post number: 14 digits, or an international S10 one. */
export const parcelNumberSchema = z
  .string()
  .regex(/^(?:\d{14}|[A-Z]{2}\d{9}[A-Z]{2})$/u);

export const parcelSourceSchema = z.strictObject({
  carrier: z.enum(["pochta"]),
  number: parcelNumberSchema,
  // How the number came: in the person's words, or in a letter of the
  // carrier's that the proactive check read.
  origin: z.enum(["person", "mail"]),
  // What the carrier calls it («Посылка из Казани»), once it said.
  title: z.string().max(120).nullable(),
});

/**
 * What counts as news: a new expected date, arriving where it is collected,
 * the end of its storage there, and its return or loss. Nothing else.
 */
export const parcelConditionSchema = z.strictObject({
  kind: z.literal("changes"),
});

/**
 * Where a parcel is, in code's terms:
 * - `unknown`: the carrier knows nothing of the number yet;
 * - `registered`: a number or a label is made, the carrier has not taken it;
 * - `in_transit`: taken and on its way;
 * - `arrived`: at the post office, a locker or a pickup point, to collect;
 * - `delivered`, `returned` (going back to the sender), `lost`.
 */
const parcelStatusSchema = z.enum([
  "unknown",
  "registered",
  "in_transit",
  "arrived",
  "delivered",
  "returned",
  "lost",
]);

/** The latest reading, and what the person has already been told. */
export const parcelStateSchema = z.strictObject({
  status: parcelStatusSchema,
  // The day the carrier expects to deliver it, as it gives it.
  expectedOn: z.iso.date().nullable(),
  // The last day it is kept where it waits.
  storageUntil: z.iso.date().nullable(),
  // Where it is: «390043, Рязань».
  place: z.string().max(120).nullable(),
  // The carrier's own words for where it is now, and since when.
  lastEvent: z.string().max(200).nullable(),
  lastEventAt: z.iso.datetime({ offset: true }).nullable(),
  // The storage end the person was warned of: an extension warns again.
  storageWarned: z.iso.date().nullable(),
  // Whether any reading knew the number.
  seen: z.boolean(),
  lastSeenAt: z.iso.datetime({ offset: true }),
});

/**
 * A parcel is read every three hours: eight small requests a day, and the
 * news of its arrival is at most that late.
 */
export const parcelCheckEverySeconds = 3 * 60 * 60;
/** A watch's term without the person's own: long enough for most journeys. */
export const parcelWatchDays = 60;

/** A watch's state before its first reading. */
export function unreadParcelState(now: Date): ParcelState {
  return {
    expectedOn: null,
    lastEvent: null,
    lastEventAt: null,
    lastSeenAt: now.toISOString(),
    place: null,
    seen: false,
    status: "unknown",
    storageUntil: null,
    storageWarned: null,
  };
}

export type ParcelSource = z.output<typeof parcelSourceSchema>;
export type ParcelCondition = z.output<typeof parcelConditionSchema>;
export type ParcelStatus = z.output<typeof parcelStatusSchema>;
export type ParcelState = z.output<typeof parcelStateSchema>;
