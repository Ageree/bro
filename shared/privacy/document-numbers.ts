/**
 * Where a text carries a Russian passport's or a SNILS number. Two layers
 * mask them: the benchmark's journal (`scripts/bench/personal-data.ts`) and
 * the conversation log the cross-channel recap reads
 * (`agent/hooks/conversation-log.ts`).
 *
 * The rules match what these look like in Russian and English text. They
 * take a stray lookalike too («паспорт продлить до 2030»), which is the
 * cheap side of that trade; they are no proof that a free-form line holds
 * nothing personal.
 */

// Letters and digits on either side make a longer token (an id, a hash), not
// a number standing alone.
const alone = String.raw`(?<![\p{L}\p{N}_])`;
const ends = String.raw`(?![\p{L}\p{N}_])`;

/**
 * What may stand between the word and its number: a few characters, and a
 * line break at most once — «СНИЛС:» on one line, the number on the next.
 */
const gap = (length: number) =>
  String.raw`[^\d\n"]{0,${String(length)}}?(?:\n[^\d\n"]{0,8}?)?`;

/**
 * The rules, each with the number in its last group: series and number,
 * `45 10 123456`, and any number right after the word; `123-456-789 01`,
 * and any 11 digits right after «СНИЛС», in groups split by a space, a
 * dash or a dot.
 */
const documentNumberPatterns = [
  new RegExp(
    String.raw`((?:паспорт|passport|серия)\p{L}*${gap(40)})(\d{2}\s?\d{2}(?:[^\d\n"]{0,12}\d{6})?)${ends}`,
    "dgiu"
  ),
  new RegExp(String.raw`${alone}(\d{2}\s?\d{2}\s№?\s?\d{6})${ends}`, "dgu"),
  new RegExp(
    String.raw`((?:снилс|snils)${gap(20)})(\d(?:[\s.-]?\d){10})${ends}`,
    "dgiu"
  ),
  new RegExp(String.raw`${alone}(\d{3}-\d{3}-\d{3}[\s-]\d{2})${ends}`, "dgu"),
];

/** The `[start, end)` ranges of the passport and SNILS numbers in a text. */
export function documentNumberRanges(text: string) {
  return documentNumberPatterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) => {
      const range = match.indices?.at(-1);
      return range === undefined ? [] : [range];
    })
  );
}
