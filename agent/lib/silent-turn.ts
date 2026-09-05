/** Never leave a person on read.
 *
 *  Incident 2026-09-05: a Convex validator bug made `browser_task` throw
 *  twice; the model then ended the turn with no text, and the person saw
 *  nothing for minutes. The channel only forwarded non-empty messages, so
 *  a failed or empty turn was indistinguishable from a deliberate [SILENT].
 *
 *  This policy decides when the channel must send a fallback line itself.
 *  Only turns a human started get one: background wakeups are expected to
 *  end silently. */

export const TURN_FAILED_REPLY =
  "Что-то сломалось у меня внутри 🙈 Напиши ещё раз через минуту — я уже разбираюсь.";

export type TurnOrigin = "human" | "wakeup";

/** Auth attribute the channel stamps on every `from().send`. */
export const ORIGIN_ATTR = "origin";

export function turnOrigin(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
): TurnOrigin | undefined {
  const raw = attributes?.[ORIGIN_ATTR];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "human" || value === "wakeup") return value;
  return undefined;
}

export type CompletedTurn = {
  finishReason: string;
  message: string | null | undefined;
  origin: TurnOrigin | undefined;
};

/** Fallback text for a completed turn, or null when the model said enough
 *  (or was allowed to stay quiet). `tool-calls` steps are mid-turn. */
export function fallbackForCompleted(turn: CompletedTurn): string | null {
  if (turn.origin !== "human") return null;
  if (turn.finishReason === "tool-calls") return null;
  if (turn.message && turn.message.trim()) return null;
  return TURN_FAILED_REPLY;
}

/** Fallback text for a `turn.failed` event, or null for background turns. */
export function fallbackForFailed(origin: TurnOrigin | undefined): string | null {
  return origin === "human" ? TURN_FAILED_REPLY : null;
}

/** One fallback per turn even if both `message.completed` (empty) and
 *  `turn.failed` fire. In-memory only, like wakeup dedupe. */
export function takeFallbackSlot(
  sent: Map<string, number>,
  turnId: string,
  now: number,
  ttlMs = 10 * 60_000,
): boolean {
  for (const [key, at] of sent) {
    if (now - at > ttlMs) sent.delete(key);
  }
  if (sent.has(turnId)) return false;
  sent.set(turnId, now);
  return true;
}
