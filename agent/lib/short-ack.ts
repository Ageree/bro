/** Fast path for short human acks. The agent still runs (archive + jobs).
 *  This only steers the model off a new tool loop when nothing is waiting.
 *
 *  Eve's instruction snapshot is history-only (`prepareDynamicInstructionPreamble`
 *  gets `session.history`, not this turn's input). Never key the steer off
 *  `ctx.messages` — a previous «ок» would then forbid tools on «купи кроссовки».
 *  Channels stamp `shortAck` on the inbound auth attributes instead. */

import { foldAsk } from "./onboard-policy.ts";

const SHORT_ACK = new Set([
  "ок",
  "ok",
  "okay",
  "окей",
  "ок бро",
  "ok bro",
  "спасибо",
  "спасибо бро",
  "thanks",
  "thank you",
  "thx",
  "понял",
  "поняла",
  "ясно",
  "принято",
]);

export const SHORT_ACK_ATTR = "shortAck";
export const SHORT_ACK_VALUE = "1";

export function isShortAck(text: string): boolean {
  const folded = foldAsk(text);
  if (!folded) return false;
  return SHORT_ACK.has(folded);
}

/** Auth attrs to merge onto a 1:1 human `from().send`. Empty when not an ack. */
export function shortAckAttribute(text: string): Record<string, string> {
  return isShortAck(text) ? { [SHORT_ACK_ATTR]: SHORT_ACK_VALUE } : {};
}

/** True only for a human turn the channel stamped as this inbound ack. */
export function isShortAckTurn(
  attrs: Record<string, unknown> | undefined,
): boolean {
  if (!attrs || attrs.origin !== "human") return false;
  const flag = attrs[SHORT_ACK_ATTR];
  return flag === SHORT_ACK_VALUE || flag === true;
}

export function shortAckInstruction(opts: {
  waitingForHuman: boolean;
}): string {
  if (opts.waitingForHuman) {
    return [
      "The latest human line is a short acknowledgement.",
      "An open job is waiting on this person — treat the ack as confirmation and take the next step.",
      "Do not ask them to re-confirm.",
    ].join(" ");
  }
  return [
    "The latest human line is a short acknowledgement.",
    "Reply in one short line, or a tapback then [SILENT].",
    "Do not call browser_task, composio, worker, bro_mail, otp_lookup, or search tools.",
    "imessage_react / telegram_react are allowed.",
  ].join(" ");
}
