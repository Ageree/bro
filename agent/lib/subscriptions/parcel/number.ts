/**
 * Russian Post numbers in text: 14 digits (a domestic item; a space or a
 * dash may split them, as people copy them), or an international S10 one
 * («RA123456789RU»). A longer run of digits — a card, an account — is none.
 */
const domesticNumber = /(?<![\p{L}\d])\d(?:[ -]?\d){13}(?![ -]?\d)/gu;
const internationalNumber =
  /(?<![\p{L}\d])[A-Za-z]{2}[ -]?\d{9}[ -]?[A-Za-z]{2}(?![\p{L}\d])/gu;

/** A number as the carrier takes it: no spaces or dashes, in capitals. */
export function normalizedParcelNumber(text: string) {
  return text.replaceAll(/[\s-]/gu, "").toUpperCase();
}

/** The Russian Post numbers in a text, each once, in the order met. */
export function parcelNumbersIn(text: string) {
  const found = [
    ...text.matchAll(domesticNumber),
    ...text.matchAll(internationalNumber),
  ]
    .toSorted((left, right) => left.index - right.index)
    .map((match) => normalizedParcelNumber(match[0]));
  return [...new Set(found)];
}
