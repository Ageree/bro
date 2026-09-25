import { z } from "zod";
import { isPublicDayOff } from "./holidays";

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use a 24-hour HH:MM time.")
  .describe("Wall-clock time in the timezone, 24-hour HH:MM.");

const timezoneSchema = z
  .string()
  .min(1)
  .refine(
    (timezone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Use a valid IANA timezone." }
  )
  .describe("IANA timezone of the person, e.g. Europe/Moscow.");

const weekdaySchema = z
  .number()
  .int()
  .min(0)
  .max(6)
  .describe("Day of the week: 0 Sunday, 1 Monday … 6 Saturday.");

const dayOfMonthSchema = z
  .union([z.number().int().min(1).max(31), z.literal("last")])
  .describe(
    'Day of the month, or "last". A day the month lacks (31 in April, 30 in February) falls on its last day.'
  );

const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const skipHolidaysSchema = z
  .boolean()
  .optional()
  .describe(
    "true only when the person asked to skip holidays («на праздники не присылай», «кроме праздников»): in a Russian time zone the run then skips public holidays and the days off moved for them (production calendar). Leave it out otherwise: a reminder keeps firing on holidays."
  );

/**
 * The calendar rules over a zone field: a stored rule always names its zone,
 * while the tool lets the model leave it to the person's profile.
 */
function calendarTimingSchemaFor<Zone extends z.ZodType>(timezone: Zone) {
  const calendarBase = {
    kind: z.literal("calendar"),
    localTime: localTimeSchema,
    timezone,
  };
  // Only a rule of days can step over a holiday; a stored rule without the
  // flag keeps running on holidays, as it always did.
  const dayRuleBase = { ...calendarBase, skipHolidays: skipHolidaysSchema };
  return z.discriminatedUnion("frequency", [
    z.strictObject({ ...dayRuleBase, frequency: z.literal("daily") }),
    // Monday to Friday.
    z.strictObject({ ...dayRuleBase, frequency: z.literal("weekdays") }),
    z.strictObject({
      ...dayRuleBase,
      frequency: z.literal("weekly"),
      weekdays: z
        .array(weekdaySchema)
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, {
          message: "List each weekday once.",
        })
        .describe(
          "The days of the week it runs on, e.g. [1, 3] for Mon and Wed."
        ),
    }),
    z.strictObject({
      ...calendarBase,
      dayOfMonth: dayOfMonthSchema,
      frequency: z.literal("monthly"),
    }),
    // «Каждое второе воскресенье месяца», «в последнюю пятницу».
    z.strictObject({
      ...calendarBase,
      frequency: z.literal("monthly_weekday"),
      occurrence: z
        .union([z.number().int().min(1).max(4), z.literal("last")])
        .describe('Which such weekday of the month: 1 to 4, or "last".'),
      weekday: weekdaySchema,
    }),
    z.strictObject({
      ...calendarBase,
      dayOfMonth: dayOfMonthSchema,
      frequency: z.literal("yearly"),
      month: z.number().int().min(1).max(12).describe("Month, 1 January."),
    }),
  ]);
}

/** 31 April is no birthday; «last» and 29 February are. */
function yearlyDayExists(timing: {
  readonly dayOfMonth?: number | "last";
  readonly frequency: string;
  readonly month?: number;
}) {
  return (
    timing.frequency !== "yearly" ||
    timing.dayOfMonth === "last" ||
    (timing.dayOfMonth ?? 1) <= (monthDays[(timing.month ?? 1) - 1] ?? 31)
  );
}

const yearlyDayMessage = {
  message: "That month has fewer days.",
  path: ["dayOfMonth"],
};

const calendarTimingSchema = calendarTimingSchemaFor(timezoneSchema).refine(
  yearlyDayExists,
  yearlyDayMessage
);

// A whole month or year of minutes drifts off the calendar: «каждое 5-е»
// stored as 43 200 minutes moved a day earlier every 31-day month.
const calendarLikeIntervalDays = new Set([28, 29, 30, 31, 365, 366]);

const intervalTimingSchema = z.strictObject({
  anchoredAt: z.iso.datetime({ offset: true }),
  everyMinutes: z.number().int().min(1).max(525_600),
  kind: z.literal("interval"),
});

const newIntervalTimingSchema = intervalTimingSchema.refine(
  ({ everyMinutes }) =>
    everyMinutes % 1_440 !== 0 ||
    !calendarLikeIntervalDays.has(everyMinutes / 1_440),
  {
    message:
      "A month or a year is not a fixed number of minutes: use calendar timing with frequency monthly or yearly.",
    path: ["everyMinutes"],
  }
);

const instantSchema = z.iso.datetime({ offset: true });
// «Завтра в 9» as the model reads it off the person's clock, no offset.
const wallClockSchema = z.iso.datetime({ local: true });

/**
 * A schedule as it is stored. Month- and year-based recurrence is a calendar
 * rule in the person's timezone, never a fixed count of minutes.
 */
export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ at: instantSchema, kind: z.literal("once") }),
  newIntervalTimingSchema,
  calendarTimingSchema,
]);

const personZoneSchema = timezoneSchema
  .optional()
  .describe(
    "IANA timezone, e.g. Europe/Moscow. Leave it out to use the person's own zone from their profile; name one only when they asked for another («по Нью-Йорку»)."
  );

/**
 * What the schedule tools accept: the same rules, with the zone left to the
 * person's profile and a one-off moment given on their wall clock. Guessing
 * the offset of «завтра в 9» put reminders an hour or a zone off; the model
 * only reads the date and time, and `resolveScheduleTiming` does the rest.
 */
export const scheduleTimingInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    at: z
      .string()
      .trim()
      .refine(
        (at) =>
          instantSchema.safeParse(at).success ||
          wallClockSchema.safeParse(at).success,
        {
          message:
            "Use the wall-clock time YYYY-MM-DDTHH:MM, or an ISO datetime with its offset.",
        }
      )
      .describe(
        "When it happens: the wall-clock time YYYY-MM-DDTHH:MM in `timezone`, e.g. 2026-09-26T09:00 for «завтра в 9», or an exact ISO datetime with an offset."
      ),
    kind: z.literal("once"),
    timezone: personZoneSchema,
  }),
  newIntervalTimingSchema,
  calendarTimingSchemaFor(personZoneSchema).refine(
    yearlyDayExists,
    yearlyDayMessage
  ),
]);

// Weekly schedules written before `weekdays` named their single day.
const legacyWeeklyTimingSchema = z.strictObject({
  frequency: z.literal("weekly"),
  kind: z.literal("calendar"),
  localTime: localTimeSchema,
  timezone: timezoneSchema,
  weekday: weekdaySchema,
});

/** Everything a stored schedule may hold, older shapes included. */
export const storedScheduleTimingSchema = z.union([
  scheduleTimingSchema,
  intervalTimingSchema,
  legacyWeeklyTimingSchema,
]);

export type ScheduleTiming = z.infer<typeof storedScheduleTimingSchema>;
type CalendarTiming = Extract<ScheduleTiming, { kind: "calendar" }>;

interface ZonedParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly year: number;
}

/** A date on the calendar, independent of any timezone; `month` is 1-based. */
interface CivilDate {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(at: number, timezone: string): ZonedParts {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    month: Number(value("month")),
    second: Number(value("second")),
    year: Number(value("year")),
  };
}

function zoneOffset(at: number, timezone: string) {
  const parts = zonedParts(at, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - at
  );
}

/**
 * The instant a wall-clock time happens in `timezone`. A time skipped by a
 * spring-forward gap happens as much later as the gap is long, the way a
 * phone alarm fires: an hour in Berlin, half an hour on Lord Howe Island.
 */
function fromWallClock(
  timezone: string,
  date: CivilDate,
  hour: number,
  minute: number
) {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstOffset = zoneOffset(naive - zoneOffset(naive, timezone), timezone);
  const resolved = naive - firstOffset;
  const readBack = zonedParts(resolved, timezone);
  if (readBack.hour === hour && readBack.minute === minute) return resolved;

  // In a gap each reading of the wall clock lands on the other side of the
  // transition, so the two passes found both offsets. The one in force before
  // the jump (the smaller) places the time just past it, shifted by the gap.
  return naive - Math.min(firstOffset, zoneOffset(resolved, timezone));
}

function civilDate(year: number, month: number, day: number): CivilDate {
  const date = new Date(Date.UTC(year, month - 1, day));
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(date: CivilDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function compareDates(left: CivilDate, right: CivilDate) {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function dayInMonth(
  dayOfMonth: number | "last",
  year: number,
  month: number
): CivilDate {
  const last = daysInMonth(year, month);
  return {
    day: dayOfMonth === "last" ? last : Math.min(dayOfMonth, last),
    month,
    year,
  };
}

function weekdayInMonth(
  timing: Extract<CalendarTiming, { frequency: "monthly_weekday" }>,
  year: number,
  month: number
): CivilDate {
  if (timing.occurrence === "last") {
    const last = daysInMonth(year, month);
    const lastWeekday = weekdayOf({ day: last, month, year });
    return {
      day: last - ((lastWeekday - timing.weekday + 7) % 7),
      month,
      year,
    };
  }
  const firstWeekday = weekdayOf({ day: 1, month, year });
  return {
    day:
      1 +
      ((timing.weekday - firstWeekday + 7) % 7) +
      (timing.occurrence - 1) * 7,
    month,
    year,
  };
}

/**
 * Whether a rule of days runs on `date`. A rule the person asked to keep off
 * holidays (`skipHolidays`) steps over a public day off in a Russian zone the
 * way a weekday rule steps over Saturday; any other rule runs on holidays.
 */
function runsOnDay(timing: CalendarTiming, date: CivilDate) {
  if (
    "skipHolidays" in timing &&
    timing.skipHolidays === true &&
    isPublicDayOff(timing.timezone, date.year, date.month, date.day)
  ) {
    return false;
  }
  const weekday = weekdayOf(date);
  if (timing.frequency === "weekdays") return weekday >= 1 && weekday <= 5;
  if (timing.frequency !== "weekly") return true;
  return "weekdays" in timing
    ? timing.weekdays.includes(weekday)
    : timing.weekday === weekday;
}

/**
 * Days walked for a rule of days: a week and a day covers any weekly rule,
 * and the Russian New Year break (up to eleven days off, weekends included)
 * plus a working day on each side covers the working week.
 */
const dayRuleWalk = 16;

/**
 * The calendar dates a rule falls on, walking from `from` (inclusive) in
 * `direction`. The few steps each rule takes always cover one occurrence
 * past `from`, since every month has each rule's (clamped) day.
 */
function* occurrenceDates(
  timing: CalendarTiming,
  from: CivilDate,
  direction: 1 | -1
): Generator<CivilDate> {
  const onOrPast = (date: CivilDate) =>
    compareDates(date, from) * direction >= 0;
  if (
    timing.frequency === "daily" ||
    timing.frequency === "weekdays" ||
    timing.frequency === "weekly"
  ) {
    for (let offset = 0; offset <= dayRuleWalk; offset += 1) {
      const date = civilDate(
        from.year,
        from.month,
        from.day + offset * direction
      );
      if (runsOnDay(timing, date)) yield date;
    }
    return;
  }
  if (timing.frequency === "yearly") {
    for (let offset = 0; offset <= 2; offset += 1) {
      const date = dayInMonth(
        timing.dayOfMonth,
        from.year + offset * direction,
        timing.month
      );
      if (onOrPast(date)) yield date;
    }
    return;
  }
  for (let offset = 0; offset <= 2; offset += 1) {
    const { month, year } = civilDate(
      from.year,
      from.month + offset * direction,
      1
    );
    const date =
      timing.frequency === "monthly"
        ? dayInMonth(timing.dayOfMonth, year, month)
        : weekdayInMonth(timing, year, month);
    if (onOrPast(date)) yield date;
  }
}

/**
 * The first occurrence strictly after `after` (`direction` 1) or the last
 * one at or before it (`direction` -1), computed on the calendar of the
 * rule's own timezone, so DST and month lengths never shift it.
 */
function calendarOccurrence(
  timing: CalendarTiming,
  reference: Date,
  direction: 1 | -1
) {
  const [hourText, minuteText] = timing.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = zonedParts(reference.getTime(), timing.timezone);
  for (const date of occurrenceDates(timing, local, direction)) {
    const candidate = fromWallClock(timing.timezone, date, hour, minute);
    if (
      direction === 1
        ? candidate > reference.getTime()
        : candidate <= reference.getTime()
    ) {
      return new Date(candidate);
    }
  }
  return null;
}

export function computeNextRun(
  timing: ScheduleTiming,
  after: Date
): Date | null {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > after.getTime() ? at : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    const interval = timing.everyMinutes * 60_000;
    if (anchor > after.getTime()) return new Date(anchor);
    const elapsedIntervals = Math.floor((after.getTime() - anchor) / interval);
    return new Date(anchor + (elapsedIntervals + 1) * interval);
  }

  return calendarOccurrence(timing, after, 1);
}

export function computeLatestRun(
  timing: ScheduleTiming,
  at: Date
): Date | null {
  if (timing.kind === "once") {
    const occurrence = new Date(timing.at);
    return occurrence.getTime() <= at.getTime() ? occurrence : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    if (anchor > at.getTime()) return null;
    const interval = timing.everyMinutes * 60_000;
    return new Date(
      anchor + Math.floor((at.getTime() - anchor) / interval) * interval
    );
  }

  return calendarOccurrence(timing, at, -1);
}

/**
 * The stored rule for what the tool was given: a missing zone is the
 * person's own, and a wall-clock moment becomes the instant it happens there.
 * An instant the model gave with its offset stays as given.
 */
export function resolveScheduleTiming(
  timing: z.infer<typeof scheduleTimingInputSchema>,
  personTimeZone: string
): z.infer<typeof scheduleTimingSchema> {
  if (timing.kind === "interval") return timing;
  if (timing.kind === "calendar") {
    const zoned = { ...timing, timezone: timing.timezone ?? personTimeZone };
    // A model that fills every field sends `skipHolidays: false`; stored, it
    // would only differ from the rule the person asked for.
    if ("skipHolidays" in zoned && zoned.skipHolidays !== true) {
      const { skipHolidays: _notAsked, ...rule } = zoned;
      return rule;
    }
    return zoned;
  }
  if (instantSchema.safeParse(timing.at).success) {
    return { at: timing.at, kind: "once" };
  }
  const [year, month, day, hour, minute] = timing.at
    .split(/[-T:]/u)
    .map(Number);
  const at = fromWallClock(
    timing.timezone ?? personTimeZone,
    { day: day ?? 1, month: month ?? 1, year: year ?? 1970 },
    hour ?? 0,
    minute ?? 0
  );
  return { at: new Date(at).toISOString(), kind: "once" };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * A run's moment on the person's clock, for the reply that names it: the
 * model counting «завтра» from a UTC instant named the wrong day.
 */
export function localRunLabel(at: Date, timeZone: string) {
  const parts = zonedParts(at.getTime(), timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(at);
  const date = [parts.year, parts.month, parts.day].map(twoDigits).join("-");
  const time = [parts.hour, parts.minute].map(twoDigits).join(":");
  return `${date} ${time}, ${weekday} (${timeZone})`;
}
