import { z } from "zod";

/**
 * What a flight watch keeps (`subscriptions`, template `flight`): Bro sets
 * one up by itself for each flight in the person's calendar, and code decides
 * when its reminders are due (`agent/lib/subscriptions/flight.ts`).
 */

/**
 * The reminders of a flight: `evening` — the night before an early one,
 * before the person sleeps; `checkin` — when online check-in opens.
 */
const flightStages = ["evening", "checkin"] as const;

/** The calendar event, as the check read it. */
export const flightSourceSchema = z.strictObject({
  eventId: z.string().min(1),
  location: z.string().nullable(),
  // The event's start exactly as the calendar gives it: it is part of the
  // reminder's dedupe key, which a moved flight changes.
  start: z.string().min(1),
  summary: z.string().nullable(),
});

/** A flight's watch has one condition: its reminders by the clock. */
export const flightConditionSchema = z.strictObject({
  kind: z.literal("reminders"),
});

/** The drive to the airport, as code measured it. */
const travelSchema = z.strictObject({
  // Whether it was counted from the person's home or the city centre.
  from: z.enum(["home", "centre"]),
  km: z.number().nonnegative(),
  minutes: z.number().int().positive(),
  // The airport as the map found it, for the worker to check.
  to: z.string().max(120),
});

/**
 * The reminders already handed to a run, and the drive to the airport:
 * absent until measured, `null` when it could not be.
 */
export const flightStateSchema = z.strictObject({
  done: z.array(z.enum(flightStages)),
  travel: travelSchema.nullable().optional(),
});

export type FlightSource = z.output<typeof flightSourceSchema>;
export type FlightCondition = z.output<typeof flightConditionSchema>;
export type FlightState = z.output<typeof flightStateSchema>;
export type FlightStage = (typeof flightStages)[number];
