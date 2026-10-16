/**
 * Russian Post numbers in text: 14 digits, or an international S10 one
 * («RA123456789RU»). People copy the 14 digits split by spaces or dashes
 * («1010 0012 3456 78»), so a run of digit groups counts when the whole run
 * holds 14 digits: a card's 16 digits and a trailing «34» are no number.
 * A whole 14 digits counts on its own, whatever follows it («80080123456789
 * 2 шт»).
 */
const wholeNumber = /(?<![\p{L}\d])\d{14}(?![\p{L}\d])/gu;
const groupedRun = /(?<![\p{L}\d])(?<!\d[ -])\d+(?:[ -]\d+)+(?![ -]?\d)/gu;
const internationalNumber =
  /(?<![\p{L}\d])[A-Za-z]{2}[ -]?\d{9}[ -]?[A-Za-z]{2}(?![\p{L}\d])/gu;

/** A number as the carrier takes it: no spaces or dashes, in capitals. */
export function normalizedParcelNumber(text: string) {
  return text.replaceAll(/[\s-]/gu, "").toUpperCase();
}

/** The Russian Post numbers in a text, each once, in the order met. */
export function parcelNumbersIn(text: string) {
  const found = [
    ...text.matchAll(wholeNumber),
    ...[...text.matchAll(groupedRun)].filter(
      (match) => normalizedParcelNumber(match[0]).length === 14
    ),
    ...text.matchAll(internationalNumber),
  ]
    .toSorted((left, right) => left.index - right.index)
    .map((match) => normalizedParcelNumber(match[0]));
  return [...new Set(found)];
}
