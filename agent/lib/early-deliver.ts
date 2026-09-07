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
  const joined = sent.join("\n\n");
  if (joined && (cur === joined || cur.startsWith(`${joined}\n`))) {
    const rest = cur.slice(joined.length).replace(/^\n+/, "").trim();
    return rest || null;
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
export function recordSent(
  sent: Map<string, { at: number; bubbles: string[] }>,
  turnId: string,
  bubble: string,
  now: number,
  ttlMs = 10 * 60_000,
): string[] {
  for (const [key, row] of sent) {
    if (now - row.at > ttlMs) sent.delete(key);
  }
  const row = sent.get(turnId) ?? { at: now, bubbles: [] };
  row.at = now;
  row.bubbles = [...row.bubbles, bubble];
  sent.set(turnId, row);
  return row.bubbles;
}

export function bubblesFor(
  sent: Map<string, { at: number; bubbles: string[] }>,
  turnId: string,
): readonly string[] {
  return sent.get(turnId)?.bubbles ?? [];
}
