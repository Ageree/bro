/**
 * Russia's production calendar, for a schedule the person asked to keep off
 * holidays («на праздники не присылай», «кроме праздников»: `skipHolidays`).
 * Only on request: a weekday pill reminder must still fire on 4 November.
 *
 * The zone stands in for the country, since a schedule keeps only its zone.
 */
const russianTimeZones = new Set([
  "Asia/Anadyr",
  "Asia/Barnaul",
  "Asia/Chita",
  "Asia/Irkutsk",
  "Asia/Kamchatka",
  "Asia/Khandyga",
  "Asia/Krasnoyarsk",
  "Asia/Magadan",
  "Asia/Novokuznetsk",
  "Asia/Novosibirsk",
  "Asia/Omsk",
  "Asia/Sakhalin",
  "Asia/Srednekolymsk",
  "Asia/Tomsk",
  "Asia/Ust-Nera",
  "Asia/Vladivostok",
  "Asia/Yakutsk",
  "Asia/Yekaterinburg",
  "Europe/Astrakhan",
  "Europe/Kaliningrad",
  "Europe/Kirov",
  "Europe/Moscow",
  "Europe/Samara",
  "Europe/Saratov",
  "Europe/Ulyanovsk",
  "Europe/Volgograd",
]);

/** Public holidays of the Labour Code (art. 112), as month and day. */
const publicHolidays = [
  [1, 1],
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  [1, 6],
  [1, 7],
  [1, 8],
  [2, 23],
  [3, 8],
  [5, 1],
  [5, 9],
  [6, 12],
  [11, 4],
] as const;

/**
 * Days off the government moved by its yearly decree: the January holidays
 * that fall on a weekend are moved wherever the decree says. A year without
 * a decree here counts only the Labour Code's own rules.
 */
const decreedDaysOff = new Map([
  // Постановление Правительства РФ от 24.09.2025 № 1466: Saturday 3 and
  // Sunday 4 January moved to Friday 9 January and Thursday 31 December.
  [2026, ["2026-01-09", "2026-12-31"]],
]);

/** `YYYY-MM-DD`; `month` is 1-based. */
function isoDate(year: number, month: number, day: number) {
  return [
    String(year),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function weekday(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const daysOffByYear = new Map<number, ReadonlySet<string>>();

/**
 * The public days off of `year` beyond ordinary weekends: the holidays
 * themselves, the next working day for each holiday outside January that
 * falls on a weekend (art. 112), and the decree's moves.
 */
function daysOff(year: number) {
  const cached = daysOffByYear.get(year);
  if (cached) return cached;
  const holidays = new Set(
    publicHolidays.map(([month, day]) => isoDate(year, month, day))
  );
  const off = new Set(holidays);
  for (const [month, day] of publicHolidays) {
    const dayOfWeek = weekday(year, month, day);
    if (dayOfWeek !== 0 && dayOfWeek !== 6) continue;
    if (month === 1) continue;
    // The weekend day moves to the first working day after the holiday.
    for (let next = day + 1; ; next += 1) {
      const date = new Date(Date.UTC(year, month - 1, next));
      const candidate = isoDate(
        year,
        date.getUTCMonth() + 1,
        date.getUTCDate()
      );
      const nextWeekday = date.getUTCDay();
      if (
        nextWeekday !== 0 &&
        nextWeekday !== 6 &&
        !holidays.has(candidate) &&
        !off.has(candidate)
      ) {
        off.add(candidate);
        break;
      }
    }
  }
  for (const date of decreedDaysOff.get(year) ?? []) off.add(date);
  daysOffByYear.set(year, off);
  return off;
}

/**
 * Whether a date (`month` 1-based) is a public holiday or a day off moved
 * for one in the person's country, judged by their time zone. Outside Russia
 * nothing is known, so nothing is.
 */
export function isPublicDayOff(
  timeZone: string,
  year: number,
  month: number,
  day: number
) {
  return (
    russianTimeZones.has(timeZone) &&
    daysOff(year).has(isoDate(year, month, day))
  );
}
