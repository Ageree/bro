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
  "У меня тут что-то отвалилось. Напиши ещё раз через минуту, уже разбираюсь.";

export type TurnOrigin = "human" | "wakeup";

/** Auth attribute the channel stamps on every `from().send`. */
export const ORIGIN_ATTR = "origin";

export function turnOrigin(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): TurnOrigin | undefined {
  const raw = attributes?.[ORIGIN_ATTR];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "human" || value === "wakeup") return value;
  return undefined;
}

export function isSilentReply(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim().startsWith("[SILENT]");
}

/** Fallback text for a `turn.failed` event, or null for background turns.
 *
 *  Incident 2026-09-05 (taxi): a `done` browser_poll wakeup turn threw
 *  instead of ending with empty text — `turn.failed` fires instead of
 *  `message.completed`, and this path used to return null for every wakeup,
 *  so the already-resolved outcome («Готово: Такси заказано… 508 ₽») never
 *  reached the human. A phased browser_poll wakeup already carries a
 *  concrete outcome server-side (see `browserPollForceSpeak`), so it must
 *  still get its canned line even when the turn itself blew up. */
export function fallbackForFailed(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (turnOrigin(attributes) === "human") return TURN_FAILED_REPLY;
  if (browserPollForceSpeak(attributes)) return wakeupFallbackText(attributes);
  return null;
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

/** Auth attributes eve's /internal/wakeup route stamps on a browser_poll
 *  turn (goal.md §2, "never-silent wakeups"). `wakeupPhase` is one of
 *  done|need|failed|giveup; `wakeupFallback` is the exact canned Russian
 *  line to use if the model answers [SILENT] or ends with no visible text. */
export const WAKEUP_PHASE_ATTR = "wakeupPhase";
export const WAKEUP_FALLBACK_ATTR = "wakeupFallback";

function attrString(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | undefined {
  const raw = attributes?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The canned line to send instead of leaving a silent/empty browser_poll
 *  wakeup turn unanswered. Null for anything else — a human turn already has
 *  its own TURN_FAILED_REPLY via `fallbackForFailed`. */
export function wakeupFallbackText(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (turnOrigin(attributes) !== "wakeup") return null;
  return attrString(attributes, WAKEUP_FALLBACK_ATTR) ?? null;
}

/** Every phased browser_poll wakeup (done/need/failed/giveup) already means
 *  the follow-through workflow resolved to a concrete outcome server-side —
 *  there is no legitimate "still running, stay quiet" case left, so the
 *  model must never answer [SILENT] on one of these turns. */
export function browserPollForceSpeak(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (turnOrigin(attributes) !== "wakeup") return false;
  if (attrString(attributes, "wakeupKind") !== "browser_poll") return false;
  const phase = attrString(attributes, WAKEUP_PHASE_ATTR);
  return phase === "done" || phase === "need" || phase === "failed" || phase === "giveup";
}
