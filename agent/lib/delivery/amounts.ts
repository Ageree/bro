/**
 * Rouble sums as Russian typography writes them: «2 000 ₽», «15 225 руб.»,
 * with a no-break space between the thousands so a sum never breaks across
 * lines. Models write «2000 ₽» as often as not, and the benchmark's
 * methodology counts that against the message.
 *
 * Only a number right before the rouble sign or word is touched, so a year,
 * a time, a code, a phone or an order number stays as written; so does
 * anything inside a link or a code span, and a sum already grouped.
 */

const noBreakSpace = " ";

/** A number: grouped by spaces already, or a plain run of digits. */
const number = String.raw`(?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,]\d{1,2})?`;

/**
 * A sum, or a range of sums, right before the rouble: «2000 ₽»,
 * «1690–2290 ₽», «от 15000 до 20000 руб.», «3500 рублей». A digit, a letter
 * or a decimal mark before it means it is part of something else.
 */
const roubleSum = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,_/])${number}(?:(?:\s?[–—-]\s?|\s+до\s+)${number})?(?=\s?(?:₽|руб(?!\p{L})|рубл\p{L}*))`,
  "giu"
);

/** Where nothing is regrouped: code spans, fenced blocks, links. */
const untouchable =
  /```[\s\S]*?```|`[^`\n]*`|\]\([^)\s]*\)|[a-z][a-z0-9+.-]*:\/\/\S+/giu;

/** Every plain run of four digits or more, grouped in threes. */
function grouped(sum: string) {
  return sum.replace(/(?<![\d.,])\d{4,}/gu, (digits) =>
    digits.replace(/\B(?=(?:\d{3})+$)/gu, noBreakSpace)
  );
}

function regroupedPlain(text: string) {
  return text.replace(roubleSum, grouped);
}

/** `text` with every rouble sum of four digits or more grouped in thousands. */
export function withGroupedRoubles(text: string) {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(untouchable)) {
    result += regroupedPlain(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + regroupedPlain(text.slice(last));
}
