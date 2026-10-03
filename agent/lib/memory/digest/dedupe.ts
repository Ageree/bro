import {
  comparableMemoryText,
  type MemoryContent,
} from "@shared/memory/schema";

interface DigestRecord {
  readonly content: MemoryContent;
  readonly index: number;
  readonly revision: number;
}

/** What the digest does to a scope's memories: all by code, no model. */
interface DedupePlan {
  /** A record kept, with the aliases of those folded into it. */
  readonly keep: readonly {
    readonly record: DigestRecord;
    readonly aliases: readonly string[];
  }[];
  /** A record another one says in full: the same words, or more of them. */
  readonly drop: readonly {
    readonly record: DigestRecord;
    readonly into: number;
    readonly reason: "duplicate" | "contained";
  }[];
}

const maximumAliases = 12;
/** Words that join a clause to the one before it: «… и не ест свинину». */
const joiningWords = new Set(["и", "а", "также", "ещё", "and", "also"]);
/** Words that take back or narrow the clause before: «…, но разлюбил». */
const contrastWords = new Set([
  "но",
  "однако",
  "хотя",
  "зато",
  "кроме",
  "только",
  "but",
  "however",
  "though",
  "although",
  "except",
  "only",
]);
const clauseBreak = /[,;:.!?()—–]/u;
/**
 * Where a clause of its own begins. Not after a comma or a colon: «по
 * выходным, любит суши» is no «любит суши».
 */
const sentenceBreak = /[;.!?]/u;

/** A memory's words, lower-cased, with where each starts and ends. */
function words(text: string) {
  return [...comparableMemoryText(text).matchAll(/[\p{L}\p{N}]+/gu)].map(
    (match) => ({
      end: match.index + match[0].length,
      start: match.index,
      word: match[0],
    })
  );
}

/**
 * Whether `outer` says all of `inner`: inner's words come in outer in a row,
 * as a whole clause of it — so «любит суши» is in «любит суши и роллы», but
 * not in «не любит суши», «по выходным, любит суши», «любит суши по
 * пятницам» or «любит суши, но разлюбил».
 */
export function saysInFull(outer: string, inner: string) {
  const outerWords = words(outer);
  const innerWords = words(inner).map(({ word }) => word);
  const comparable = comparableMemoryText(outer);
  if (innerWords.length === 0 || innerWords.length > outerWords.length)
    return false;
  for (let at = 0; at + innerWords.length <= outerWords.length; at += 1) {
    const matches = innerWords.every(
      (word, offset) => outerWords[at + offset]?.word === word
    );
    if (!matches) continue;
    const before = outerWords[at - 1];
    const startsClause =
      before === undefined ||
      joiningWords.has(before.word) ||
      sentenceBreak.test(
        comparable.slice(before.end, outerWords[at]?.start ?? before.end)
      );
    const last = outerWords[at + innerWords.length - 1];
    const after = outerWords[at + innerWords.length];
    const endsClause =
      after === undefined ||
      (!contrastWords.has(after.word) &&
        (joiningWords.has(after.word) ||
          clauseBreak.test(comparable.slice(last?.end ?? 0, after.start))));
    if (startsClause && endsClause) return true;
  }
  return false;
}

function sameKind(a: MemoryContent, b: MemoryContent) {
  return (
    a.category === b.category &&
    a.validUntil === b.validUntil &&
    a.localOnly === b.localOnly
  );
}

function sameWords(a: string, b: string) {
  return (
    words(a)
      .map(({ word }) => word)
      .join(" ") ===
    words(b)
      .map(({ word }) => word)
      .join(" ")
  );
}

/** The kept record's aliases with those of the folded ones, at most twelve. */
export function mergedAliases(
  kept: DigestRecord,
  folded: readonly DigestRecord[]
) {
  const aliases = [...kept.content.aliases];
  const seen = new Set(aliases.map(comparableMemoryText));
  for (const alias of folded.flatMap((record) => record.content.aliases)) {
    if (aliases.length >= maximumAliases) break;
    const key = comparableMemoryText(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

/**
 * Folds the duplicates and the records another says in full into the one
 * that stays: the lowest index for the same words, the longer record for a
 * contained one. Rules are never touched, and nothing crosses a category, a
 * validity or `localOnly`.
 */
export function planDedupe(records: readonly DigestRecord[]): DedupePlan {
  const candidates = records
    .filter(({ content }) => content.category !== "rule")
    .toSorted((a, b) => a.index - b.index);
  const dropped = new Map<number, DedupePlan["drop"][number]>();
  for (const [position, record] of candidates.entries()) {
    if (dropped.has(record.index)) continue;
    for (const later of candidates.slice(position + 1)) {
      if (dropped.has(later.index) || !sameKind(record.content, later.content))
        continue;
      if (sameWords(record.content.text, later.content.text)) {
        dropped.set(later.index, {
          into: record.index,
          reason: "duplicate",
          record: later,
        });
      }
    }
  }
  const remaining = candidates.filter(({ index }) => !dropped.has(index));
  for (const record of remaining) {
    if (record.content.validUntil !== null) continue;
    const outer = remaining.find(
      (other) =>
        other.index !== record.index &&
        !dropped.has(other.index) &&
        sameKind(record.content, other.content) &&
        !sameWords(record.content.text, other.content.text) &&
        saysInFull(other.content.text, record.content.text)
    );
    if (outer) {
      dropped.set(record.index, {
        into: outer.index,
        reason: "contained",
        record,
      });
    }
  }
  // A record folded into one that went too ends where that one went: its
  // words, and its aliases, are there.
  const finalInto = (index: number): number => {
    const next = dropped.get(index);
    return next === undefined ? index : finalInto(next.into);
  };
  const drop = [...dropped.values()].map(({ into, reason, record }) => ({
    into: finalInto(into),
    reason,
    record,
  }));
  const keep = remaining
    .filter(({ index }) => !dropped.has(index))
    .flatMap((record) => {
      const folded = drop
        .filter(({ into }) => into === record.index)
        .map(({ record: from }) => from);
      if (folded.length === 0) return [];
      const aliases = mergedAliases(record, folded);
      return aliases.length === record.content.aliases.length
        ? []
        : [{ aliases, record }];
    });
  return { drop, keep };
}
