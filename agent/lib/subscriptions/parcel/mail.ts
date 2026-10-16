import { parcelNumbersIn } from "./number";

/**
 * The carrier's own domains: a letter from one of them is Russian Post's
 * word about a parcel. A shop's letter that names a Russian Post number is
 * not: its numbers are the person's to give.
 */
const carrierDomains = ["pochta.ru", "russianpost.ru"] as const;

/** The Gmail search for the carrier's letters. */
export const carrierMailQuery = `from:(${carrierDomains.join(" OR ")})`;

/** At most this many watches start from one check's mail. */
const maximumLetterNumbers = 5;

/** The address in a `From` header: «Почта России <noreply@pochta.ru>». */
function senderAddress(from: string) {
  const angled = /<([^<>\s]+@[^<>\s]+)>/u.exec(from)?.[1];
  return (angled ?? from).trim().toLowerCase();
}

function fromCarrier(from: string) {
  const domain = senderAddress(from).split("@").at(-1) ?? "";
  return carrierDomains.some(
    (carrier) => domain === carrier || domain.endsWith(`.${carrier}`)
  );
}

/**
 * The Russian Post numbers a check's new mail carries in letters of the
 * carrier's own, by message id, from each letter's subject and the start of
 * its text (Gmail's snippet): never the body, which the check does not read.
 * At most five numbers in all.
 */
export function carrierLetterNumbers(
  letters: readonly {
    readonly from: string;
    readonly id: string;
    readonly snippet: string;
    readonly subject: string;
  }[]
) {
  const byLetter = new Map<string, string[]>();
  const all = new Set<string>();
  for (const letter of letters) {
    if (!fromCarrier(letter.from)) continue;
    const numbers: string[] = [];
    for (const number of parcelNumbersIn(
      `${letter.subject}\n${letter.snippet}`
    )) {
      if (!all.has(number) && all.size >= maximumLetterNumbers) continue;
      all.add(number);
      numbers.push(number);
    }
    if (numbers.length > 0) byLetter.set(letter.id, numbers);
  }
  return byLetter;
}
