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

/** Someone else's words: «Петя написал: …», «он предлагает …», «его вариант: …». */
const reportedWords =
  /(?<!\p{L})(?:написал\p{L}*|пишет|сказал\p{L}*|говорит|просит|предлагает|предложил\p{L}*|предложени\p{L}*|вариант\p{L}*|ответ|ответил\p{L}*|мнени\p{L}*|словам|пересла\p{L}*|пересылаю|спрашивает|спросил\p{L}*|хочет)(?!\p{L})/u;

/** A request to someone else: «попроси его …», «пусть он купит». */
const requestWords = /(?<!\p{L})(?:пусть|пускай|попроси\p{L}*)(?!\p{L})/u;

/**
 * Someone else's words introduced as such — «Петя написал:», or the
 * marker at the end of its line — and everything after it: code cannot
 * tell where they end.
 */
const reportedIntro = new RegExp(
  `${reportedWords.source}[^\\n.!?]*(?::|$)[\\s\\S]*$`,
  "mu"
);

/**
 * The text without anything in quotes — someone else's words, pasted —
 * nor a quoted line after a colon; with `names`, the venue check's, a name
 * of one or two words in quotes («Пушкин») stays. A quote left open takes
 * the rest of the text with it.
 */
function unquoted(text: string, names = false) {
  return text
    .replace(reportedIntro, " ")
    .replaceAll(/^[ \t]*>.*$/gmu, " ")
    .replaceAll(/:\s*[«"“„][^»"”“]*[»"”“]/gu, " ")
    .replaceAll(/[«"“„]([^»"”“]*)[»"”“]/gu, (_quote, inner: string) =>
      names && inner.trim().split(/\s+/u).length <= 2 ? inner : " "
    )
    .replace(/[«»"“”„].*$/su, " ");
}

/**
 * The clauses in which the owner says yes to something in their own words
 * (`unquoted`): no clause of someone else's speech or of a request to
 * someone, none that says no or only weighs it.
 */
function affirmed(text: string, names = false) {
  return clauses(unquoted(text, names)).filter(
    (clause) =>
      !negated(clause) &&
      !reportedWords.test(clause) &&
      !requestWords.test(clause) &&
      !doubt.test(clause)
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
  // Whole minutes, a day at most: «на 0,33 часа», «на 30 часов».
  const named = lengths
    .map((minutes) => Math.min(Math.round(minutes), 24 * 60))
    .filter((minutes) => minutes > 0);
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
  /^\s*(?:$|[,.;!?)—–-]|₽|руб\p{L}*|р\.|(?:на|с|со|за|каждо\p{L}*|в|по|до|от|и|или|тогда|итого|всего)(?!\p{L}))/u;

/**
 * The sums in roubles of these clauses, each in a construction of money
 * around it: a rouble sign or «руб» after it; a scale («тыс», «к», «млн»)
 * in a clause about money; or, in such a clause or with a scale, a word of
 * money right before it («скинемся по 3000», «бюджет 5к»). Not «3000
 * листов» nor «листов 3000, цену узнай», not dollars, not a clock time or
 * a date, not «до 21».
 */
function sumsOf(parts: readonly string[]) {
  return parts.flatMap((clause) => {
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

/** The sums in roubles the owner's own words name (`sumsOf`), in clauses that say yes. */
export function namedSums(text: string) {
  if (secret.test(text)) return [];
  return sumsOf(affirmed(withoutDates(text)));
}

/** Every sum a text names in a construction of money, whoever's words they are: what the envoy writes none of. */
export function sumsIn(text: string) {
  return sumsOf(clauses(withoutDates(text)));
}

/** The owner's own word of paying, buying or chipping in, said of themself. */
const paysPattern =
  /(?<!\p{L})(?:скинемся|скинусь|скидываемся|сброшусь|сбросимся|заплачу|заплатим|оплачу|оплатим|плачу|платим|куплю|купим|покупаю|покупаем|переведу|переведем|угощаю|угощу|угостим|вложусь|вложимся|подарим|беру\s+на\s+себя|за\s+мой\s+сч[её]т|(?:могу|готов\p{L}*)\s+(?:дать|скинуть|перевести|вложить|потратить|заплатить|оплатить|купить))(?!\p{L})/u;

/**
 * Words of paying, buying for someone or chipping in, and «за мой счёт»: a
 * promise of the owner's money, which the outgoing gate holds as money in
 * either version unless, in the second, the owner's words made it.
 */
export const paymentPattern =
  /(?<!\p{L})(?:заплат\p{L}*|заплач\p{L}*|куплю|купим|оплат\p{L}*|оплач\p{L}*|плачу|угощ\p{L}*|скинемся|скинусь|переведу|в долг)(?!\p{L})|за\s+(?:мой|свой|наш|его|её|ее)\s+сч[её]т/iu;

/** A verb's forms: each stem with each ending. */
function verbForms(stems: string, endings: readonly string[]) {
  return `(?:${stems})(?:${endings.join("|")})`;
}

const secondConjugation = [
  "ит",
  "ят",
  "им",
  "ишь",
  "ите",
  "ил",
  "ила",
  "ило",
  "или",
  "ить",
  "и",
  "ив",
];
const reflexiveSecond = [
  "ится",
  "ятся",
  "имся",
  "ишься",
  "итесь",
  "юсь",
  "ился",
  "илась",
  "ились",
  "иться",
  "ься",
  "ьтесь",
];
const firstConjugation = [
  "ет",
  "ют",
  "ем",
  "ешь",
  "ете",
  "ю",
  "л",
  "ла",
  "ли",
  "ть",
  "й",
  "йте",
];

/**
 * A word of paying, buying, chipping in or treating as a verb, in any
 * person and tense, with its prefixes — «оплатит», «доплатит», «прикупит»,
 * «скинетесь», «угостите», «раскошелится», «профинансирует» — and never a
 * noun that starts the same: «купе», «оплата», «подарок», «покупка».
 */
const payVerb = new RegExp(
  `^(?:${[
    verbForms("(?:за|о|до|про|вы|у|пере|рас)?плат", [
      ...secondConjugation,
      ...reflexiveSecond,
    ]),
    verbForms("(?:за|о|до|про|вы|у|пере|рас)?плач", [
      "у",
      "усь",
      "ивает",
      "ивают",
      "иваю",
      "иваем",
      "иваешь",
      "иваете",
      "ивать",
      "ивал",
      "ивала",
      "ивали",
      "ивай",
      "ивайте",
      "ен",
      "ено",
      "ена",
      "ены",
    ]),
    verbForms("(?:при|за|вы|до|на|ис|с)?куп", [...secondConjugation, "лю"]),
    verbForms("(?:по|за|при|вы|до|на|с)купа", firstConjugation),
    verbForms("скин", [
      "ет",
      "ется",
      "ешь",
      "ешься",
      "ем",
      "емся",
      "ете",
      "етесь",
      "ут",
      "утся",
      "у",
      "усь",
      "ул",
      "улся",
      "ула",
      "улась",
      "ули",
      "улись",
      "уть",
      "уться",
      "ь",
      "ься",
      "ьте",
      "ьтесь",
    ]),
    verbForms("скидыва", [
      ...firstConjugation,
      "ется",
      "ются",
      "емся",
      "ешься",
      "етесь",
      "юсь",
      "лся",
      "лась",
      "лись",
      "ться",
      "йся",
      "йтесь",
    ]),
    verbForms("сброс", [...secondConjugation, ...reflexiveSecond]),
    verbForms("сброш", ["у", "усь"]),
    verbForms("угост", secondConjugation),
    verbForms("угоща", firstConjugation),
    verbForms("угощ", ["у"]),
    verbForms("перевед", ["ет", "ут", "ем", "ешь", "ете", "у", "и", "ите"]),
    verbForms("перев", ["ел", "ела", "ели", "ести"]),
    verbForms("перевод", secondConjugation),
    verbForms("подар", secondConjugation),
    verbForms("влож", [
      ...secondConjugation,
      ...reflexiveSecond,
      "ат",
      "атся",
      "у",
      "усь",
    ]),
    verbForms("(?:по)?участв", [
      "ует",
      "уют",
      "уем",
      "уешь",
      "уете",
      "ую",
      "овал",
      "овала",
      "овали",
      "овать",
    ]),
    verbForms("раскошел", reflexiveSecond),
    verbForms("(?:про)?(?:финансир|спонсир)", [
      "ует",
      "уют",
      "уем",
      "уешь",
      "уете",
      "ую",
      "овал",
      "овала",
      "овали",
      "овать",
    ]),
  ].join("|")})$`,
  "u"
);

/** Words that only say how a promise is made: «берёт на себя», «возьмёт», «обещает». */
const promiseHow =
  /^(?:бер(?:ет|ут|у|ем|ешь|ете)|возьм(?:ет|ут|у|ем|ешь|ете)|обеща(?:ет|ют|ем|ю|л|ла|ли|ть|ешь|ете))$/u;

/** The parts of a clause a promise is read in: «я куплю торт, Борис купит машину» is two. */
function promiseParts(clause: string) {
  return clause
    .split(/[,:—–]|\s-\s/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** «за ним», «на нём», «с него»: whose a cost is, said without a verb. */
const onSomeone =
  /(?<!\p{L})(?:за\s+(?:ним|ней|ними|мной|нами|тобой|вами)|на\s+(?:нем|нём|ней|них|мне|нас|тебе|вас)|с\s+(?:него|нее|неё|них|меня|нас|тебя|вас))(?!\p{L})/iu;

/** «берёт на себя», «возьмёт на себя»: a promise, whatever it takes on. */
const takesOn =
  /(?<!\p{L})(?:бер[её]\p{L}*|беру|взял\p{L}*|возьм\p{L}*)\s+на\s+себя(?!\p{L})/iu;

/**
 * Whether a part of a text promises to pay: a word of paying as a verb
 * (`payVerb`), one of `paymentPattern`'s, «берёт на себя», or whose a cost is
 * without a verb («за ним», «на Савелии», «за Петром» of one of `people`).
 */
function promising(part: string, people: readonly string[] = []) {
  const words = comparableWords(part);
  const onPerson = words.some((word, index) =>
    people.some(
      (name) =>
        nameForm(word, name) &&
        word !== name &&
        // «за Петром», «на Савелии», «с Петра»: on them, from them.
        (((words[index - 1] === "за" || words[index - 1] === "на") &&
          /(?:ом|ем|ой|ей|е|и)$/u.test(word)) ||
          (words[index - 1] === "с" && /(?:а|я|ы|и)$/u.test(word)))
    )
  );
  return (
    paymentPattern.test(part) ||
    paysPattern.test(words.join(" ")) ||
    takesOn.test(part) ||
    onSomeone.test(part) ||
    onPerson ||
    words.some((word) => payVerb.test(word))
  );
}

/** A promise the owner made with the other person, in the first plural: «скинемся», «купим». */
const togetherPattern =
  /(?<!\p{L})(?:скинемся|скидываемся|сбросимся|заплатим|оплатим|платим|купим|покупаем|переведем|угостим|вложимся|подарим)(?!\p{L})/u;

/** Whether a part of the owner's words pays together with the other person («скинемся маме на подарок»). */
export function paysTogether(part: string) {
  return togetherPattern.test(comparableWords(part).join(" "));
}

/**
 * What the owner's words say they pay for, buy or chip in on: each promise
 * of a clause of their own that says yes (`affirmed`), read as a packet's is
 * (`readPromises`), with their word of paying («скинемся маме на подарок»,
 * «торт я куплю», «я плачу»; «скинемся вчетвером, я, Аня и Вика, на
 * юбилей маме» is one, whom with and for what). A promise of the
 * owner's goes only when all of it is in one of these (`paymentCovered`):
 * «я плачу» covers «Савелий заплатит» and no more. Empty when they said
 * nothing of it.
 */
export function paymentsSaid(text: string) {
  if (secret.test(text)) return [];
  return affirmed(text)
    .flatMap((clause) => readPromises(clause, []).promises)
    .filter((promise) => paysPattern.test(promise))
    .map((promise) => promise.slice(0, 200))
    .slice(0, 10);
}

/**
 * What the owner's words say someone else pays for, buys or chips in on:
 * each part of a clause of theirs with a word of paying but their own
 * promise («а купит пусть Савелий», «Борис платит за мясо») — not someone
 * else's words, a quote, a no or a doubt. The gate takes one only for a
 * promise of the person it names as the one who pays (`peerPaymentCovered`).
 */
export function peerPaysSaid(text: string) {
  if (secret.test(text)) return [];
  return clauses(unquoted(text))
    .filter(
      (clause) =>
        !negated(clause) && !reportedWords.test(clause) && !doubt.test(clause)
    )
    .flatMap((clause) => readPromises(clause, []).promises)
    .filter((promise) => !paysPattern.test(promise))
    .map((promise) => promise.slice(0, 200))
    .slice(0, 10);
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
 * whose it is, how it is said, when, and what joins them — a closed list.
 */
const promiseFiller = new Set([
  "чтобы",
  "покупка",
  "покупкой",
  "покупку",
  "годится",
  "идет",
  "норм",
  "нормально",
  "подойдет",
  "согласны",
  "устроит",
  "можешь",
  "можете",
  "сможешь",
  "сможете",
  "вариант",
  "договорились",
  "значит",
  "итак",
  "ладно",
  "ок",
  "окей",
  "отлично",
  "подходит",
  "супер",
  "так",
  "тогда",
  "хорошо",
  "будет",
  "будут",
  "договориться",
  "договоримся",
  "есть",
  "надо",
  "нужно",
  "обсудить",
  "понять",
  "предложить",
  "решить",
  "спросить",
  "узнать",
  "уточнить",
  "хотим",
  "хотят",
  "а",
  "бро",
  "бы",
  "в",
  "вечером",
  "вместе",
  "во",
  "возьмет",
  "возьму",
  "вот",
  "готов",
  "готова",
  "готовы",
  "давай",
  "давайте",
  "для",
  "днем",
  "до",
  "его",
  "ему",
  "еще",
  "же",
  "за",
  "завтра",
  "здравствуй",
  "здравствуйте",
  "и",
  "из",
  "или",
  "к",
  "ко",
  "конечно",
  "ли",
  "может",
  "можем",
  "мой",
  "мою",
  "моя",
  "на",
  "наш",
  "наша",
  "нашу",
  "ней",
  "нее",
  "нему",
  "ним",
  "них",
  "ночью",
  "о",
  "об",
  "обязательно",
  "она",
  "они",
  "от",
  "по",
  "послезавтра",
  "потом",
  "предлагает",
  "предлагаю",
  "предложение",
  "предложению",
  "привет",
  "с",
  "сам",
  "сама",
  "сами",
  "себе",
  "себя",
  "связи",
  "сегодня",
  "сможет",
  "со",
  "согласен",
  "согласна",
  "сразу",
  "также",
  "то",
  "тоже",
  "точно",
  "у",
  "утром",
  "хочет",
  "хочу",
  "эта",
  "эти",
  "это",
  "этот",
  "эту",
]);

/**
 * Whether a word names the one who pays, or one of the two people paying
 * with them: «Пётр» of the payer, «с Петром» of either — not «Петру», whom
 * it is for, nor the other one as the payer.
 */
function payerForm(
  word: string,
  names: {
    readonly payer: string;
    readonly other: string;
    readonly together?: boolean;
  }
) {
  return (
    comparableWords(names.payer).includes(word) ||
    // «ты», «вы»: the other one, whom the packet is written to.
    (names.together === true &&
      (comparableWords(names.other).includes(word) ||
        word === "ты" ||
        word === "вы")) ||
    [names.payer, names.other]
      .flatMap((name) => comparableWords(name))
      .some(
        (name) => nameForm(word, name) && /(?:ом|ем|ой|ей|ою|ею)$/u.test(word)
      )
  );
}

/** A day or a month, in any case: «субботу», «октября» — never «мартини». */
const calendarWord =
  /^(?:понедельник\p{L}{0,2}|вторник\p{L}{0,2}|сред(?:а|у|ы|е|ой)|четверг\p{L}{0,2}|пятниц\p{L}{0,2}|суббот\p{L}{0,2}|воскресень\p{L}{0,2}|выходн\p{L}{0,3}|январ[ьяюе]|феврал[ьяюе]|марта?|марте|апрел[ьяюе]|ма[йяюе]|июн[ьяюе]|июл[ьяюе]|августа?|августе|сентябр[ьяюе]|октябр[ьяюе]|ноябр[ьяюе]|декабр[ьяюе])$/u;

/**
 * Whether a promise to pay is all one the owner made: every word that says
 * what it is for, for whom or how much — all but its verb (`payVerb`,
 * `promiseHow`), the two people's names as the ones who pay or pay with
 * them (`names`, `payerForm`: «Петру» is whom it is for), the
 * closed list of words of when and of no object, and dates and times — is
 * among the words of what they said they pay for. «Савелий оплатит торт и
 * автомобиль» after «я куплю торт» is not: the car is nobody's word.
 */
export function paymentCovered(
  text: string,
  paysFor: readonly string[],
  names: {
    readonly payer: string;
    readonly other: string;
    /** The owner's words pay together with the other one: they pay too. */
    readonly together?: boolean;
  }
) {
  if (paysFor.length === 0) return false;
  const said = paysFor.flatMap((each) => comparableWords(each));
  return comparableWords(withoutDates(text)).every(
    (word) =>
      promiseFiller.has(word) ||
      payVerb.test(word) ||
      promiseHow.test(word) ||
      calendarWord.test(word) ||
      payerForm(word, names) ||
      said.some((each) => each.startsWith(wordStem(word)))
  );
}

/** A word that makes a short sentence go on with the one before it: «И шубу.», «Шубу тоже.». */
const goesOn = /^(?:и|а|ещ[её]|также|тоже|плюс)$/u;

/** A preposition: what follows it is no subject («для Николь», «у Петра»). */
const preposition =
  /^(?:для|у|к|ко|от|с|со|о|об|про|за|на|без|при|по|через|кроме|вместо|из|до)$/u;

/** A word asking who: «кто», «кому». */
const whoWord = /^(?:кто|кого|кому|кем)$/u;

/**
 * The promises to pay a text makes, as code reads them whoever retells
 * them: each part of a sentence with a word of paying (`promising`), and with
 * it every part beside it that names neither person as one who pays —
 * «машину и билеты» of «Савелий оплатит торт, машину и билеты»,
 * «автомобиль для Петра», «а шубу — тоже он», «машину» of «Машину, торт
 * Савелий оплатит», what follows a colon — and the next short sentence that
 * goes on with it («И шубу.», «Шубу тоже.»). A name before a dash is whose
 * the next one is. A part with one of them as its subject that pays nothing
 * («Пётр за») is a statement of its own, and so is a question of who pays
 * that names nobody as paying: one that starts with «кто» or «кому», or asks
 * it in a sentence that asks («кто из вас купит?»). `unread`: a sentence
 * with a word of paying in which code read no promise and no such question.
 */
/**
 * What says only that one of them agrees, or brings in what follows: «за»,
 * «согласен», «не против», «предлагает» (, чтобы…). Not «тоже», «в деле»,
 * «готов»: next to a promise they join its payers («Савелий тоже»).
 */
const agreeing =
  /^(?:за|согласен|согласна|согласны|не против|рад|рада|подтвердит|предлагает|предлагаю|хочет|просит|считает|думает)$/u;

/** A question of who pays without its «кто» and «из вас»: what it asks to be paid for. */
function askedFor(question: string) {
  return comparableWords(question)
    .filter((word) => !whoWord.test(word))
    .join(" ")
    .replaceAll(/(?<!\p{L})из\s+(?:вас|нас|них)(?!\p{L})/gu, " ")
    .trim();
}

function readPromises(text: string, names: readonly string[]) {
  const people = names.flatMap((name) => comparableWords(name));
  const isName = (word: string) => people.some((name) => nameForm(word, name));
  const subjectWord = (word: string) =>
    people.includes(word) || /^(?:ты|вы|я|мы|он|она|они)$/u.test(word);
  // Whom words name as the one who acts: a name as it is or «я», «ты», «он»
  // — not after a preposition, whose name it is a promise is for («для
  // Николь»).
  const subjectsIn = (words: readonly string[]) =>
    words.filter(
      (word, index) =>
        !preposition.test(words[index - 1] ?? "") && subjectWord(word)
    );
  // A part that says only that one of them agrees: «Пётр за», «а он не
  // против». Any other part with whose it is goes with the promise next to
  // that part: «а он ещё и автомобиль» is the same promise.
  const agrees = (words: readonly string[]) => {
    const rest = words.filter(
      (word) => !/^(?:а|и|но|да|ну|тогда|так)$/u.test(word)
    );
    return subjectWord(rest[0] ?? "") && agreeing.test(rest.slice(1).join(" "));
  };
  const promises: string[][] = [];
  const questions: string[] = [];
  let unread = false;
  const pieces = normalized(text).split(/((?<!\d)[.!?]+|[.!?]+(?!\d)|[;\n]+)/u);
  for (let index = 0; index < pieces.length; index += 2) {
    const sentence = (pieces[index] ?? "").trim();
    const asks = (pieces[index + 1] ?? "").includes("?");
    const words = comparableWords(sentence);
    if (
      promises.length > 0 &&
      words.length > 0 &&
      words.length <= 4 &&
      words.some((word) => goesOn.test(word)) &&
      !words.some((word) => isName(word)) &&
      !promising(sentence, people)
    ) {
      promises.at(-1)?.push(sentence);
      continue;
    }
    const read = promises.length;
    let asking = false;
    const asked: string[] = [];
    const besides: string[] = [];
    // What comes before a colon introduces what follows: «предлагаю так:».
    for (const segment of sentence.split(":")) {
      let before: string[] = [];
      for (const part of promiseParts(segment)) {
        const own = comparableWords(part);
        // A question of who pays names nobody as paying, and its verb is no
        // promise of the owner's own («кому надо заплачу» is one).
        if (
          subjectsIn(own).length === 0 &&
          !paysPattern.test(own.join(" ")) &&
          (whoWord.test(own[0] ?? "") ||
            (asks && own.some((word) => whoWord.test(word))))
        ) {
          asking = true;
          before = [];
          if (promising(part, people)) asked.push(part);
          continue;
        }
        if (!agrees(own)) besides.push(...own);
        if (promising(part, people)) {
          promises.push([...before, part]);
          before = [];
        } else if (agrees(own)) before = [];
        else if (own.length > 0 && own.every((word) => isName(word)))
          before = [part];
        else if (promises.length > 0) promises.at(-1)?.push(part);
        else before.push(part);
      }
    }
    if (asked.length > 0) {
      // Whom the question is of, when the sentence or the short one after
      // it names them: «…, если не Савелий?», «Кто оплатит? Савелий.».
      let payers = subjectsIn(besides);
      const next = comparableWords(pieces[index + 2] ?? "");
      if (
        payers.length === 0 &&
        next.length > 0 &&
        next.length <= 3 &&
        next.every((word) => subjectWord(word) || /^(?:и|или)$/u.test(word))
      ) {
        payers = next.filter((word) => subjectWord(word));
        index += 2;
      }
      for (const part of asked)
        if (payers.length > 0)
          promises.push([[...payers, askedFor(part)].join(" ")]);
        else questions.push(part);
    }
    if (promises.length === read && !asking && promising(sentence, people))
      unread = true;
  }
  return {
    promises: promises.map((promise) => promise.join(" ")),
    questions,
    unread,
  };
}

/** The promises to pay texts make, as code reads them (`readPromises`). */
export function promisesIn(texts: readonly string[], names: readonly string[]) {
  return texts.flatMap((text) => readPromises(text, names).promises);
}

/**
 * The questions of who pays texts ask (`readPromises`), without their «кто»
 * and «из вас»: what they ask to be paid for, which a question tells the
 * peer as much as a promise does («кто купит шубу?»).
 */
export function paymentQuestions(
  texts: readonly string[],
  names: readonly string[]
) {
  return texts.flatMap((text) =>
    readPromises(text, names).questions.map((question) => askedFor(question))
  );
}

/** Whether a text has a word of paying code reads no promise in (`readPromises`): then it is held. */
export function paymentsUnread(
  texts: readonly string[],
  names: readonly string[]
) {
  return texts.some((text) => readPromises(text, names).unread);
}

/** Whether words hold a word in any of its forms: «подарок» of «подарка». */
function holdsWord(words: readonly string[]) {
  return (word: string) =>
    words.some((other) => other.startsWith(wordStem(word)));
}

/**
 * What a promise the checker quoted is judged as, in the packet's own words
 * (the texts): nothing — so it is held — when it retells them, a word of it
 * but its verb and filler being in none of them («подарок» for «шубу»), or
 * when it pays (`promising`) and code reads no promise of its payer in them
 * (`promisesIn`, which code judges itself); the quote itself when it names
 * its payer as they are, or pays nothing («предлагает подарок маме»); and,
 * when it names no payer («купит подарок»), each promise code reads that
 * holds all its words («Пётр купит подарок маме»).
 */
export function promiseReadings(
  promise: string,
  texts: readonly string[],
  names: readonly string[]
) {
  const packet = texts.flatMap((text) => comparableWords(withoutDates(text)));
  const words = comparableWords(withoutDates(promise));
  const content = words.filter(
    (word) =>
      !payVerb.test(word) && !promiseHow.test(word) && !promiseFiller.has(word)
  );
  if (!content.every(holdsWord(packet))) return [];
  const people = names.flatMap((name) => comparableWords(name));
  if (!promising(promise, people)) return [promise];
  const payers = words.filter((word) => people.includes(word));
  const found = promisesIn(texts, names).filter((each) =>
    (payers.length > 0 ? payers : content).every(
      holdsWord(comparableWords(withoutDates(each)))
    )
  );
  if (payers.length > 0) return found.length > 0 ? [promise] : [];
  return found;
}

/** Words that point at the owner, or at someone code cannot tell: «мой владелец», «я», «он». */
const ownerPointer =
  /^(?:владел\p{L}*|мо[йяеию]\p{L}*|наш\p{L}*|я|мне|меня|мной|мы|нас|нам|нами|он|она|оно|они|его|ее|ему|ей|им|их|него|нее|ней|нему|ним|них)$/u;

/**
 * Whether a promise to pay is the other person's, all of it one the owner's
 * words gave them (`peerPaysSaid`): it names them as the one who pays — their
 * name as it is, not «Петру» — has no word of the owner paying («куплю»),
 * points at nobody else (the owner's name, «мой владелец», «он»), and every
 * word of what it is for is in a part of the owner's words that names them
 * as the one who pays, or in the goal. «Савелий покупает подарок маме»
 * after «а купит пусть Савелий» on a goal of chipping in for mom's gift is.
 */
export function peerPaymentCovered(
  text: string,
  peerPays: readonly string[],
  names: { readonly peer: string; readonly self: string },
  goal: string
) {
  const peer = comparableWords(names.peer);
  const self = comparableWords(names.self);
  const payer = (words: readonly string[]) =>
    words.some((word) => peer.includes(word));
  // «ты», «вы» in the promise are the other one too, as the packet is written to them.
  const payerHere = (words: readonly string[]) =>
    payer(words) || words.some((word) => word === "ты" || word === "вы");
  const words = comparableWords(text);
  const given = peerPays.filter((part) => payer(comparableWords(part)));
  return (
    given.length > 0 &&
    payerHere(words) &&
    !paysPattern.test(words.join(" ")) &&
    !words.some(
      (word) =>
        ownerPointer.test(word) || self.some((name) => nameForm(word, name))
    ) &&
    // The owner is ruled out above: «ты» here is the other one.
    paymentCovered(text, [...given, goal], {
      other: names.self,
      payer: names.peer,
      together: true,
    })
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
      // The two people's names are no words to find, in the owner's words
      // either: «Марией» there finds no «Марина».
      return said.some((clause) =>
        placeNamedIn(
          named,
          comparableWords(clause).filter(
            (word) => !people.some((person) => nameForm(word, person))
          )
        )
      );
    })
  );
}
