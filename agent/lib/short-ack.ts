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
