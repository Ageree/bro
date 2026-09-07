/** Deliver assistant text as soon as a model step has something to show.
 *
 *  Eve fires `message.completed` after every step, including ones that then
 *  call tools. The channel used to drop those, so a human waited for the
 *  whole tool loop (browser poll, composio, …) before the first bubble.
 */

import { splitSeen } from "./wakeup-text.ts";
import type { TurnOrigin } from "./silent-turn.ts";
import { isSilentReply, TURN_FAILED_REPLY } from "./silent-turn.ts";

export type TurnDelivery = {
  send: string | null;
  seen?: string;
  fallback: string | null;
};

/** Text the human may see. Empty / [SILENT] never leave the channel. */
export function visibleReply(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || isSilentReply(trimmed)) return null;
  return trimmed;
}

export type EarlySentRow = { at: number; bubbles: string[]; soFar?: string };

function foldLines(s: string): string {
  return s.replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "").trim();
}

function hasPrefixBoundary(cur: string, prefix: string): boolean {
  if (prefix.length >= cur.length) return true;
  const last = prefix[prefix.length - 1] ?? "";
  if (/[.!?…。！？\s]/.test(last)) return true;
  const next = cur[prefix.length] ?? "";
  return /[\s.!?…。！？,;:)\]]/.test(next);
}

/** Finished visible lines (newline-terminated). Leading `\nИ` crumbs stay. */
export function finishedVisibleText(soFar: string): string | null {
  const raw = typeof soFar === "string" ? soFar : "";
  const { message } = raw ? splitSeen(raw) : { message: raw };
  let src = message;
  if (!src.includes("\n") && raw.includes("\n") && src.trim()) {
    src = `${src}\n`;
  }
  if (!src.includes("\n")) return null;
  const parts = src.split("\n");
  const finished = src.endsWith("\n") ? parts : parts.slice(0, -1);
  const lines: string[] = [];
  for (const part of finished) {
    const line = part.trim();
    if (line && visibleReply(line)) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** First visible line terminated by a newline. */
export function firstCompleteLine(soFar: string): string | null {
  const text = finishedVisibleText(soFar);
  return text?.split("\n")[0]?.trim() || null;
}

const COMPLETE_TAILS = new Set([
  "ок",
  "ok",
  "okay",
  "окей",
  "спасибо",
  "thanks",
  "thx",
  "понял",
  "поняла",
  "ясно",
  "принято",
  "сделано",
  "готово",
  "ищу",
  "нашел",
  "нашла",
  "ага",
]);

function foldTail(word: string): string {
  return word
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function endsStrong(text: string): boolean {
  return /[!?…！？]$/u.test(text) || /[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u.test(text);
}

/** Finished line, or an unterminated line that already looks like a full bubble. */
export function isLikelyCompleteBubble(text: string): boolean {
  const t = text.trim();
  if (!t || !visibleReply(t)) return false;
  if (!/\p{L}|\p{N}/u.test(t)) return true;
  if (endsStrong(t)) return true;
  if (!/[.。]$/u.test(t)) return false;
  const word = t.replace(/[.!?…。！？]+$/u, "").trim().split(/\s+/).pop() ?? "";
  if (word.length >= 4) return true;
  return COMPLETE_TAILS.has(foldTail(word));
}

function openVisibleLine(soFar: string): string | null {
  const raw = typeof soFar === "string" ? soFar : "";
  const { message } = raw ? splitSeen(raw) : { message: raw };
  let src = message;
  if (!src.includes("\n") && raw.includes("\n") && src.trim()) {
    src = `${src}\n`;
  }
  if (src.endsWith("\n")) return null;
  const open = src.includes("\n") ? (src.split("\n").at(-1) ?? "") : src;
  return visibleReply(open);
}

/** Newline-finished lines plus a sentence/emoji-complete open line. */
export function likelyCompleteVisibleText(soFar: string): string | null {
  const finished = finishedVisibleText(soFar);
  const open = openVisibleLine(soFar);
  if (open && isLikelyCompleteBubble(open)) {
    return finished ? `${finished}\n${open}` : open;
  }
  return finished;
}

/**
 * Streamed iMessage bubble from `message.appended`.
 * Newline-finished lines, or a sentence/emoji-complete open line.
 * Later complete text is the remainder after alreadySent.
 */
export function planStreamFlush(input: {
  soFar: string;
  alreadySent: readonly string[];
}): Pick<TurnDelivery, "send" | "seen"> {
  const raw = typeof input.soFar === "string" ? input.soFar : "";
  const { seen } = raw ? splitSeen(raw) : {};
  const text = likelyCompleteVisibleText(raw);
  if (!text) return { send: null, ...(seen !== undefined ? { seen } : {}) };
  return {
    send: nextBubble(input.alreadySent, text),
    ...(seen !== undefined ? { seen } : {}),
  };
}

/** @deprecated use planStreamFlush */
export function planFirstLineFlush(input: {
  soFar: string;
  alreadySent: readonly string[];
}): Pick<TurnDelivery, "send" | "seen"> {
  return planStreamFlush(input);
}

/**
 * Pre-tool text is done even without a newline. Used on `actions.requested`.
 */
export function planPreToolFlush(input: {
  soFar: string;
  alreadySent: readonly string[];
}): Pick<TurnDelivery, "send" | "seen"> {
  const raw = typeof input.soFar === "string" ? input.soFar : "";
  const { message, seen } = raw ? splitSeen(raw) : { message: raw };
  const text = finishedVisibleText(raw) ?? visibleReply(message);
  if (!text) return { send: null, ...(seen !== undefined ? { seen } : {}) };
  return {
    send: nextBubble(input.alreadySent, text),
    ...(seen !== undefined ? { seen } : {}),
  };
}

/**
 * Next bubble given text already sent this turn.
 * Handles both per-step messages and accumulated ones.
 */
export function nextBubble(
  alreadySent: readonly string[],
  current: string,
): string | null {
  const cur = current.trim();
  if (!cur) return null;
  const sent = alreadySent.map((s) => s.trim()).filter(Boolean);
  if (sent.some((s) => s === cur)) return null;
  const last = sent[sent.length - 1];
  if (last && last.startsWith(cur)) return null;
  const curFold = foldLines(cur);
  for (const joined of [sent.join("\n\n"), sent.join("\n"), sent.join(" ")]) {
    const joinedFold = foldLines(joined);
    if (!joinedFold) continue;
    if (curFold === joinedFold) return null;
    if (
      (curFold.startsWith(`${joinedFold}\n`) ||
        (curFold.startsWith(joinedFold) && hasPrefixBoundary(curFold, joinedFold)))
    ) {
      const rest = curFold.slice(joinedFold.length).replace(/^[\s]+/, "").trim();
      return rest || null;
    }
  }
  return cur;
}

export function planTurnDelivery(input: {
  finishReason: string;
  message: string | null | undefined;
  origin: TurnOrigin | undefined;
  alreadySent: readonly string[];
}): TurnDelivery {
  const raw = typeof input.message === "string" ? input.message : "";
  const { message, seen } = raw ? splitSeen(raw) : { message: raw };
  const visible = visibleReply(message);
  const spoke = input.alreadySent.some((s) => s.trim().length > 0);

  if (input.finishReason === "tool-calls") {
    return {
      send: visible ? nextBubble(input.alreadySent, visible) : null,
      ...(seen !== undefined ? { seen } : {}),
      fallback: null,
    };
  }

  if (!visible) {
    return {
      send: null,
      ...(seen !== undefined ? { seen } : {}),
      fallback:
        input.origin === "human" && !spoke && !isSilentReply(message)
          ? TURN_FAILED_REPLY
          : null,
    };
  }

  return {
    send: nextBubble(input.alreadySent, visible),
    ...(seen !== undefined ? { seen } : {}),
    fallback: null,
  };
}

/** In-memory per-turn sent bubbles. Same lifetime as wakeup/fallback maps. */
function pruneSent(
  sent: Map<string, EarlySentRow>,
  now: number,
  ttlMs: number,
): void {
  for (const [key, row] of sent) {
    if (now - row.at > ttlMs) sent.delete(key);
  }
}

export function recordSent(
  sent: Map<string, EarlySentRow>,
  turnId: string,
  bubble: string,
  now: number,
  ttlMs = 10 * 60_000,
): string[] {
  pruneSent(sent, now, ttlMs);
  const row = sent.get(turnId) ?? { at: now, bubbles: [] };
  row.at = now;
  row.bubbles = [...row.bubbles, bubble];
  sent.set(turnId, row);
  markTurnSpoke(turnId, now);
  return row.bubbles;
}

export function rememberSoFar(
  sent: Map<string, EarlySentRow>,
  turnId: string,
  soFar: string,
  now: number,
  ttlMs = 10 * 60_000,
): void {
  pruneSent(sent, now, ttlMs);
  const row = sent.get(turnId) ?? { at: now, bubbles: [] };
  row.at = now;
  row.soFar = soFar;
  sent.set(turnId, row);
}

export function bubblesFor(
  sent: Map<string, EarlySentRow>,
  turnId: string,
): readonly string[] {
  return sent.get(turnId)?.bubbles ?? [];
}

export function soFarFor(
  sent: Map<string, EarlySentRow>,
  turnId: string,
): string {
  return sent.get(turnId)?.soFar ?? "";
}

const spokeTurns = new Map<string, number>();

export function markTurnSpoke(
  turnId: string,
  now: number,
  ttlMs = 10 * 60_000,
): void {
  if (!turnId) return;
  for (const [key, at] of spokeTurns) {
    if (now - at > ttlMs) spokeTurns.delete(key);
  }
  spokeTurns.set(turnId, now);
}

export function turnSpoke(turnId: string | undefined, now = Date.now()): boolean {
  if (!turnId) return false;
  const at = spokeTurns.get(turnId);
  return at !== undefined && now - at <= 10 * 60_000;
}
