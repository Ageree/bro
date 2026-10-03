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
  flightReminderKey,
} from "@agent/lib/proactive/signals";
import {
  findPlaces,
  type LookupBudget,
  measureRoutes,
  straightKm,
} from "@agent/lib/routes/openstreetmap";
import type { ProactiveSignal } from "@db/services/proactive";
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

/** `minute` past midnight on the clock of `timeZone`, the day before `at`. */
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
 * - `evening`: 18:00–23:00 the evening before a flight leaving before noon,
 *   both on the clock where it leaves (a flight at dawn is worth one late
 *   message before sleep);
 * - `checkin`: from check-in opening until three hours before departure.
 */
function stageWindows(departure: Date, flightZone: string): StageWindow[] {
  const windows: StageWindow[] = [];
  if (localMinuteOfDay(departure, flightZone) < eveningFlightBeforeMinute) {
    windows.push({
      from: dayBeforeAt(departure, flightZone, eveningFromMinute),
      stage: "evening",
      until: dayBeforeAt(departure, flightZone, eveningUntilMinute),
    });
  }
  windows.push({
    from: new Date(departure.getTime() - checkInOpensMs),
    stage: "checkin",
    until: new Date(departure.getTime() - checkInNudgeUntilMs),
  });
  return windows;
}

/**
 * The reminders of a flight due now: not handed over yet, their window
 * open. Check-in is no news in the person's quiet hours (`personZone`): it
 * waits for their end while its window lasts, and the morning check hands
 * it over with the rest of the morning (`agent/schedules/proactive.ts`).
 */
export function dueFlightStages(input: {
  readonly departure: Date;
  readonly done: readonly FlightStage[];
  /** Where the flight leaves from: its evening is that city's. */
  readonly flightZone: string;
  readonly now: Date;
  readonly personZone: string;
}) {
  const quiet = quietHoursEnd(input.now, input.personZone) !== undefined;
  return stageWindows(input.departure, input.flightZone).flatMap((window) =>
    !input.done.includes(window.stage) &&
    window.from <= input.now &&
    input.now < window.until &&
    !(quiet && window.stage === "checkin")
      ? [window.stage]
      : []
  );
}

/** A watched flight's zone: the event's own, else the person's. */
function flightZoneOf(
  watch: Pick<FlightWatch, "source">,
  personZone: string
) {
  return watch.source.timeZone ?? personZone;
}

/**
 * The reminders due now of the person's watched flights, as the proactive
 * run's signals, keyed as the check's own (`flightReminderKey`), so one
 * handed over before is not handed over again.
 */
export function flightReminderSignals(
  watches: readonly Pick<FlightWatch, "id" | "source" | "state">[],
  now: Date,
  personZone: string
) {
  return watches.flatMap((watch) =>
    dueFlightStages({
      departure: new Date(watch.source.start),
      done: watch.state.done,
      flightZone: flightZoneOf(watch, personZone),
      now,
      personZone,
    }).map((stage) => ({
      signal: {
        dedupeKey: flightReminderKey(
          watch.source.eventId,
          watch.source.start,
          stage
        ),
        itemId: watch.source.eventId,
        source: "calendar" as const,
        threadId: null,
      } satisfies ProactiveSignal,
      stage,
      watchId: watch.id,
    }))
  );
}

/** What the map lookups of one drive may spend. */
const driveLookups = 3;
/** The map's best matches looked through for the airport itself. */
const airportCandidates = 5;
/** An airport farther than this from the start is another city's. */
const farthestAirportKm = 250;

const airportWords = /аэропорт|airport|aéroport|flughafen/iu;

/**
 * The place to look the airport up by: the event's location without the
 * terminal and codes after it, «аэропорт» added when the text does not say
 * so: «Аэропорт Внуково (VKO), терминал A» is «Аэропорт Внуково».
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
 * OpenStreetMap roads, without traffic. Only an aerodrome counts: «Аэропорт»
 * is also a Moscow metro station. An airport of another city is
 * `elsewhere`, with no leave-by time. Undefined when nothing could be
 * measured — no start, no airport in the event, a map that did not answer —
 * so a later reminder tries again.
 */
export async function measureDrive(
  watch: Pick<FlightWatch, "source">,
  home: Parameters<typeof startQuery>[0],
  signal: AbortSignal
): Promise<FlightState["travel"]> {
  const start = startQuery(home);
  const airport = airportQuery(watch.source.location ?? "");
  if (!start || !airport) return undefined;
  try {
    const budget: LookupBudget = { remaining: driveLookups };
    const [from] = await findPlaces(start.query, undefined, budget, signal);
    if (!from) return undefined;
    const found = await findPlaces(
      airport,
      from,
      budget,
      signal,
      airportCandidates
    );
    const to = found.find((place) => place.tag === "aeroway:aerodrome");
    if (!to) return undefined;
    if (straightKm(from, to) > farthestAirportKm) return { kind: "elsewhere" };
    const [route] = await measureRoutes("driving", from, [to], signal);
    return route
      ? {
          from: start.from,
          kind: "drive",
          km: route.km,
          minutes: route.minutes,
          to: (to.name ?? to.label).slice(0, 120),
        }
      : undefined;
  } catch (error) {
    console.warn("[subscriptions] flight drive not measured", {
      name: error instanceof Error ? error.name : "error",
    });
    return undefined;
  }
}

/** How early to be at the airport, as the facts suggest. */
const airportLeadMinutes = 120;

/**
 * The facts of a flight's reminder, counted by code: the departure, the
 * usual check-in opening and a leave-by time, on the clock where the flight
 * leaves, and on the person's own when that differs. A worker counting these
 * itself got the check-in time wrong (roadmap, item 5). They are estimates
 * from the calendar, and the wording says so: the airline's own rules win.
 */
export function flightFacts(
  watch: Pick<FlightWatch, "source" | "state">,
  personZone: string
) {
  const departure = new Date(watch.source.start);
  if (Number.isNaN(departure.getTime())) return undefined;
  const flightZone = flightZoneOf(watch, personZone);
  const label = (at: Date) =>
    flightZone === personZone
      ? localRunLabel(at, flightZone)
      : `${localRunLabel(at, flightZone)}; ${localRunLabel(at, personZone)} on the person's own clock`;
  const travel = watch.state.travel;
  const leave =
    travel?.kind === "drive"
      ? `A leave-by estimate: about ${label(new Date(departure.getTime() - (airportLeadMinutes + travel.minutes) * 60_000))} — ${String(travel.minutes)} min (${String(travel.km)} km) by car without traffic from ${travel.from === "home" ? "home" : "the city centre (no home address in Personal Info)"} to «${travel.to}» as OpenStreetMap found it, plus about ${String(airportLeadMinutes / 60)} h at the airport (more for an international flight; the airline says how much). Say it is an estimate, and allow for traffic or name the airport train if it is faster.`
      : travel?.kind === "elsewhere"
        ? "It leaves from another city: no leave-by time is counted; do not guess one."
        : "The drive to the airport was not measured: give no leave-by time unless the booking letter or the person says how they get there.";
  return [
    `Departs ${label(departure)}.`,
    `Online check-in usually opens about 24 h before, ${label(new Date(departure.getTime() - checkInOpensMs))}, but airlines differ: say to check the booking letter or the airline, and never that it is open for certain.`,
    leave,
  ].join(" ");
}
