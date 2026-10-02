import { unsafeMemoryRanges } from "@shared/memory/schema";

const placeholder = "[удалено]";

/**
 * The text with every credential and one-time code in it replaced by a
 * placeholder, or the text itself when it has none.
 */
export function redactUnsafeText(text: string) {
  const ranges = unsafeMemoryRanges(text).toSorted(([a], [b]) => a - b);
  if (ranges.length === 0) return text;
  let redacted = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    // Overlapping ranges are one secret, and get one placeholder.
    if (start >= cursor) {
      redacted += text.slice(cursor, start) + placeholder;
    }
    cursor = end;
  }
  return redacted + text.slice(cursor);
}
