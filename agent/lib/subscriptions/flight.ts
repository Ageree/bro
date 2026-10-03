import {
  localMinuteOfDay,
  quietHoursEnd,
} from "@agent/lib/proactive/quiet-hours";
import {
  checkInNudgeUntilMs,
  checkInOpensMs,
  eveningFlightBeforeMinute,
  eveningFromMinute,
  eveningUntilMinute,
} from "@agent/lib/proactive/signals";
import {
  findPlaces,
  type LookupBudget,
  measureRoutes,
  straightKm,
} from "@agent/lib/routes/openstreetmap";
import type { FlightStage, FlightState } from "@shared/subscriptions/flight";
import { localClockInstant, localRunLabel } from "@shared/schedules/timing";
import type { UserProfile } from "@shared/user-profile/schema";
import type { FlightWatch } from "./watches";

/**
 * When a flight's reminders are due, by the clock and never by novelty: a
 * flight seen days ahead is still to be reminded of in time (item 5 of the
 * roadmap: the 07:05 flight nobody heard of). Code decides the moment, the
 * proactive worker the words.
 */

/** `minute` past midnight on the person's clock, the day before `at`. */
function dayBeforeAt(at: Date, timeZone: string, minute: number) {
  return localClockInstant(
    at,
    timeZone,
    -1,
    Math.floor(minute / 60),
    minute % 60
  );
}

interface StageWindow {
  readonly from: Date;
  readonly stage: FlightStage;
  readonly until: Date;
}

/**
 * The window in which each reminder may go out, if it has one:
 * - `evening`: 18:00–23:00 the evening before a flight leaving before noon
 *   (a flight at dawn is worth one late message before sleep);
 * - `checkin`: from check-in opening, moved out of quiet hours to their end,
 *   until three hours before departure.
 */
function stageWindows(departure: Date, timeZone: string): StageWindow[] {
  const windows: StageWindow[] = [];
  if (localMinuteOfDay(departure, timeZone) < eveningFlightBeforeMinute) {
    windows.push({
      from: dayBeforeAt(departure, timeZone, eveningFromMinute),
      stage: "evening",
      until: dayBeforeAt(departure, timeZone, eveningUntilMinute),
    });
  }
  const opens = new Date(departure.getTime() - checkInOpensMs);
  const from = quietHoursEnd(opens, timeZone) ?? opens;
  const until = new Date(departure.getTime() - checkInNudgeUntilMs);
  if (from < until) windows.push({ from, stage: "checkin", until });
  return windows;
}

/**
 * What a flight's watch does now: the reminders due (`due`, any not handed
 * over yet whose window is open) and when to look again (`next`, the
 * earliest window still ahead). Neither means the watch is over: every
 * reminder went out or its window passed.
 */
export function flightPlan(input: {
  readonly departure: Date;
  readonly done: readonly FlightStage[];
  readonly now: Date;
  readonly timeZone: string;
}) {
  // Check-in is no news at night: a watch first seen then, or retried into
  // the quiet hours, waits for their end while its window lasts.
  const quietUntil = quietHoursEnd(input.now, input.timeZone);
  const open = stageWindows(input.departure, input.timeZone).flatMap(
    (window) => {
      if (input.done.includes(window.stage) || input.now >= window.until) {
        return [];
      }
      if (window.stage !== "checkin" || !quietUntil) return [window];
      if (quietUntil >= window.until) return [];
      return [
        { ...window, from: new Date(Math.max(+window.from, +quietUntil)) },
      ];
    }
  );
  const due = open
    .filter((window) => window.from <= input.now)
    .map((window) => window.stage);
  const ahead = open
    .filter((window) => window.from > input.now)
    .map((window) => window.from.getTime());
  return {
    due,
    next: ahead.length > 0 ? new Date(Math.min(...ahead)) : undefined,
  };
}

/** What the map lookups of one drive may spend. */
const driveLookups = 3;
/** An airport found farther than this from the start is the wrong match. */
const farthestAirportKm = 250;

const airportWords = /аэропорт|airport|aéroport|flughafen/iu;

/**
 * The place to look the airport up by: the event's location (or title)
 * without the terminal and codes after it, «аэропорт» added when the text
 * does not say so: «Аэропорт Внуково (VKO), терминал A» is «Аэропорт
 * Внуково».
 */
function airportQuery(text: string) {
  const name = (text.split(",")[0] ?? "")
    .replaceAll(/\([^)]*\)/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  if (name.length === 0) return undefined;
  return airportWords.test(name) ? name : `аэропорт ${name}`;
}

/** Where the drive starts: home from Personal Info, else the city centre. */
function startQuery(
  home: Pick<UserProfile, "addressLine1" | "addressLine2" | "city" | "region">
) {
  const city = [home.city, home.region].filter(Boolean).join(", ");
  if (home.addressLine1) {
    return {
      from: "home" as const,
      query: [home.addressLine1, home.addressLine2, city]
        .filter(Boolean)
        .join(", "),
    };
  }
  return city ? { from: "centre" as const, query: city } : undefined;
}

/**
 * The drive from home (or the city centre) to the flight's airport along
 * OpenStreetMap roads, without traffic, or `null` when either end cannot be
 * found or the router does not answer: then the worker counts it itself.
 */
export async function measureDrive(
  watch: Pick<FlightWatch, "source">,
  home: Parameters<typeof startQuery>[0],
  signal: AbortSignal
): Promise<NonNullable<FlightState["travel"]> | null> {
  const start = startQuery(home);
  // Only the airport the event names: a title alone («Рейс SU 123 Москва —
  // Сочи») could match any airport of the city, or another city's.
  const airport = airportQuery(watch.source.location ?? "");
  if (!start || !airport) return null;
  try {
    const budget: LookupBudget = { remaining: driveLookups };
    const [from] = await findPlaces(start.query, undefined, budget, signal);
    if (!from) return null;
    const [to] = await findPlaces(airport, from, budget, signal);
    if (!to || straightKm(from, to) > farthestAirportKm) return null;
    const [route] = await measureRoutes("driving", from, [to], signal);
    return route
      ? {
          from: start.from,
          km: route.km,
          minutes: route.minutes,
          to: (to.name ?? to.label).slice(0, 120),
        }
      : null;
  } catch (error) {
    console.warn("[subscriptions] flight drive not measured", {
      name: error instanceof Error ? error.name : "error",
    });
    return null;
  }
}

/** How early to be at the airport, as the facts tell the worker. */
const airportLeadMinutes = 120;

/**
 * The facts of a flight's reminder, counted by code so the worker does not
 * count them: the departure and check-in opening on the person's clock, and
 * when to leave home by car. A worker counting these itself got the check-in
 * time wrong (roadmap, item 5).
 */
export function flightFacts(
  watch: Pick<FlightWatch, "source" | "state">,
  timeZone: string
) {
  const departure = new Date(watch.source.start);
  if (Number.isNaN(departure.getTime())) return undefined;
  const label = (at: Date) => localRunLabel(at, timeZone);
  const travel = watch.state.travel;
  const leave = travel
    ? `Leave home by about ${label(new Date(departure.getTime() - (airportLeadMinutes + travel.minutes) * 60_000))}: ${String(travel.minutes)} min (${String(travel.km)} km) by car without traffic from ${travel.from === "home" ? "home" : "the city centre (no home address in Personal Info)"} to «${travel.to}» as OpenStreetMap found it, plus ${String(airportLeadMinutes / 60)} h at the airport for a domestic flight (3 h for an international one). It is an estimate: say so, and add time for traffic at that hour or name the airport train if it is faster.`
    : "The drive to the airport could not be measured: count the leave-by time yourself, and say it is an estimate.";
  return [
    `Departs ${label(departure)}.`,
    `Online check-in usually opens 24 h before: ${label(new Date(departure.getTime() - checkInOpensMs))}; the airline's own rule in the booking letter wins.`,
    leave,
  ].join(" ");
}
