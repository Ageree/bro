const JOB_FRAMING =
  "Open jobs for this person only. A user message starting with [event:mail] is inbound mail to Bro's mailbox, not the human speaking. If a worker or job is waiting on a one-time code, extract it from the letter (or call otp / otp_lookup) before asking in the thread.";

/** Extra context only when this person has open jobs. */
export function jobWakeInstruction(lines: readonly string[]): string | null {
  if (lines.length === 0) return null;
  return `${JOB_FRAMING}\n\n${lines.join("\n")}`;
}
