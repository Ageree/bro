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

/** Whether an address is written in the person's words as given. */
export function addressSaid(address: string, said: readonly string[]) {
  const wanted = wordsOf(address).join(" ");
  if (wanted.length === 0) return false;
  return wordsOf(said.join(" ")).join(" ").includes(wanted);
}
