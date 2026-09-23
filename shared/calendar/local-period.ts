function calendarParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { day: value("day"), month: value("month"), year: value("year") };
}

/** `2026-09-18` on the workspace's own wall clock. */
export function localDayKey(now: Date, timeZone: string) {
  const { day, month, year } = calendarParts(now, timeZone);
  return `${year}-${month}-${day}`;
}

/** `2026-09` on the workspace's own wall clock. */
export function localMonthKey(now: Date, timeZone: string) {
  const { month, year } = calendarParts(now, timeZone);
  return `${year}-${month}`;
}
