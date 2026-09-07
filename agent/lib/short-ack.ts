/** Fast path for short human acks. The agent still runs (archive + jobs).
 *  This only steers the model off a new tool loop when nothing is waiting. */

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
