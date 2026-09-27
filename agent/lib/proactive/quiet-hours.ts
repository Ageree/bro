/**
 * Bro never writes first between 22:00 and 08:00 in the person's own zone.
 * The window is fixed on purpose: a proactive nudge is never urgent enough to
 * wake someone, and anything that is will still be there in the morning.
 */
const quietStartMinute = 22 * 60;
const quietEndMinute = 8 * 60;
const minutesPerDay = 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight of `now` on the person's own clock. */
export function localMinuteOfDay(now: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone,
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

/**
 * When the current quiet window ends, or `undefined` outside it. The end is
 * first counted in local minutes and then corrected by the local clock at
 * that instant, so a night with a DST shift still ends at 08:00 local.
 */
export function quietHoursEnd(now: Date, timeZone: string) {
  const minute = localMinuteOfDay(now, timeZone);
  const quiet = minute >= quietStartMinute || minute < quietEndMinute;
  if (!quiet) return undefined;
  const remaining =
    minute >= quietStartMinute
      ? minutesPerDay - minute + quietEndMinute
      : quietEndMinute - minute;
  const startOfMinute = now.getTime() - (now.getTime() % 60_000);
  const estimate = startOfMinute + remaining * 60_000;
  const drift = quietEndMinute - localMinuteOfDay(new Date(estimate), timeZone);
  return new Date(estimate + drift * 60_000);
}
