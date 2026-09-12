/** Drop heading-only leftovers and exact repeats in the same chat.
 *
 *  Serverless isolates reset earlySent, so the same «Тяжёлая артиллерия:»
 *  can leave on every tool-round unless the actual send is de-duped. */

export const BUBBLE_DEDUPE_TTL_MS = 2 * 60_000;

type Row = { at: number; texts: string[] };

const sent = new Map<string, Row>();

export function foldWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function isHeadingOnly(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("\n")) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  const bare = t.replace(/[*_`#]/g, "").trim();
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (bare.length > 40) return false;
  return /:\s*$/.test(bare);
}

export function claimChatBubble(input: {
  chatKey: string;
  text: string;
  now?: number;
}): boolean {
  const text = input.text.trim();
  if (!text) return false;
  if (isHeadingOnly(text)) return false;
  const key = input.chatKey.trim();
  if (!key) return true;
  const now = input.now ?? Date.now();
  prune(now);
  const folded = foldWs(text);
  const row = sent.get(key);
  if (row && now - row.at < BUBBLE_DEDUPE_TTL_MS && row.texts.includes(folded)) {
    return false;
  }
  const next: Row = row && now - row.at < BUBBLE_DEDUPE_TTL_MS
    ? row
    : { at: now, texts: [] };
  next.at = now;
  next.texts.push(folded);
  if (next.texts.length > 16) next.texts.splice(0, next.texts.length - 16);
  sent.set(key, next);
  return true;
}

export function resetBubbleDedupe(): void {
  sent.clear();
}

function prune(now: number): void {
  for (const [key, row] of sent) {
    if (now - row.at > BUBBLE_DEDUPE_TTL_MS) sent.delete(key);
  }
}
