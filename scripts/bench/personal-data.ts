/**
 * The personal data the benchmark's journal rules mask before anything is
 * written (`docs/benchmarks/ru/README.md` §2.3): passport and SNILS numbers,
 * card numbers, and exact addresses, keeping the city. A live run types the
 * tester's own data into sites, and Bro's replies and the tool payloads
 * carry it back.
 *
 * Passport and SNILS numbers follow the rules the conversation log masks
 * them by too (`agent/lib/privacy/document-numbers.ts`).
 *
 * The rules match what these look like in Russian and English text. They
 * mask a stray lookalike too (a page number after «стр.»), which is the
 * cheap side of that trade; they are no proof that a free-form line holds
 * nothing personal.
 */

import { documentNumberRanges } from "@agent/lib/privacy/document-numbers";

const hidden = "***";

// Letters and digits on either side make a longer token (an id, a hash), not
// a number standing alone.
const alone = String.raw`(?<![\p{L}\p{N}_])`;
const ends = String.raw`(?![\p{L}\p{N}_])`;

/** 13 to 19 digits, grouped by spaces or dashes or not at all. */
const cardCandidate = new RegExp(
  String.raw`${alone}\d(?:[ -]?\d){12,18}${ends}`,
  "gu"
);

/** Four groups of four, the way a card is printed, whatever the checksum. */
const cardGroups = /^\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1?\d{1,3})?$/u;

function passesLuhn(digits: string) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// A house number: 5, 12а, 7/2, 3к1, 14-16.
const house = String.raw`\d+\p{L}?(?:\s?[/к-]\s?\d+\p{L}?)?`;
const streetWord = String.raw`ул\.|улиц[аеуы]|пр-т|просп\.|пр\.|проспект[аеу]?|пер\.|переул(?:ок|ке|ка)|б-р|бул\.|бульвар[аеу]?|ш\.|шоссе|наб\.|набережн(?:ая|ой|ую)|пл\.|площад[ьи]|проезд[аеу]?|мкр\.?|микрорайон[аеу]?`;

/** «ул. Малышева, д. 51»: the street keyword, its name and the house. */
const streetThenHouse = new RegExp(
  String.raw`(?<!\p{L})(${streetWord})(?!\p{L})(\s*)[^,;\n"()\d][^,;\n"()]{0,40}?,?\s*(?:д(?:ом)?\.?\s*)?${house}${ends}`,
  "giu"
);
/** «Тверская ул., 12»: the name stays, the house goes. */
const houseAfterStreet = new RegExp(
  String.raw`(?<!\p{L})(${streetWord})(?!\p{L})(\s*,?\s*)${house}${ends}`,
  "giu"
);
/** «д. 5», «кв. 12», «корп. 2», wherever they stand. */
const housePart = new RegExp(
  String.raw`(?<!\p{L})(д\.|дом|корп\.|корпус[аеу]?|к\.|стр\.|строени[ея]|кв\.|квартир[аеуы]|оф\.|офис[аеу]?|под\.|подъезд[аеу]?)\s*№?\s*${house}${ends}`,
  "giu"
);
/** A postal code opening an address: «620014, г. Екатеринбург». */
const postalCode = new RegExp(
  String.raw`${alone}\d{6}(?=,?\s*(?:г\.|город\s|Росси|РФ))`,
  "gu"
);
/** «221B Baker Street», «12 Oak Ave»: the number and the street name. */
const englishStreet =
  /(?<![\p{L}\p{N}])\d+[A-Za-z]?\s+(?:[A-Z][\w'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Place|Pl|Court|Ct|Terrace|Square|Sq)\b\.?/gu;
const englishUnit =
  /\b(Apt|Apartment|Suite|Unit)\.?\s*#?\s*[\p{L}\p{N}-]{1,6}(?![\p{L}\p{N}])/giu;

/** The text with its passport and SNILS numbers masked, overlaps as one. */
function maskDocumentNumbers(text: string) {
  let masked = "";
  let cursor = 0;
  for (const [start, end] of documentNumberRanges(text).toSorted(
    ([a], [b]) => a - b
  )) {
    if (end <= cursor) continue;
    if (start >= cursor) masked += text.slice(cursor, start) + hidden;
    cursor = end;
  }
  return masked + text.slice(cursor);
}

export function maskPersonalData(text: string) {
  return maskDocumentNumbers(text)
    .replaceAll(cardCandidate, (match) => {
      const digits = match.replaceAll(/\D/gu, "");
      // A receipt shows the last four, and so does the journal.
      return cardGroups.test(match) || passesLuhn(digits)
        ? `**** ${digits.slice(-4)}`
        : match;
    })
    .replaceAll(
      streetThenHouse,
      (_match, word: string, gap: string) => `${word}${gap || " "}${hidden}`
    )
    .replaceAll(
      houseAfterStreet,
      (_match, word: string, gap: string) => `${word}${gap}${hidden}`
    )
    .replaceAll(housePart, (_match, word: string) => `${word} ${hidden}`)
    .replaceAll(postalCode, hidden)
    .replaceAll(englishStreet, hidden)
    .replaceAll(englishUnit, (_match, word: string) => `${word} ${hidden}`);
}
