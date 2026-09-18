/**
 * The per-tool half of the instinct gate.
 *
 * `convex/lib/instinctPolicy.ts` decides WHAT an unprompted turn may not do
 * and why; this module is how a tool asks. It is deliberately tiny and
 * dependency-free — every guarded tool imports it, and the guard must not
 * drag Convex, Supermemory or the Composio SDK into a tool that does not
 * already need them (which is what importing `instinct-wake.ts` would do).
 */

import {
  instinctRefusalHint,
  instinctToolAllowed,
} from "../../convex/lib/instinctPolicy.ts";

/** Auth attributes of a turn the background scan started (see the wakeup
 *  route in `agent/channels/imessage.ts`). */
export function isInstinctTurn(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return attrs?.origin === "wakeup" && attrs?.wakeupKind === "instinct";
}

export type InstinctRefusal = { status: "refused"; hint: string };

/**
 * `null` on every ordinary turn — the common case, and the only one with a
 * cost. A refusal is returned as the tool's own result rather than thrown, so
 * the model reads it as an answer and finishes the turn (one line to the
 * person, or `[SILENT]`) instead of retrying against an error.
 */
export function instinctBlocked(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
  tool: string,
): InstinctRefusal | null {
  if (!isInstinctTurn(attrs)) return null;
  if (instinctToolAllowed(tool)) return null;
  return { status: "refused", hint: instinctRefusalHint(tool) };
}
