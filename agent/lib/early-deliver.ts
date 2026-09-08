import { splitSeen } from "./wakeup-text.ts";
import type { TurnOrigin } from "./silent-turn.ts";
import { isSilentReply, TURN_FAILED_REPLY } from "./silent-turn.ts";

export type TurnDelivery = {
  send: string | null;
  seen?: string;
  fallback: string | null;
};

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

function foldWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function restAfterPrefix(cur: string, prefix: string): string | null | undefined {
  if (!prefix) return undefined;
  if (cur === prefix) return null;
  if (
    cur.startsWith(`${prefix}\n`) ||
    (cur.startsWith(prefix) && hasPrefixBoundary(cur, prefix))
  ) {
    return (
      cur
        .slice(prefix.length)
        .replace(/^[\s.!?…。！？,;:]+/u, "")
        .trim() || null
    );
  }
  return undefined;
}

function hasPrefixBoundary(cur: string, prefix: string): boolean {
  if (prefix.length >= cur.length) return true;
  const last = prefix[prefix.length - 1] ?? "";
  if (/[.!?…。！？\s]/.test(last)) return true;
  const next = cur[prefix.length] ?? "";
  return /[\s.!?…。！？,;:)\]]/.test(next);
}

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

const ABBREV_TAILS = new Set([
  "ул",
  "г",
  "д",
  "к",
  "корп",
  "стр",
  "просп",
  "пер",
  "пл",
  "обл",
  "тел",
  "т",
  "см",
  "др",
  "тд",
  "тп",
  "млн",
  "млрд",
  "тыс",
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "dept",
  "inc",
  "ltd",
  "vs",
  "etc",
]);

function foldTail(word: string): string {
  return word
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function stripFinalPunct(s: string): string {
  return s.replace(/[.!?…。！？]+$/u, "").trim();
}

const ACK_TAILS = new Set([
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
  "ага",
]);

export function isLikelyCompleteBubble(text: string): boolean {
  const t = text.trim();
  if (!t || !visibleReply(t)) return false;
  if (!/\p{L}|\p{N}/u.test(t)) return true;
  const tokens = stripFinalPunct(t).split(/\s+/).filter(Boolean);
  const lastWord = tokens[tokens.length - 1] ?? "";
  const firstFolded = foldTail(tokens[0] ?? "");
  const lastFolded = foldTail(lastWord);
  const endsEmoji = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u.test(t);
  if (
    ACK_TAILS.has(firstFolded) &&
    tokens.length <= 2 &&
    (endsEmoji || /[.!?…。！？]$/u.test(t))
  ) {
    return true;
  }
  if (/[!?！？]$/u.test(t)) {
    return Boolean(/\p{L}/u.test(lastWord) && !ABBREV_TAILS.has(lastFolded));
  }
  if (/\.{2,}$/.test(t) || /…$/.test(t)) return false;
  if (!/[.。]$/u.test(t)) return false;
  if (ABBREV_TAILS.has(lastFolded)) return false;
  if (!/\p{L}/u.test(lastWord) || /^\d/u.test(lastWord)) return false;
  const rawLast = t.split(/\s+/).pop() ?? "";
  if (/\/\S+$/.test(rawLast) || /\.[A-Za-z0-9]{1,5}\.?$/.test(rawLast)) {
    return false;
  }
  if (COMPLETE_TAILS.has(lastFolded)) return true;
  return lastWord.length >= 4;
}

export function firstLikelyCompletePrefix(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (isLikelyCompleteBubble(t)) return t;
  const re = /[.!?…。！？]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m[0] === ".") {
      const run = /^\.{2,}/.exec(t.slice(m.index));
      if (run) {
        re.lastIndex = m.index + run[0].length;
        continue;
      }
      if (/^(?:png|jpe?g|gif|webp|mp4|mov|pdf)\b/i.test(t.slice(m.index + 1))) {
        continue;
      }
    }
    const prefix = t.slice(0, m.index + m[0].length).trim();
    if (isLikelyCompleteBubble(prefix)) return prefix;
  }
  return null;
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

export function likelyCompleteVisibleText(soFar: string): string | null {
  const finished = finishedVisibleText(soFar);
  const open = openVisibleLine(soFar);
  const peeled = open ? firstLikelyCompletePrefix(open) : null;
  if (peeled) {
    return finished ? `${finished}\n${peeled}` : peeled;
  }
  return finished;
}

export function isIncompleteDraft(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[:(\/—–-]$/.test(t)) return true;
  if (/\(\s*$/.test(t)) return true;
  if (/\/(?:home\/user|tmp)\/\S+\.$/.test(t)) return true;
  if (/\b(?:png|jpe?g|gif|webp)\s*\(\s*$/i.test(t)) return true;
  return false;
}

function flushable(text: string | null): string | null {
  if (!text || isIncompleteDraft(text)) return null;
  return text;
}

export function planStreamFlush(input: {
  soFar: string;
  alreadySent: readonly string[];
}): Pick<TurnDelivery, "send" | "seen"> {
  const raw = typeof input.soFar === "string" ? input.soFar : "";
  const { seen } = raw ? splitSeen(raw) : {};
  const text = flushable(likelyCompleteVisibleText(raw));
  if (!text) return { send: null, ...(seen !== undefined ? { seen } : {}) };
  return {
    send: nextBubble(input.alreadySent, text),
    ...(seen !== undefined ? { seen } : {}),
  };
}

export function planPreToolFlush(input: {
  soFar: string;
  alreadySent: readonly string[];
}): Pick<TurnDelivery, "send" | "seen"> {
  const raw = typeof input.soFar === "string" ? input.soFar : "";
  const { message, seen } = raw ? splitSeen(raw) : { message: raw };
  const text = flushable(finishedVisibleText(raw) ?? visibleReply(message));
  if (!text) return { send: null, ...(seen !== undefined ? { seen } : {}) };
  return {
    send: nextBubble(input.alreadySent, text),
    ...(seen !== undefined ? { seen } : {}),
  };
}

function peelOneBubble(cur: string, bubble: string): string | null | undefined {
  const line = restAfterPrefix(foldLines(cur), foldLines(bubble));
  if (line !== undefined) return line;
  const ws = restAfterPrefix(foldWs(cur), foldWs(bubble));
  if (ws !== undefined) return ws;
  const bare = foldLines(stripFinalPunct(bubble));
  const curFold = foldLines(cur);
  if (bare && curFold.startsWith(bare) && curFold.length > bare.length) {
    const next = curFold[bare.length] ?? "";
    if (/[.!?…。！？]/.test(next)) {
      return (
        curFold
          .slice(bare.length)
          .replace(/^[\s.!?…。！？,;:]+/u, "")
          .trim() || null
      );
    }
  }
  return undefined;
}

function peelSentInOrder(
  current: string,
  sent: readonly string[],
): string | null | undefined {
  if (sent.length === 0) return undefined;
  let rest: string | null = current;
  let peeled = 0;
  for (const bubble of sent) {
    if (rest === null) return null;
    const next = peelOneBubble(rest, bubble);
    if (next === undefined) continue;
    peeled += 1;
    rest = next;
  }
  return peeled === 0 ? undefined : rest === null ? null : rest.trim() || null;
}

export function nextBubble(
  alreadySent: readonly string[],
  current: string,
): string | null {
  const cur = current.trim();
  if (!cur) return null;
  const sent = alreadySent.map((s) => s.trim()).filter(Boolean);
  if (sent.some((s) => s === cur || foldWs(s) === foldWs(cur))) return null;
  if (pathAlreadyCovered(cur, sent)) return null;
  const last = sent[sent.length - 1];
  if (last && last.startsWith(cur)) return null;
  if (last && foldWs(last).endsWith(foldWs(cur))) return null;
  const curFold = foldLines(cur);
  const curWs = foldWs(cur);
  const prefixes = [
    sent.join("\n\n"),
    sent.join("\n"),
    sent.join(" "),
    last ?? "",
  ];
  for (const joined of prefixes) {
    const rest = restAfterPrefix(curFold, foldLines(joined));
    if (rest !== undefined) return rest;
  }
  const sentWs = foldWs(sent.join(" "));
  const restWs = restAfterPrefix(curWs, sentWs);
  if (restWs !== undefined) return restWs;
  const sequential = peelSentInOrder(cur, sent);
  if (sequential !== undefined) {
    return sequential === null ? null : dropSpamFragment(sequential);
  }
  if (last) {
    const bare = foldLines(stripFinalPunct(last));
    if (bare && curFold.startsWith(bare) && curFold.length > bare.length) {
      const next = curFold[bare.length] ?? "";
      if (/[.!?…。！？]/.test(next)) {
        return (
          curFold
            .slice(bare.length)
            .replace(/^[\s.!?…。！？,;:]+/u, "")
            .trim() || null
        );
      }
    }
    const restated = peelRestatement(last, cur);
    if (restated !== undefined) return dropSpamFragment(restated);
  }
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const bubble = sent[i];
    if (!bubble || bubble === last) continue;
    const restated = peelRestatement(bubble, cur);
    if (restated !== undefined) return dropSpamFragment(restated);
    if (isNearDuplicate(bubble, cur)) return null;
  }
  if (last && isNearDuplicate(last, cur)) return null;
  return cur;
}

function dropSpamFragment(text: string | null): string | null {
  if (!text || isSpamFragment(text)) return null;
  return text;
}

function isSpamFragment(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\/(?:home\/user|tmp)\/\S+\.$/.test(t)) return true;
  if (/^(?:png|jpe?g|gif|webp|mp4)(?:\s*\(\s*)?$/i.test(t)) return true;
  return false;
}

function pathAlreadyCovered(cur: string, sent: readonly string[]): boolean {
  const path = cur.match(/(\/(?:home\/user|tmp)\/[^\s]+)$/)?.[1];
  if (!path) return false;
  const stem = path.replace(/\.$/, "").replace(/\.(?:jpg|jpeg|png|gif|webp)$/i, "");
  if (stem.length < 8) return false;
  return sent.some((s) => foldWs(s).includes(stem));
}

function isNearDuplicate(a: string, b: string): boolean {
  const left = foldWs(a);
  const right = foldWs(b);
  if (!left || !right) return false;
  const lenRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  if (lenRatio < 0.7) return false;
  const tokensA = left.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const tokensB = right.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (tokensA.length < 6 || tokensB.length < 6) return false;
  const setA = new Set(tokensA);
  const shared = tokensB.filter((w) => setA.has(w)).length;
  return shared / Math.min(tokensA.length, tokensB.length) >= 0.75;
}

function peelRestatement(last: string, cur: string): string | null | undefined {
  const a = foldLines(last);
  const b = foldLines(cur);
  if (!a || !b) return undefined;
  if (a === b) return null;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i += 1;
  if (i < n && i > 0 && !/\s/.test(a[i] ?? " ") && !/\s/.test(b[i] ?? " ")) {
    const ws = b.lastIndexOf(" ", i);
    if (ws >= 24) i = ws;
  }
  const ratio = i / Math.min(a.length, b.length);
  if (i < 32) return undefined;
  if (ratio < 0.45) return undefined;
  const tail = b.slice(i).replace(/^[\s.!?…。！？,;:—–-]+/u, "").trim();
  return tail || null;
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
    const text = flushable(visible);
    return {
      send: text ? nextBubble(input.alreadySent, text) : null,
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
  if (isLookingBubble(bubble)) markTurnLooking(turnId, now);
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

export function isLookingBubble(text: string): boolean {
  return /ищу|looking/i.test(text);
}

const lookingTurns = new Map<string, number>();

export function markTurnLooking(
  turnId: string,
  now: number,
  ttlMs = 10 * 60_000,
): void {
  if (!turnId) return;
  for (const [key, at] of lookingTurns) {
    if (now - at > ttlMs) lookingTurns.delete(key);
  }
  lookingTurns.set(turnId, now);
}

export function turnLooking(turnId: string | undefined, now = Date.now()): boolean {
  if (!turnId) return false;
  const at = lookingTurns.get(turnId);
  return at !== undefined && now - at <= 10 * 60_000;
}
