/**
 * Free time on the person's calendar, in their time zone and, for a meeting
 * with someone on another clock, in theirs too. Google's free/busy answer is
 * a list of busy UTC intervals; turned into windows by a weak model, it gave
 * a slot over a busy one (EN D8: «Thursday afternoon» went to 14:00, taken)
 * and windows at 7 a.m. for a colleague two hours ahead (RU d09).
 */

const minute = 60_000;

interface WallClock {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly weekday: string;
  readonly year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      timeZone,
      weekday: "short",
      year: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock of `at` in `timeZone`. */
function wallClock(at: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    month: Number(value("month")),
    weekday: value("weekday"),
    year: Number(value("year")),
  };
}

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function offsetAt(at: number, timeZone: string) {
  const clock = wallClock(at, timeZone);
  const wholeMinute = at - (((at % minute) + minute) % minute);
  return (
    Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) -
    wholeMinute
  );
}

/** How far `timeZone` is ahead of UTC at `at`, in minutes. */
export function zoneOffsetMinutes(at: number, timeZone: string) {
  return Math.round(offsetAt(at, timeZone) / minute);
}

/** Whether `timeZone` is an IANA zone or a `+05:00` offset Intl understands. */
export function knownTimeZone(timeZone: string) {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
        .timeZone !== ""
    );
  } catch {
    return false;
  }
}

/**
 * The instant a wall-clock minute of a calendar date happens in `timeZone`
 * (`minutes` past midnight; 1440 is the next midnight). A time a clock
 * change skips lands just after the jump.
 */
function zonedInstant(
  date: { readonly day: number; readonly month: number; readonly year: number },
  minutes: number,
  timeZone: string
) {
  const naive =
    Date.UTC(date.year, date.month - 1, date.day) + minutes * minute;
  const first = offsetAt(naive - offsetAt(naive, timeZone), timeZone);
  const resolved = naive - first;
  const second = offsetAt(resolved, timeZone);
  return second === first ? resolved : naive - Math.min(first, second);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** `2026-10-01T14:30:00+03:00`: the instant as the zone's clock shows it. */
export function zonedIso(at: number, timeZone: string) {
  const clock = wallClock(at, timeZone);
  const offset = Math.round(offsetAt(at, timeZone) / minute);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return `${String(clock.year)}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** A span as the zone's clock shows it: the date, the weekday, from and to. */
function localSpan(start: number, end: number, timeZone: string) {
  const from = wallClock(start, timeZone);
  const to = wallClock(end, timeZone);
  const date = (clock: WallClock) =>
    `${String(clock.year)}-${pad(clock.month)}-${pad(clock.day)}`;
  const time = (clock: WallClock) => `${pad(clock.hour)}:${pad(clock.minute)}`;
  const nextMidnight =
    to.hour === 0 && to.minute === 0 && end - start <= 24 * 60 * minute;
  let until = `${date(to)} ${time(to)}`;
  if (date(to) === date(from)) until = time(to);
  else if (nextMidnight) until = "24:00";
  return {
    date: date(from),
    from: time(from),
    to: until,
    weekday: from.weekday,
  };
}

export interface Interval {
  readonly end: number;
  readonly start: number;
}

/** The calendar dates `timeZone` passes through between two instants. */
function datesBetween(start: number, end: number, timeZone: string) {
  const first = wallClock(start, timeZone);
  const last = wallClock(end, timeZone);
  const dates = [];
  for (
    let day = Date.UTC(first.year, first.month - 1, first.day);
    day <= Date.UTC(last.year, last.month - 1, last.day);
    day += 24 * 60 * minute
  ) {
    const date = new Date(day);
    dates.push({
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    });
  }
  return dates;
}

/** The hours of each day in `timeZone` that fall within `range`. */
function dayWindows(
  range: Interval,
  timeZone: string,
  hours: { readonly from: number; readonly to: number }
) {
  // A day around each end: the other zone's day may start before the range.
  const dates = datesBetween(
    range.start - 24 * 60 * minute,
    range.end + 24 * 60 * minute,
    timeZone
  );
  return dates.flatMap((date) => {
    const start = Math.max(
      range.start,
      zonedInstant(date, hours.from * 60, timeZone)
    );
    const end = Math.min(
      range.end,
      zonedInstant(date, hours.to * 60, timeZone)
    );
    return end > start ? [{ end, start }] : [];
  });
}

function intersect(left: readonly Interval[], right: readonly Interval[]) {
  return left.flatMap((a) =>
    right.flatMap((b) => {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      return end > start ? [{ end, start }] : [];
    })
  );
}

/** Busy intervals sorted and merged where they touch or overlap. */
export function mergeIntervals(intervals: readonly Interval[]) {
  const merged: Interval[] = [];
  for (const interval of [...intervals].toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      merged[merged.length - 1] = {
        end: Math.max(last.end, interval.end),
        start: last.start,
      };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

function subtract(windows: readonly Interval[], busy: readonly Interval[]) {
  return windows.flatMap((window) => {
    const free: Interval[] = [];
    let cursor = window.start;
    for (const taken of busy) {
      if (taken.end <= cursor || taken.start >= window.end) continue;
      if (taken.start > cursor) free.push({ end: taken.start, start: cursor });
      cursor = Math.max(cursor, taken.end);
    }
    if (cursor < window.end) free.push({ end: window.end, start: cursor });
    return free;
  });
}

/** A window starts on a quarter hour, as a person would propose it. */
const startStepMs = 15 * minute;

/**
 * Free windows at least `slotMinutes` long within `range`: inside the
 * person's day hours in their zone, inside the attendee's working day in
 * theirs when one is given, and outside every busy interval.
 */
export function freeWindows(options: {
  readonly attendee?: {
    readonly hours: { readonly from: number; readonly to: number };
    readonly timeZone: string;
  };
  readonly busy: readonly Interval[];
  readonly hours: { readonly from: number; readonly to: number };
  readonly range: Interval;
  readonly slotMinutes: number;
  readonly timeZone: string;
}) {
  const own = dayWindows(options.range, options.timeZone, options.hours);
  const shared = options.attendee
    ? intersect(
        own,
        dayWindows(
          options.range,
          options.attendee.timeZone,
          options.attendee.hours
        )
      )
    : own;
  return subtract(shared, mergeIntervals(options.busy))
    .map((window) => ({
      end: window.end,
      start: Math.ceil(window.start / startStepMs) * startStepMs,
    }))
    .filter(
      (window) => window.end - window.start >= options.slotMinutes * minute
    );
}

/**
 * A span for the model: both ends as ISO instants in the person's zone, and
 * the date, weekday and clock times the person and, when there is one, the
 * attendee would say.
 */
export function describeSpan(
  span: Interval,
  timeZone: string,
  attendeeTimeZone?: string
) {
  const described = {
    end: zonedIso(span.end, timeZone),
    start: zonedIso(span.start, timeZone),
    ...localSpan(span.start, span.end, timeZone),
  };
  if (attendeeTimeZone === undefined) return described;
  return Object.assign(described, {
    attendee: localSpan(span.start, span.end, attendeeTimeZone),
  });
}
