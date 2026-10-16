/**
 * Russian Post numbers in text: 14 digits, or an international S10 one
 * («RA123456789RU»). People copy the 14 digits split by spaces or dashes
 * («1010 0012 3456 78»), so a run of digit groups counts when its first
 * groups, at most five, hold exactly 14 digits and at most one more number
 * follows («1010 0012 3456 78 2 шт»): a card's 16 digits, its tail
 * («… 9012 34») and a list of sizes are no number. A whole 14 digits counts
 * on its own, whatever follows it («80080123456789 2 шт»).
 */
const wholeNumber = /(?<![\p{L}\d])\d{14}(?![\p{L}\d])/gu;
const groupedRun = /(?<![\p{L}\d])(?<!\d[ -])\d+(?:[ -]\d+)+(?![ -]?\d)/gu;
const internationalNumber =
  /(?<![\p{L}\d])[A-Za-z]{2}[ -]?\d{9}[ -]?[A-Za-z]{2}(?![\p{L}\d])/gu;

/** A number as the carrier takes it: no spaces or dashes, in capitals. */
export function normalizedParcelNumber(text: string) {
  return text.replaceAll(/[\s-]/gu, "").toUpperCase();
}

/** A run's leading number, as `groupedRun`'s rule above takes it. */
function leadingNumber(run: string) {
  const groups = [...run.matchAll(/\d+/gu)];
  let digits = 0;
  for (const [count, group] of groups.entries()) {
    digits += group[0].length;
    if (digits < 14) continue;
    const fits = digits === 14 && count < 5 && groups.length - count <= 2;
    return fits ? run.slice(0, group.index + group[0].length) : undefined;
  }
  return undefined;
}

/** The Russian Post numbers in a text, each once, in the order met. */
export function parcelNumbersIn(text: string) {
  const found = [
    ...[
      ...text.matchAll(wholeNumber),
      ...text.matchAll(internationalNumber),
    ].map((match) => ({ at: match.index, number: match[0] })),
    ...[...text.matchAll(groupedRun)].flatMap((match) => {
      const number = leadingNumber(match[0]);
      return number ? [{ at: match.index, number }] : [];
    }),
  ]
    .toSorted((left, right) => left.at - right.at)
    .map(({ number }) => normalizedParcelNumber(number));
  return [...new Set(found)];
}
