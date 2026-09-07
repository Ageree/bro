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

export function isShortAck(text: string): boolean {
  const folded = foldAsk(text);
  if (!folded) return false;
  return SHORT_ACK.has(folded);
}

export function shortAckAttribute(text: string): Record<string, string> {
  return isShortAck(text) ? { shortAck: "1" } : {};
}

/** Eve's instruction snapshot is history-only (`prepareDynamicInstructionPreamble`
 *  gets `session.history`, not this turn's input). Never key the steer off
 *  `ctx.messages` — a previous «ок» would then forbid tools on «купи кроссовки».
 *  Channels stamp `shortAck` on the inbound auth attributes instead. */
export function isShortAckTurn(
  attrs: Record<string, unknown> | undefined,
): boolean {
  if (!attrs || attrs.origin !== "human") return false;
  return attrs.shortAck === "1";
}

export function shortAckInstruction(opts: {
  waitingForHuman: boolean;
}): string {
  if (opts.waitingForHuman) {
    return `The latest human line is a short acknowledgement. An open job is waiting on this person — treat the ack as confirmation and take the next step. Do not ask them to re-confirm. Write one short visible line that ends with punctuation or an emoji before any tool.`;
  }
  return `The latest human line is a short acknowledgement. Reply in one short line that ends with punctuation or an emoji, or a tapback then [SILENT]. Do not call browser_task, composio, worker, bro_mail, otp_lookup, or search tools. imessage_react / telegram_react are allowed.`;
}
