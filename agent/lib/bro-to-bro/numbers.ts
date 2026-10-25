/**
 * Numbers said in words, as a dictated phone or a spoken time and sum come
 * (docs/bro-to-bro.md): the outgoing gate reads them as digits, and so does
 * the check of what the owner named themself.
 */

/** Number words, as a phone is dictated: «плюс семь девятьсот девяносто девять…». */
export const numberWords = new Map<string, number>([
  ["ноль", 0],
  ["нуль", 0],
  ["один", 1],
  ["одна", 1],
  ["одно", 1],
  ["два", 2],
  ["две", 2],
  ["три", 3],
  ["четыре", 4],
  ["пять", 5],
  ["шесть", 6],
  ["семь", 7],
  ["восемь", 8],
  ["девять", 9],
  ["десять", 10],
  ["одиннадцать", 11],
  ["двенадцать", 12],
  ["тринадцать", 13],
  ["четырнадцать", 14],
  ["пятнадцать", 15],
  ["шестнадцать", 16],
  ["семнадцать", 17],
  ["восемнадцать", 18],
  ["девятнадцать", 19],
  ["двадцать", 20],
  ["тридцать", 30],
  ["сорок", 40],
  ["пятьдесят", 50],
  ["шестьдесят", 60],
  ["семьдесят", 70],
  ["восемьдесят", 80],
  ["девяносто", 90],
  ["сто", 100],
  ["двести", 200],
  ["триста", 300],
  ["четыреста", 400],
  ["пятьсот", 500],
  ["шестьсот", 600],
  ["семьсот", 700],
  ["восемьсот", 800],
  ["девятьсот", 900],
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
]);
const numberWordPattern = [...numberWords.keys(), "плюс", "plus"]
  .toSorted((a, b) => b.length - a.length)
  .join("|");
/** A run of number words, «плюс» among them, split by spaces, commas or dashes. */
const numberWordRun = new RegExp(
  `(?<!\\p{L})(?:${numberWordPattern})(?!\\p{L})(?:[\\s,.\\-–—]+(?:${numberWordPattern})(?!\\p{L}))*`,
  "giu"
);

/**
 * The run with each spoken number as digits: «девятьсот девяносто девять
 * сто двадцать три» is «999 123», «плюс семь» is «+7». Words of falling
 * magnitude make one number, as they are said.
 */
function spokenDigits(run: string) {
  const groups: string[] = [];
  let value: number | undefined;
  let last = Infinity;
  for (const word of run.toLowerCase().split(/[\s,.\-–—]+/u)) {
    if (word === "плюс" || word === "plus") {
      if (value !== undefined) groups.push(String(value));
      groups.push("+");
      value = undefined;
      last = Infinity;
      continue;
    }
    const number = numberWords.get(word);
    if (number === undefined) continue;
    const magnitude = number >= 100 ? 100 : number >= 20 ? 10 : 1;
    if (
      value !== undefined &&
      magnitude < last &&
      !(last === 10 && number >= 10)
    ) {
      value += number;
    } else {
      if (value !== undefined) groups.push(String(value));
      value = number;
    }
    last = number >= 10 && number < 20 ? 1 : magnitude;
  }
  if (value !== undefined) groups.push(String(value));
  return groups.join(" ").replaceAll("+ ", "+");
}

/**
 * The text as the detectors read it: compatibility forms folded (full-width
 * digits, ligatures), invisible characters gone, spoken numbers in digits.
 */
export function normalized(text: string) {
  return text
    .normalize("NFKC")
    .replaceAll(/[\u00ad\u200b-\u200f\u2060\ufeff]/gu, "")
    .replaceAll(numberWordRun, spokenDigits);
}
