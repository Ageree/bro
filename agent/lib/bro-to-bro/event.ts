import type { BroProposal } from "@shared/bro-to-bro/contract";

/** Names whose ending the rules of `withName` would get wrong. */
const irregularNames = new Map([
  ["лев", "Львом"],
  ["любовь", "Любовью"],
  ["павел", "Павлом"],
  ["петр", "Петром"],
  ["пётр", "Петром"],
]);

/**
 * A first name as it follows «с»: «с Петром», «с Машей», «с Савелием», «с
 * Марией». A name the rules cannot decline — not one Russian word, or one
 * that ends in a vowel that does not change — is left as it is.
 */
function withName(name: string) {
  const lower = name.toLowerCase();
  const irregular = irregularNames.get(lower);
  if (irregular) return irregular;
  if (!/^\p{Script=Cyrillic}+$/u.test(name)) return name;
  const stem = name.slice(0, -1);
  if (lower.endsWith("ий")) return `${stem.slice(0, -1)}ием`;
  if (lower.endsWith("ия")) return `${stem.slice(0, -1)}ией`;
  if (/[йь]$/u.test(lower)) return `${stem}ем`;
  if (/[жчшщц]а$/u.test(lower)) return `${stem}ей`;
  if (lower.endsWith("а")) return `${stem}ой`;
  if (lower.endsWith("я")) return `${stem}ей`;
  if (/[жчшщц]$/u.test(lower)) return `${name}ем`;
  if (/[бвгдзклмнпрстфх]$/u.test(lower)) return `${name}ом`;
  return name;
}

/** Words as a person reads them: lower case, «е» for «ё». */
function plain(text: string) {
  return text.toLowerCase().replaceAll("ё", "е");
}

/**
 * Whether a summary names the person in some form: a word that starts with
 * their name less its ending («Петра» for «Пётр», «Машей» for «Маша»), or
 * their name after «с».
 */
function namesPerson(summary: string, name: string, after: string) {
  const words = plain(summary).split(/[^\p{L}]+/u);
  const own = plain(name);
  const stem = own.replace(/[аеиоуыэюяйь]$/u, "");
  return words.some(
    (word) =>
      word === own ||
      word === plain(after) ||
      (stem.length >= 3 && word.startsWith(stem))
  );
}

/**
 * A confirmed meeting as it goes into one owner's own calendar
 * (docs/bro-to-bro.md, «Обязательства»): the proposal's summary, with the
 * peer added when it does not name them already, its time and place, and
 * one line on how it was agreed. Nothing of the errand, the owners' answers
 * or the talk. Nothing for a proposal without a start and an end: a
 * calendar has no place for it.
 */
export function broMeetingEvent(
  proposal: BroProposal | undefined,
  peerName: string | null
) {
  if (!proposal?.start || !proposal.end) return undefined;
  const name = peerName?.trim() ?? "";
  const after = name === "" ? "" : withName(name);
  return {
    description:
      after === ""
        ? "Договорились Бро ↔ Бро"
        : `Договорились Бро ↔ Бро с ${after}`,
    end: proposal.end,
    location: proposal.place,
    start: proposal.start,
    summary:
      after === "" || namesPerson(proposal.summary, name, after)
        ? proposal.summary
        : `${proposal.summary} — с ${after}`,
  };
}
