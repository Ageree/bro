import { normalized } from "@agent/lib/bro-to-bro/numbers";
import { spokenWords } from "@agent/lib/browser-use/said";
import { zonedIso } from "@agent/lib/google-workspace/availability";
import {
  comparableWords,
  placeNamedIn,
  wordStem,
} from "@shared/bro-to-bro/owner-set";

/**
 * What the owner named themself, read from their own words (docs/bro-to-bro.md,
 * «Что владелец назвал сам»). `bro_talk start` and `answer` get a time, a
 * venue and a sum from the main Bro, which may have filled them in from
 * memory; only what these checks find in the message that opened the
 * owner's turn may go to the other Bro without asking, or set an agreement
 * the owner need not confirm again. Every check fails closed: a miss means
 * one more question, never one more disclosure. A time and a place are read
 * clause by clause — «в субботу в 18 или в воскресенье в 19» names no
 * Saturday at 19:00 — and a clause that says no («не могу», «не в Пушкине»)
 * names nothing.
 */

const dayMs = 24 * 60 * 60_000;

/**
 * The owner's words of the turn as one text to read: the voice page's marker
 * and the voice's own lines between them gone (`spokenWords`) — Bro's
 * question «в 19:00 подойдёт?» is not the owner's answer — numbers said in
 * words as digits, lower case, «ё» as «е».
 */
export function ownerText(said: readonly string[] | null) {
  return normalized((said ?? []).map((text) => spokenWords(text)).join("\n"))
    .toLowerCase()
    .replaceAll("ё", "е");
}

/**
 * The text's clauses: split at the ends of sentences and at «или», «либо»,
 * «а», «но», which set one choice against another.
 */
function clauses(text: string) {
  return text
    .split(/(?<!\d)[.!?]+|[.!?]+(?!\d)|[;\n]+|\s(?:или|либо|а|но)\s/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
}

/** A clause that says no: «не могу», «не в Пушкине», «занят», «нельзя», «вместо субботы». */
function negated(clause: string) {
  return /(?<!\p{L})(?:не|нет|ни|нельзя|никак|кроме|вместо|занят\p{L}*|на\s+работе|работаю|уезжаю|в\s+отъезде)(?!\p{L})/u.test(
    clause
  );
}

/** A clause that only weighs it: «может», «если», «думаю», «посмотрим». */
const doubt =
  /(?<!\p{L})(?:может|наверн\p{L}*|если|думаю|думает|подумаю|посмотрим|не\s+знаю|вроде)(?!\p{L})/u;

/**
 * Someone else's words or a request to someone else: «Петя написал: …»,
 * «попроси его …», «пусть он купит», «он предлагает …», «его вариант: …».
 */
const othersWords =
  /(?<!\p{L})(?:написал\p{L}*|пишет|сказал\p{L}*|говорит|просит|попроси\p{L}*|пусть|предлагает|предложил\p{L}*|предложени\p{L}*|вариант\p{L}*|ответ|ответил\p{L}*|мнени\p{L}*|словам|пересла\p{L}*|пересылаю|спрашивает|спросил\p{L}*|хочет)(?!\p{L})/u;

/**
 * The clauses in which the owner says yes to something in their own words:
 * nothing in quotes (someone else's words, pasted) — with `names`, the
 * venue check's, a name of one or two words in quotes («Пушкин») stays,
 * but never a quoted line after a colon — no clause of someone else's
 * speech or of a request to someone, none that says no or only weighs it.
 * A quote left open takes the rest of the text with it.
 */
function affirmed(text: string, names = false) {
  const own = text
    .replaceAll(/:\s*[«"“„][^»"”“]*[»"”“]/gu, " ")
    .replaceAll(/[«"“„]([^»"”“]*)[»"”“]/gu, (_quote, inner: string) =>
      names && inner.trim().split(/\s+/u).length <= 2 ? inner : " "
    )
    .replace(/[«»"“”„].*$/su, " ");
  return clauses(own).filter(
    (clause) =>
      !negated(clause) && !othersWords.test(clause) && !doubt.test(clause)
  );
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

/** The local date `days` after a local date: «2026-10-31». */
function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs)
    .toISOString()
    .slice(0, 10);
}

/** 0 for Sunday … 6 for Saturday, of a local date. */
function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const weekdays: readonly (readonly [RegExp, number])[] = [
  [/(?<!\p{L})(?:понедельник\p{L}{0,2}|пн)(?!\p{L})/u, 1],
  [/(?<!\p{L})(?:вторник\p{L}{0,2}|вт)(?!\p{L})/u, 2],
  [/(?<!\p{L})(?:сред(?:а|у|ы|е|ой)|ср)(?!\p{L})/u, 3],
  [/(?<!\p{L})(?:четверг\p{L}{0,2}|чт)(?!\p{L})/u, 4],
  [/(?<!\p{L})(?:пятниц\p{L}{0,2}|пт)(?!\p{L})/u, 5],
  [/(?<!\p{L})(?:суббот\p{L}{0,2}|сб)(?!\p{L})/u, 6],
  [/(?<!\p{L})(?:воскресень\p{L}{0,2}|вс)(?!\p{L})/u, 0],
];

const months = [
  "январ",
  "феврал",
  "март",
  "апрел",
  "ма[йяе]",
  "июн",
  "июл",
  "август",
  "сентябр",
  "октябр",
  "ноябр",
  "декабр",
];

/**
 * The local dates a clause names, from today on the owner's clock:
 * «сегодня», «завтра», «послезавтра», a weekday (its next one, and the one
 * a week on when it is today), «на выходных», «31.10», «31 октября».
 */
function namedDays(text: string, now: number, timeZone: string) {
  const today = zonedIso(now, timeZone).slice(0, 10);
  const days = new Set<string>();
  if (/(?<!\p{L})сегодня(?!\p{L})/u.test(text)) days.add(today);
  if (/(?<!\p{L})завтра(?!\p{L})/u.test(text)) days.add(addDays(today, 1));
  if (/(?<!\p{L})послезавтра(?!\p{L})/u.test(text)) days.add(addDays(today, 2));
  const ahead = (day: number) => (day - weekday(today) + 7) % 7;
  for (const [pattern, day] of weekdays) {
    if (!pattern.test(text)) continue;
    days.add(addDays(today, ahead(day)));
    if (ahead(day) === 0) days.add(addDays(today, 7));
  }
  if (/(?<!\p{L})выходн\p{L}*/u.test(text)) {
    const saturday = ahead(6);
    for (const offset of saturday === 6 ? [0, 6, 7] : [saturday, saturday + 1])
      days.add(addDays(today, offset));
  }
  const year = Number(today.slice(0, 4));
  const dated = (day: number, month: number) => {
    if (day < 1 || day > 31 || month < 1 || month > 12) return;
    const thisYear = `${String(year)}-${twoDigits(month)}-${twoDigits(day)}`;
    days.add(
      thisYear < today
        ? `${String(year + 1)}-${twoDigits(month)}-${twoDigits(day)}`
        : thisYear
    );
  };
  for (const match of text.matchAll(
    /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?(?![\d:])/gu
  ))
    dated(Number(match[1]), Number(match[2]));
  for (const match of text.matchAll(
    new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${months.join("|")})\\p{L}*`, "gu")
  ))
    dated(
      Number(match[1]),
      months.findIndex((month) =>
        new RegExp(`^${month}`, "u").test(match[2] ?? "")
      ) + 1
    );
  return days;
}

function clock(hour: number, minute = 0) {
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

/** «после 19», «с 18», «до 21»: an hour that bounds a window, not a time to meet at. */
const boundPhrase =
  /(?<!\p{L})(?:после|с|со|от|позже|до|раньше)\s+(?:[01]?\d|2[0-4])(?:[:.][0-5]\d)?(?![\d:.])(?:\s*час\p{L}*)?/gu;

/**
 * The clock times a clause names, as «19:00»: «19:00», «19.30», «в 19», «к
 * 7 вечера» (19:00); a bare «в 7» may be morning or evening, and «в
 * полдень» is 12:00. `meet`: only an hour to meet at — «в», «к», «около»,
 * never «до 18» or «с 2 детьми».
 */
function clockTimes(text: string, meet = false) {
  const times = new Set<string>();
  for (const match of text.matchAll(
    /(?<![\d.:])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d.:])/gu
  ))
    times.add(clock(Number(match[1]), Number(match[2])));
  for (const match of text.matchAll(
    meet
      ? /(?<!\p{L})(?:в|к|ко|около)\s+([01]?\d|2[0-4])(?![\d:.])(?:\s*час\p{L}*)?(?:\s+(утра|дня|вечера|вечером|ночи))?/gu
      : /(?<!\p{L})(?:в|к|ко|с|со|около|до|после|от)\s+([01]?\d|2[0-4])(?![\d:.])(?:\s*час\p{L}*)?(?:\s+(утра|дня|вечера|вечером|ночи))?/gu
  )) {
    const hour = Number(match[1]) % 24;
    const part = match[2];
    if (part === "утра" || hour >= 12 || hour === 0) times.add(clock(hour));
    else if (part === "дня" || part === "вечера" || part === "вечером")
      times.add(clock(hour + 12));
    else {
      times.add(clock(hour));
      times.add(clock(hour + 12));
    }
  }
  if (/(?<!\p{L})полдень|полудн/u.test(text)) times.add(clock(12));
  return times;
}

/** How many days a clause names: «в субботу», «завтра», «31.10», «на выходных» — each one. */
function dayMentions(clause: string) {
  const counted = [
    /(?<!\p{L})(?:сегодня|завтра|послезавтра)(?!\p{L})/gu,
    /(?<!\p{L})(?:понедельник\p{L}{0,2}|вторник\p{L}{0,2}|сред(?:а|у|ы|е|ой)|четверг\p{L}{0,2}|пятниц\p{L}{0,2}|суббот\p{L}{0,2}|воскресень\p{L}{0,2}|пн|вт|ср|чт|пт|сб|вс)(?!\p{L})/gu,
    /(?<!\p{L})выходн\p{L}*/gu,
    /(?<![\d.:])(?:0?[1-9]|[12]\d|3[01])[./](?:0?[1-9]|1[0-2])(?:[./]\d{2,4})?(?![\d:])/gu,
    /(?<!\d)\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*/gu,
  ];
  return counted.reduce(
    (sum, pattern) => sum + [...clause.matchAll(pattern)].length,
    0
  );
}

/** How many hours to meet at a clause names: «19:00», «в 19», «к 7 вечера». */
function meetingHours(clause: string) {
  return (
    [...clause.matchAll(/(?<![\d.:])(?:[01]?\d|2[0-3])[:.][0-5]\d(?![\d.:])/gu)]
      .length +
    [
      ...clause.matchAll(
        /(?<!\p{L})(?:в|к|ко|около)\s+(?:[01]?\d|2[0-4])(?![\d:.])/gu
      ),
    ].length
  );
}

/** Hours of the day a word for its part covers: «вечером» is 17:00–24:00. */
const dayParts: readonly (readonly [RegExp, number, number])[] = [
  [/(?<!\p{L})утр\p{L}*/u, 5, 12],
  [/(?<!\p{L})(?:дн[её]м|обед\p{L}*)(?!\p{L})/u, 12, 18],
  [/(?<!\p{L})вечер\p{L}*/u, 17, 24],
  [/(?<!\p{L})ноч\p{L}*/u, 21, 24],
];

/** The hours of a day a clause allows: its parts of the day, between «после 19» and «до 21». */
function allowedSpans(clause: string) {
  const parts = dayParts.filter(([pattern]) => pattern.test(clause));
  const hours = (pattern: RegExp) =>
    [...clause.matchAll(pattern)].map(
      (match) => Number(match[1]) + Number(match[2] ?? 0) / 60
    );
  const after = hours(
    /(?<!\p{L})(?:после|с|со|от|позже)\s+([01]?\d|2[0-3])(?:[:.]([0-5]\d))?(?![\d:.])/gu
  );
  const before = hours(
    /(?<!\p{L})(?:до|раньше)\s+([01]?\d|2[0-4])(?:[:.]([0-5]\d))?(?![\d:.])/gu
  );
  const lowest = after.length > 0 ? Math.min(...after) : 0;
  const latest = before.length > 0 ? Math.max(...before) : 24;
  return (
    parts.length === 0
      ? [[0, 24] as const]
      : parts.map(([, from, to]) => [from, to] as const)
  ).map(
    ([from, to]) => [Math.max(from, lowest), Math.min(to, latest)] as const
  );
}

/**
 * Whether the owner's words name this time. An exact start: one clause that
 * says yes names its day and its hour together. A window: no hour to meet
 * at is named at all (then only the exact start fits what was said), and
 * each day the window touches is named by a clause that says yes, the
 * window no wider there than that clause's parts of the day («вечером») and
 * bounds («после 19», «до 21»).
 */
export function namedTime(
  text: string,
  time: {
    readonly at: string | null;
    readonly window: { readonly from: string; readonly to: string };
  },
  timeZone: string,
  now: number
) {
  // «в субботу вечером у меня футбол»: what they have on then, no time to meet.
  const said = affirmed(text).filter(
    (clause) => !/(?<!\p{L})у\s+меня(?!\p{L})/u.test(clause)
  );
  if (time.at !== null) {
    const local = zonedIso(Date.parse(time.at), timeZone);
    // One day and one hour in the clause: «в субботу в 18, в воскресенье
    // в 19» pairs neither for sure.
    return said.some((clause) => {
      return (
        dayMentions(clause) === 1 &&
        namedDays(clause, now, timeZone).has(local.slice(0, 10)) &&
        meetingHours(clause) === 1 &&
        clockTimes(clause, true).has(local.slice(11, 16))
      );
    });
  }
  if (
    clauses(text).some(
      (clause) => clockTimes(clause.replaceAll(boundPhrase, " ")).size > 0
    )
  )
    return false;
  const from = Date.parse(time.window.from);
  const to = Date.parse(time.window.to);
  if (!(to > from) || to - from > 14 * dayMs) return false;
  const hours = (at: number) => {
    const local = zonedIso(at, timeZone);
    return Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60;
  };
  const first = zonedIso(from, timeZone).slice(0, 10);
  const last = zonedIso(to - 1, timeZone).slice(0, 10);
  let date = first;
  for (let guard = 0; guard < 15 && date <= last; guard += 1) {
    const begins = date === first ? hours(from) : 0;
    const ends = date === last ? hours(to - 1) + 1 / 60 : 24;
    const day = date;
    if (
      !said.some(
        (clause) =>
          namedDays(clause, now, timeZone).has(day) &&
          allowedSpans(clause).some(
            ([start, end]) => start <= begins + 1e-9 && ends <= end + 1e-9
          )
      )
    )
      return false;
    date = addDays(date, 1);
  }
  return true;
}

/** A length said as a count of hours or minutes, in minutes: «2 часа», «40 минут». */
function minutesOf(count: string | undefined, unit: string | undefined) {
  return (
    Number((count ?? "").replace(",", ".")) *
    ((unit ?? "").startsWith("мин") ? 1 : 60)
  );
}

/**
 * The length of a meeting the owner's words name, in minutes — «на час»,
 * «на полчаса», «минут на 40», «ненадолго», «до 20» after the exact start
 * — the shortest of any they name anywhere, or null when they name none: a
 * length read too short means one more question, never a longer meeting.
 */
export function meetingLength(
  text: string,
  start: string | null,
  timeZone: string
) {
  const lengths: number[] = [];
  for (const match of text.matchAll(
    /(?<!\p{L})(?:на|ровно|всего|только|максимум|больше|более|дольше)\s+(\d+(?:[.,]\d+)?)\s*(час|мин)/gu
  ))
    lengths.push(minutesOf(match[1], match[2]));
  for (const match of text.matchAll(
    /(?<!\p{L})(час|минут)\p{L}*\s+на\s+(\d+(?:[.,]\d+)?)/gu
  ))
    lengths.push(minutesOf(match[2], match[1]));
  for (const match of text.matchAll(
    /(?<![\d.:])(\d+)\s*мин(?:ут\p{L}*|\.)?(?!\p{L})/gu
  ))
    lengths.push(Number(match[1]));
  if (
    /(?<!\p{L})(?:(?:на|ровно|всего|только|максимум|больше|более|дольше)\s+час|часик|часок|часочек)(?!\p{L})/u.test(
      text
    )
  )
    lengths.push(60);
  if (/(?<!\p{L})полтора\s+час/u.test(text)) lengths.push(90);
  if (
    /(?<!\p{L})(?:полчас\p{L}*|ненадолго|на\s+минутку|по-быстрому|по\s+быстрому)(?!\p{L})/u.test(
      text
    )
  )
    lengths.push(30);
  if (start !== null) {
    const local = zonedIso(Date.parse(start), timeZone);
    const begins =
      Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60;
    for (const match of text.matchAll(
      /(?<!\p{L})до\s+([01]?\d|2[0-4])(?:[:.]([0-5]\d))?(?![\d:.])/gu
    )) {
      const ends = Number(match[1]) + Number(match[2] ?? 0) / 60;
      // «в 7 вечера до 9»: the end is past the start.
      const after = ends <= begins && ends + 12 > begins ? ends + 12 : ends;
      lengths.push(Math.round((after - begins) * 60));
    }
  }
  const named = lengths.filter((minutes) => minutes > 0);
  return named.length > 0 ? Math.min(...named) : null;
}

/**
 * Whether a place reads as someone's home, address or workplace rather than
 * a venue anyone may walk into: a flat, an entrance, a floor, «у меня», «ко
 * мне», a dacha, an office, a house number.
 */
export function homeLike(text: string) {
  const words = text.normalize("NFKC").toLowerCase().replaceAll("ё", "е");
  return (
    /\d/u.test(words) ||
    /(?<!\p{L})(?:дом(?:а|ой|у|ик\p{L}*)?|квартир\p{L}*|кв|подъезд\p{L}*|этаж\p{L}*|домофон\p{L}*|дач\p{L}*|офис\p{L}*|работ\p{L}*|общаг\p{L}*|общежити\p{L}*|у\s+(?!метро|станци|вход|фонтан|памятник|парк|реки|моря|озера|пруд)\p{L}+|ко\s+мне|к\s+(?:нам|нему|ней|ним|тебе|вам|себе|маме|папе|родител\p{L}*|бабушк\p{L}*|дедушк\p{L}*)|в\s+гост\p{L}*)(?!\p{L})/u.test(
      words
    )
  );
}

/**
 * Whether the owner's words name this venue: every word of its name in one
 * clause that says yes, and no home or address in it.
 */
export function namedPlace(text: string, place: string) {
  return (
    !homeLike(place) &&
    affirmed(text, true).some((clause) =>
      placeNamedIn(place, comparableWords(clause))
    )
  );
}

/** Money in another currency: never the owner's roubles. */
const foreignMoney =
  /[$€£¥]|(?<!\p{L})(?:usd|eur|gbp|долл\p{L}*|бакс\p{L}*|евро|юан\p{L}*|фунт\p{L}*)(?!\p{L})/iu;

/** Whether a text speaks of money in another currency. */
export function foreignCurrency(text: string) {
  return foreignMoney.test(text);
}

/**
 * Money a text speaks of without a sum to read: a sign, a unit, «деньги»,
 * «бюджет», a price, a bound on a sum, slang for one («косарь»,
 * «пятихатка», «лям», «пара штук»).
 */
export const moneyWords =
  /[₽$€£¥]|(?<!\p{L})(?:руб\p{L}*|тыс\p{L}*|тыщ\p{L}*|косар\p{L}*|деньг\p{L}*|денег|бюджет\p{L}*|сумм\p{L}*|млн\p{L}*|миллион\p{L}*|лям\p{L}*|штук\p{L}*|сотк\p{L}*|сотн\p{L}*|сотен|пятихат\p{L}*|полтос\p{L}*|полтинник\p{L}*|кус(?:ок|ка|ков)|копе\p{L}*|цен(?:а|у|ы|е|ой|ам|ами|ах)?|ценник\p{L}*|стоимост\p{L}*|стоит|стоят|стоил\p{L}*|дорого|дороже|дешево|дешевле|скидк\p{L}*|максимум|минимум|не\s+больше|не\s+более|не\s+дороже|в\s+пределах|налич\p{L}*|на\s+карт\p{L}*)(?!\p{L})/iu;

/** A number with its scale: «3 000», «2,5 тыс.», «5к», «1 млн», and what follows it. */
const amountPattern =
  /(?<![\d.,])(\d{1,3}(?:[\s\u00a0\u202f]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\d])\s*(тыс\p{L}*|тыщ\p{L}*|косар\p{L}*|к(?!\p{L})|k(?!\p{L})|млн\p{L}*|миллион\p{L}*)?/gu;

/** A text without its clock times and dates, whose numbers are no sums. */
function withoutDates(text: string) {
  return normalized(text)
    .toLowerCase()
    .replaceAll(/(?<![\d.:])\d{1,2}[:.][0-5]\d(?![\d.:])/gu, " ")
    .replaceAll(/(?<![\d.:])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\d:])/gu, " ")
    .replaceAll(
      new RegExp(`(?<!\\d)\\d{1,2}\\s+(?:${months.join("|")})\\p{L}*`, "gu"),
      " "
    );
}

function amountOf(match: RegExpMatchArray) {
  const whole = Number((match[1] ?? "").replaceAll(/\D/gu, ""));
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  const unit = match[3] ?? "";
  const scale = /^(?:млн|миллион)/u.test(unit)
    ? 1_000_000
    : unit === ""
      ? 1
      : 1000;
  return Math.round((whole + fraction) * scale);
}

/**
 * Every number a text names as a sum could be, in roubles — «3000», «3 000
 * ₽», «3 тысячи», «5к», «2,5 тыс.», «1 млн» — but a clock time or a date:
 * what the outgoing gate checks against the owner's own sums, so any number
 * beside money counts.
 */
export function namedAmounts(text: string) {
  return [...withoutDates(text).matchAll(amountPattern)]
    .map((match) => amountOf(match))
    .filter((value) => value > 0);
}

/**
 * The owner asks to keep it to themself: then nothing of what they said
 * goes on by itself, sums and promises included.
 */
const secret =
  /(?<!\p{L})(?:не\s+(?:говори|рассказывай|передавай|пиши|сообщай|называй|выдавай)|молчи|по\s+секрету|между\s+нами|только\s+для\s+тебя)(?!\p{L})/u;

/** Words that make a clause one about money itself. */
const moneyClause =
  /(?<!\p{L})(?:скин\p{L}*|скидыва\p{L}*|сбро\p{L}*|бюджет\p{L}*|сумм\p{L}*|стоит|стоят|стоимост\p{L}*|цен\p{L}*|плат\p{L}*|заплат\p{L}*|оплат\p{L}*|руб\p{L}*|деньг\p{L}*|денег|потрат\p{L}*|вложи\p{L}*|переве\p{L}*)(?!\p{L})|₽/u;

/**
 * Words right before a number that make it a sum in a clause about money,
 * or with a scale: «по 3000», «бюджет — 5к», «не больше 3 тысяч».
 */
const sumLead =
  /(?<!\p{L})(?:по|за|до|около|примерно|максимум|минимум|бюджет\p{L}*|сумм\p{L}*|стоимост\p{L}*|цен\p{L}*|стоит|стоят|скин\p{L}*|скидыва\p{L}*|сбро\p{L}*|заплат\p{L}*|оплат\p{L}*|потрат\p{L}*|переве\p{L}*|вложи\p{L}*|дам|дать|больше|меньше|более|дороже|дешевле|пределах)[\s:—–-]*$/u;

/** What may follow a sum: its currency, or a word that joins it on («по 3000 с каждого», «на подарок»). */
const afterSum =
  /^\s*(?:$|[,.;!?)—–-]|₽|руб\p{L}*|р\.|(?:на|с|со|за|каждо\p{L}*|человек\p{L}*|в|по|до|от|и|или|тогда|итого|всего)(?!\p{L}))/u;

/**
 * The sums in roubles the owner's words name, each in a construction of
 * money around it: a rouble sign or «руб» after it; a scale («тыс», «к»,
 * «млн») in a clause about money; or, in such a clause or with a scale, a
 * word of money right before it («скинемся по 3000», «бюджет 5к»). Not
 * «3000 листов» nor «листов 3000, цену узнай», not dollars, not a clock
 * time or a date, not «до 21».
 */
export function namedSums(text: string) {
  if (secret.test(text)) return [];
  return affirmed(withoutDates(text)).flatMap((clause) => {
    if (foreignCurrency(clause)) return [];
    const about = moneyClause.test(clause);
    return [...clause.matchAll(amountPattern)].flatMap((match) => {
      const after = clause.slice(match.index + match[0].length);
      // «3000 листов», «три тысячи листов»: a count, not a sum.
      if (!afterSum.test(after)) return [];
      const value = amountOf(match);
      const marked = /^\s*(?:₽|руб\p{L}*|р\.)/u.test(after);
      const scale = match[3] !== undefined;
      const lead = sumLead.test(clause.slice(0, match.index));
      // «до 21», «по 2»: an hour or a count, unless money marks it.
      if (!marked && !scale && value <= 24) return [];
      return value > 0 &&
        (marked || (lead && (scale || about)) || (scale && about))
        ? [value]
        : [];
    });
  });
}

/** The owner's own word of paying, buying or chipping in, said of themself. */
const paysPattern =
  /(?<!\p{L})(?:скинемся|скинусь|скидываемся|сброшусь|сбросимся|заплачу|заплатим|оплачу|оплатим|плачу|платим|куплю|купим|покупаю|покупаем|переведу|переведем|угощаю|угощу|угостим|вложусь|вложимся|подарим|беру\s+на\s+себя|за\s+мой\s+сч[её]т|(?:могу|готов\p{L}*)\s+(?:дать|скинуть|перевести|вложить|потратить|заплатить|оплатить|купить))(?!\p{L})/u;

/**
 * What the owner's words say they pay for, buy or chip in on, each as the
 * words after the verb in its clause («маме на подарок» of «скинемся маме
 * на подарок»): only a clause of their own that says yes (`affirmed`) and
 * names what it is for. Empty when they said nothing of it.
 */
export function paymentsSaid(text: string) {
  if (secret.test(text)) return [];
  return affirmed(text).flatMap((clause) => {
    const match = paysPattern.exec(clause);
    if (!match) return [];
    const object = clause
      .slice(match.index + match[0].length)
      .trim()
      .split(/\s+/u)
      .slice(0, 8)
      .join(" ");
    // What they pay for must be named: «торт я куплю» and «я плачу» name
    // nothing that a promise could be checked against.
    return objectWords(object).length > 0 ? [object] : [];
  });
}

/**
 * Words of no object: when, how, how much. A promise shares none of these
 * with the owner's to count as theirs («завтра» of «я куплю завтра торт»
 * covers no car).
 */
const objectStopWords = new Set([
  "бабушке",
  "брату",
  "вечером",
  "всем",
  "дедушке",
  "дочке",
  "другу",
  "жене",
  "маме",
  "мужу",
  "папе",
  "подруге",
  "сестре",
  "сыну",
  "вместе",
  "всегда",
  "всего",
  "завтра",
  "каждого",
  "каждому",
  "конечно",
  "обязательно",
  "послезавтра",
  "потом",
  "сначала",
  "сегодня",
  "также",
  "тысяч",
  "тысячи",
  "рублей",
  "рубля",
  "утром",
  "сразу",
]);

/** The words naming what a promise is for: four letters or more, no digits, no word of when, how or for whom. */
function objectWords(text: string) {
  return comparableWords(text).filter(
    (word) =>
      word.length >= 4 && !/\d/u.test(word) && !objectStopWords.has(word)
  );
}

/** The case endings of a name: «Марии», «Петром» — never «Марина» of «Мария». */
const nameEndings = new Set([
  "",
  "а",
  "е",
  "ей",
  "ем",
  "ею",
  "и",
  "й",
  "ой",
  "ом",
  "ою",
  "у",
  "ы",
  "ю",
  "я",
]);

/** Whether a word is one of a name's own forms, in any case: «Савелия» of «савелий». */
function nameForm(word: string, name: string) {
  const stem = /[аяйьоеиыу]$/u.test(name) ? name.slice(0, -1) : name;
  return (
    word === name ||
    (stem.length >= 2 &&
      word.startsWith(stem) &&
      nameEndings.has(word.slice(stem.length)))
  );
}

/**
 * Words a promise may hold besides what it is for, which need no saying:
 * whose it is, how it is said, when, and what joins them.
 */
const promiseFiller = new Set([
  "бро",
  "весь",
  "вечером",
  "вместе",
  "возьмет",
  "возьму",
  "вот",
  "все",
  "всю",
  "вся",
  "готов",
  "готова",
  "готовы",
  "давай",
  "давайте",
  "для",
  "днем",
  "его",
  "ему",
  "еще",
  "завтра",
  "здравствуй",
  "здравствуйте",
  "или",
  "конечно",
  "может",
  "можем",
  "мой",
  "мою",
  "моя",
  "наш",
  "наша",
  "нашу",
  "ней",
  "нее",
  "нему",
  "ним",
  "них",
  "ночью",
  "обязательно",
  "она",
  "они",
  "послезавтра",
  "потом",
  "предлагает",
  "предлагаю",
  "предложение",
  "предложению",
  "привет",
  "сам",
  "сама",
  "сами",
  "себе",
  "себя",
  "связи",
  "сегодня",
  "сможет",
  "согласен",
  "согласна",
  "сразу",
  "также",
  "тоже",
  "точно",
  "утром",
  "хочет",
  "хочу",
  "эта",
  "эти",
  "это",
  "этот",
  "эту",
]);

/** A word of paying, buying or chipping in, in any form: «оплатит», «скинется», «покупает». */
const promiseVerb =
  /^(?:за)?(?:плат|плач)|^о(?:плат|плач)|^(?:по)?куп|^скин|^скидыва|^сбро|^переве|^угощ|^угост|^влож|^бер[уеёи]|^обеща/u;

/** A day or a month, in any case: «субботу», «октября». */
const calendarWord =
  /^(?:понедельник|вторник|сред[аыуеой]|четверг|пятниц|суббот|воскресень|выходн|январ|феврал|март|апрел|ма[йяе]$|июн|июл|август|сентябр|октябр|ноябр|декабр)/u;

/**
 * Whether a promise to pay is all one the owner made: every word that says
 * what it is for, for whom or how much — all but its verb, the two
 * people's names (`names`, in their own forms), words of when and of no
 * object, and dates and times — is among the words of what they said they
 * pay for. «Савелий оплатит торт и автомобиль» after «я куплю торт» is not:
 * the car is nobody's word.
 */
export function paymentCovered(
  text: string,
  paysFor: readonly string[],
  names: readonly string[]
) {
  if (paysFor.length === 0) return false;
  const said = paysFor.flatMap((each) => comparableWords(each));
  const people = names.flatMap((name) => comparableWords(name));
  return comparableWords(withoutDates(text)).every(
    (word) =>
      (word.length <= 2 && !/\d/u.test(word)) ||
      promiseFiller.has(word) ||
      promiseVerb.test(word) ||
      calendarWord.test(word) ||
      people.some((person) => nameForm(word, person)) ||
      said.some((each) => each.startsWith(wordStem(word)))
  );
}

/**
 * Whether the owner's words name every point of the errand: each point's
 * words but the names of the two people of the link (`names`: «Савелий —
 * мясо и угли» needs «мясо» and «угли») in one clause that says yes. A
 * point nobody said — «Маша — торт» from memory — fails all of them: the
 * name of anyone else is a word to find too.
 */
export function namedItems(
  text: string,
  items: readonly string[],
  names: readonly string[]
) {
  const said = affirmed(text);
  const people = names.flatMap((name) => comparableWords(name));
  return (
    !secret.test(text) &&
    items.length > 0 &&
    items.every((item) => {
      const named = comparableWords(item)
        .filter((word) => !people.some((person) => nameForm(word, person)))
        .join(" ");
      return said.some((clause) =>
        placeNamedIn(named, comparableWords(clause))
      );
    })
  );
}
