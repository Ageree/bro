/**
 * Whether what a location tool writes came from the person's own words in
 * this turn: a point's name («припарковался» → «парковка»), a reminder's
 * text, an address. An email, a page or a report read in the same turn
 * cannot name the person's places or set them a reminder.
 */

/** Lower case, «ё» as «е», single spaces. */
function fold(text: string) {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function wordsOf(text: string) {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A word's stem, without its case ending: two letters off a long word, one
 * off a word of four or five, none off a short one.
 */
function stem(word: string) {
  if (word.length > 5) return word.slice(0, -2);
  return word.length >= 4 ? word.slice(0, -1) : word;
}

/** Names whose usual words differ: «припарковался» names the parking spot. */
const canonicalStems: ReadonlyMap<string, readonly string[]> = new Map([
  ["дом", ["дом"]],
  ["машина", ["машин", "тачк", "авто"]],
  ["офис", ["офис"]],
  ["парковка", ["парков", "парку"]],
  ["работа", ["работ", "офис"]],
]);

function heardOf(said: readonly string[]) {
  return fold(said.join(" "));
}

/** Whether every word of a point's name is in the person's words. */
export function labelSaid(label: string, said: readonly string[]) {
  const heard = heardOf(said);
  const name = fold(label);
  if (name.length === 0) return false;
  const canonical = canonicalStems.get(name);
  if (canonical) return canonical.some((part) => heard.includes(part));
  const words = wordsOf(name).filter((word) => word.length >= 3);
  if (words.length === 0) return heard.includes(name);
  return words.every((word) => heard.includes(stem(word)));
}

/**
 * Whether a reminder's text is the person's: at least half of its words of
 * three letters or more, by stem, are in their words of this turn.
 */
export function textSaid(text: string, said: readonly string[]) {
  const heard = heardOf(said);
  const words = wordsOf(text).filter((word) => word.length >= 3);
  if (words.length === 0) return false;
  const found = words.filter((word) => heard.includes(stem(word))).length;
  return found * 2 >= words.length;
}

/**
 * Words of an address that name no place of their own: the kind of street,
 * a house or a city, which the model writes out or adds from the context
 * («ул.» → «улица», «в Москве» → «Москва»).
 */
const addressKindStems = [
  "улиц",
  "проспект",
  "переул",
  "площад",
  "шоссе",
  "бульвар",
  "набережн",
  "проезд",
  "тупик",
  "алле",
  "дом",
  "корпус",
  "строени",
  "город",
  "москв",
  "санкт",
  "петербург",
  "росси",
];

/** Their short forms, matched as whole words: «пр» is not «Пресненская». */
const addressKindShort = new Set([
  "ул",
  "пр",
  "пер",
  "пл",
  "наб",
  "корп",
  "стр",
]);

/**
 * A word of the street's kind: one of the short forms, or a kind's stem with
 * a case ending at most («дома», but not «Домодедовская»).
 */
function addressKind(word: string) {
  return (
    addressKindShort.has(word) ||
    addressKindStems.some(
      (kind) => word.startsWith(kind) && word.length <= kind.length + 3
    )
  );
}

/**
 * Whether an address is the person's: its every number, and the stem of its
 * every naming word, are in their words of this turn. The model writes the
 * address in its plain form («на Тверскую улицу 7 в Москве» → «Тверская
 * улица 7, Москва»), which is also the form the map finds, so a case ending
 * or a written-out «улица» must not refuse it; a street or house the person
 * did not name still does.
 */
export function addressSaid(address: string, said: readonly string[]) {
  const heard = heardOf(said);
  const heardWords = new Set<string>(wordsOf(heard));
  const words = wordsOf(address);
  const numbers = words.filter((word) => /\p{N}/u.test(word));
  const names = words.filter(
    (word) => !/\p{N}/u.test(word) && word.length >= 3 && !addressKind(word)
  );
  if (names.length === 0) return false;
  return (
    numbers.every((number) => heardWords.has(number)) &&
    names.every((word) => heard.includes(stem(word)))
  );
}

/** A request to delete: «забудь», «удали», «сотри», «очисти». */
const forgetVerbs = ["забуд", "забыв", "удал", "стер", "сотр", "очист"];

/** What it is about: the person's places, track or everything. */
const locationWords = [
  "геопоз",
  "геолок",
  "местополож",
  "локац",
  "где я",
  "где был",
  "где бывал",
  "точк",
  "маршрут",
  "перемещ",
  "истори",
];

/**
 * Whether the person asked in this turn to forget where they were: a word
 * of deleting and a word of their places together. Forgetting cannot be
 * undone, so a page or a letter read in the turn must not be able to ask.
 */
export function forgetSaid(said: readonly string[]) {
  const heard = heardOf(said);
  return (
    forgetVerbs.some((verb) => heard.includes(verb)) &&
    (locationWords.some((word) => heard.includes(word)) ||
      wordsOf(heard).some((word) => word === "все"))
  );
}
