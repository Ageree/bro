import { z } from "zod";

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

const calendarBase = {
  kind: z.literal("calendar"),
  localTime: localTimeSchema,
  timezone: timezoneSchema,
};

const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const calendarTimingSchema = z.discriminatedUnion("frequency", [
  z.strictObject({ ...calendarBase, frequency: z.literal("daily") }),
  // Monday to Friday.
  z.strictObject({ ...calendarBase, frequency: z.literal("weekdays") }),
  z.strictObject({
    ...calendarBase,
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
  z
    .strictObject({
      ...calendarBase,
      dayOfMonth: dayOfMonthSchema,
      frequency: z.literal("yearly"),
      month: z.number().int().min(1).max(12).describe("Month, 1 January."),
    })
    .refine(
      ({ dayOfMonth, month }) =>
        dayOfMonth === "last" || dayOfMonth <= (monthDays[month - 1] ?? 31),
      { message: "That month has fewer days.", path: ["dayOfMonth"] }
    ),
]);

// A whole month or year of minutes drifts off the calendar: «каждое 5-е»
// stored as 43 200 minutes moved a day earlier every 31-day month.
const calendarLikeIntervalDays = new Set([28, 29, 30, 31, 365, 366]);

const intervalTimingSchema = z.strictObject({
  anchoredAt: z.iso.datetime({ offset: true }),
  everyMinutes: z.number().int().min(1).max(525_600),
  kind: z.literal("interval"),
});

/**
 * What a schedule tool accepts. Month- and year-based recurrence is a
 * calendar rule in the person's timezone, never a fixed count of minutes.
 */
export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    at: z.iso.datetime({ offset: true }),
    kind: z.literal("once"),
  }),
  intervalTimingSchema.refine(
    ({ everyMinutes }) =>
      everyMinutes % 1_440 !== 0 ||
      !calendarLikeIntervalDays.has(everyMinutes / 1_440),
    {
      message:
        "A month or a year is not a fixed number of minutes: use calendar timing with frequency monthly or yearly.",
      path: ["everyMinutes"],
    }
  ),
  calendarTimingSchema,
]);

// Weekly schedules written before `weekdays` named their single day.
const legacyWeeklyTimingSchema = z.strictObject({
  ...calendarBase,
  frequency: z.literal("weekly"),
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
 * spring-forward gap happens an hour later, the way a phone alarm fires.
 */
function fromWallClock(
  timezone: string,
  date: CivilDate,
  hour: number,
  minute: number
) {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstPass = naive - zoneOffset(naive, timezone);
  const resolved = naive - zoneOffset(firstPass, timezone);
  const readBack = zonedParts(resolved, timezone);
  if (readBack.hour === hour && readBack.minute === minute) return resolved;

  const shifted = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour + 1,
    minute
  );
  return (
    shifted - zoneOffset(shifted - zoneOffset(shifted, timezone), timezone)
  );
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

function runsOnDay(timing: CalendarTiming, date: CivilDate) {
  const weekday = weekdayOf(date);
  if (timing.frequency === "weekdays") return weekday >= 1 && weekday <= 5;
  if (timing.frequency !== "weekly") return true;
  return "weekdays" in timing
    ? timing.weekdays.includes(weekday)
    : timing.weekday === weekday;
}

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
    for (let offset = 0; offset <= 8; offset += 1) {
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
