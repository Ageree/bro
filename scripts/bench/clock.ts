/**
 * Wall-clock time in the tester's zone. The benchmark reads every «завтра в
 * 07:05», «в пятницу» and «не ночью» by the person's local clock (§2.6), so
 * fixtures are dated and observations judged in `BENCH_TIMEZONE`, not in the
 * zone of the machine the driver runs on.
 */

/** A calendar day, as the tester's calendar shows it. */
export interface LocalDay {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

const wallClockFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });

/** What a clock in `timeZone` shows at `date`. */
function wallClock(date: Date, timeZone: string) {
  const parts = wallClockFormat(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    month: value("month"),
    second: value("second"),
    year: value("year"),
  };
}

/** How far `timeZone` is ahead of UTC at `date`, in milliseconds. */
function offsetMs(date: Date, timeZone: string) {
  const clock = wallClock(date, timeZone);
  const shown = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second
  );
  return shown - Math.floor(date.getTime() / 1000) * 1000;
}

/** The day `date` falls on in `timeZone`. */
export function localDay(date: Date, timeZone: string): LocalDay {
  const { day, month, year } = wallClock(date, timeZone);
  return { day, month, year };
}

export function addDays(day: LocalDay, days: number): LocalDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
}

/** 0 is Sunday, as in `Date#getDay`. */
export function weekday(day: LocalDay) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

/** The first `wanted` weekday strictly after `day`: «в четверг» on a Thursday is next week's. */
export function nextWeekday(day: LocalDay, wanted: number) {
  const ahead = (wanted - weekday(day) + 7) % 7;
  return addDays(day, ahead === 0 ? 7 : ahead);
}

/** The instant a clock in `timeZone` shows `hh:mm` on `day`. */
export function zonedInstant(day: LocalDay, time: string, timeZone: string) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time);
  if (!match) throw new Error(`Expected hh:mm, got ${JSON.stringify(time)}.`);
  const asUtc = Date.UTC(
    day.year,
    day.month - 1,
    day.day,
    Number(match[1]),
    Number(match[2])
  );
  // Twice, so an instant next to a DST change takes the offset it lands on.
  const first = asUtc - offsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetMs(new Date(first), timeZone));
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `+0300`: the offset of `timeZone` at `date`, as a mail header writes it. */
function mailOffset(date: Date, timeZone: string) {
  const minutes = Math.round(offsetMs(date, timeZone) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The `Date:` header of a letter written at `date` in `timeZone` (RFC 5322). */
export function mailDate(date: Date, timeZone: string) {
  const clock = wallClock(date, timeZone);
  const day = weekday(clock);
  return `${weekdayNames[day] ?? ""}, ${String(clock.day)} ${monthNames[clock.month - 1] ?? ""} ${String(clock.year)} ${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)} ${mailOffset(date, timeZone)}`;
}

/** `hh:mm` of `date` on the tester's clock. */
export function clockTime(date: Date, timeZone: string) {
  const { hour, minute } = wallClock(date, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** «25.09» — the day the way the letters write it. */
export function shortDate(day: LocalDay) {
  return `${pad(day.day)}.${pad(day.month)}`;
}

/** Night by the benchmark: 23:00–07:00 on the person's clock (d10, d11). */
export function isNight(date: Date, timeZone: string) {
  const { hour } = wallClock(date, timeZone);
  return hour >= 23 || hour < 7;
}

/**
 * A moment the tester names by hand: an ISO time with its offset, or
 * `hh:mm` / `YYYY-MM-DD hh:mm` on the tester's own clock.
 */
export function parseLocalMoment(text: string, now: Date, timeZone: string) {
  const trimmed = text.trim();
  const local = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}:\d{2})$/u.exec(
    trimmed
  );
  if (local) {
    const today = localDay(now, timeZone);
    const day = local[1]
      ? {
          day: Number(local[3]),
          month: Number(local[2]),
          year: Number(local[1]),
        }
      : today;
    return zonedInstant(day, local[4] ?? "", timeZone);
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed)) {
    throw new Error(
      `Pass the time as hh:mm, YYYY-MM-DD hh:mm or ISO with an offset, got ${JSON.stringify(text)}.`
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Not a time: ${JSON.stringify(text)}.`);
  }
  return parsed;
}
