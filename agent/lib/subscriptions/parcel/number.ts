/**
 * Russian Post numbers in text: 14 digits, or an international S10 one
 * («RA123456789RU»). People copy the 14 digits split by spaces or dashes
 * («1010 0012 3456 78»), and a run of digit groups can carry more than the
 * number: «трек 1010 0012 3456 78 2 шт», «заказ №12 8008 0123 4567 89». Any
 * stretch of whole groups, at most five, holding exactly 14 digits is a
 * possible number; a card's 16 digits and a list of sizes give none. A whole
 * 14 digits counts on its own, whatever stands next to it.
 */
const wholeNumber = /(?<![\p{L}\d])\d{14}(?![\p{L}\d])/gu;
const groupedRun = /(?<![\p{L}\d])(?<!\d[ -])\d+(?:[ -]\d+)+(?![ -]?\d)/gu;
const internationalNumber =
  /(?<![\p{L}\d])[A-Za-z]{2}[ -]?\d{9}[ -]?[A-Za-z]{2}(?![\p{L}\d])/gu;

/** A number as the carrier takes it: no spaces or dashes, in capitals. */
export function normalizedParcelNumber(text: string) {
  return text.replaceAll(/[\s-]/gu, "").toUpperCase();
}

/** The stretches of a run's whole groups that hold exactly 14 digits. */
function runWindows(run: string) {
  const groups = [...run.matchAll(/\d+/gu)];
  return groups.flatMap((first, start) => {
    let digits = 0;
    for (const group of groups.slice(start, start + 5)) {
      digits += group[0].length;
      if (digits === 14) {
        return [
          {
            first: start === 0,
            offset: first.index,
            text: run.slice(first.index, group.index + group[0].length),
          },
        ];
      }
      if (digits > 14) break;
    }
    return [];
  });
}

/**
 * Each possible number in a text, in the order met. `certain` is a whole
 * 14 digits or an S10 number, or a run with a single stretch of 14 digits
 * that starts it: «12 8008 0123 4567 89» holds two, and a card's tail
 * («4276 1234 5678 9012 34») one that does not start it.
 */
function possibleNumbers(text: string) {
  const plain = [
    ...text.matchAll(wholeNumber),
    ...text.matchAll(internationalNumber),
  ].map((match) => ({ at: match.index, certain: true, text: match[0] }));
  const grouped = [...text.matchAll(groupedRun)].flatMap((run) => {
    const windows = runWindows(run[0]);
    return windows.map((window) => ({
      at: run.index + window.offset,
      certain: windows.length === 1 && window.first,
      text: window.text,
    }));
  });
  return [...plain, ...grouped].toSorted((left, right) => left.at - right.at);
}

/**
 * Every Russian Post number a text may hold, each once, in the order met: a
 * number the person names is theirs when it is among these.
 */
export function parcelNumbersIn(text: string) {
  return [
    ...new Set(
      possibleNumbers(text).map((found) => normalizedParcelNumber(found.text))
    ),
  ];
}

/**
 * Only the numbers a text holds beyond doubt, each once, in the order met:
 * a watch Bro starts on its own, from a letter, starts only from these.
 */
export function certainParcelNumbersIn(text: string) {
  return [
    ...new Set(
      possibleNumbers(text)
        .filter((found) => found.certain)
        .map((found) => normalizedParcelNumber(found.text))
    ),
  ];
}
