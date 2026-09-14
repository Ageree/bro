/** The longest one memory line may be, in characters. */
export const LINE_CHARS = 280;

/** Lines recalled into context at the start of every turn. */
export const WAKE_LINES = 80;

/** Cap per person; the oldest lines beyond this are dropped on write. */
export const MAX_LINES = 400;

/** How many newest lines search/forget/dedup scan. */
export const SCAN_LINES = 512;

/** One normalized memory line, or null when nothing survives trimming. */
export function normalizeLine(line: string): string | null {
  let text = line.trim().slice(0, LINE_CHARS);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  text = text.trimEnd();
  return text.length > 0 ? text : null;
}

/** Exact-duplicate write is a successful no-op. */
export function isDuplicate(existing: readonly string[], text: string): boolean {
  return existing.includes(text);
}

/** How many oldest lines to delete to stay within the cap after one insert. */
export function overflowAfterInsert(countBeforeInsert: number): number {
  return Math.max(0, countBeforeInsert + 1 - MAX_LINES);
}

/** Case-insensitive substring match used by search and forget. */
export function lineMatches(line: string, needle: string): boolean {
  return line.toLowerCase().includes(needle.trim().toLowerCase());
}
