/** Who decides whether Bro speaks this turn.
 *
 *  Before this module the right to speak was arbitrated in six places that
 *  were concatenated into one system block by `agent/instructions/jobs.ts`:
 *  instructions.md §Voice, `shortAckInstruction`, `JOB_CHECK_QUIET`,
 *  `jobNudgeInstruction`, the browser_poll force-speak line, and the channel
 *  fallbacks. Whichever line landed last won, so the nudge copy had to carry
 *  «Ignore any later line that allows [SILENT]» — an in-code admission that
 *  the prompt contradicted itself. On the model this agent runs
 *  (deepseek-v4.1-flash, reasoning off) a self-contradicting prompt is the
 *  worst possible input.
 *
 *  So: one pure function decides, one generator writes the single line, and
 *  the produced text never asks the model to ignore another instruction —
 *  there is no other instruction to ignore. The channel-level fallbacks
 *  (`silent-turn.ts`) stay where they are: they are a delivery-layer net,
 *  not a prompt. */

export type VoiceVerdict =
  /** The human must get a message in this turn — [SILENT] is a bug here. */
  | "must_speak"
  /** Short reply or a tapback, no tools. */
  | "ack_only"
  /** The ack answers a question Bro asked — proceed, do not ack back. */
  | "ack_confirms"
  /** [SILENT] is allowed when there is genuinely nothing to say. */
  | "may_silent"
  /** Ordinary turn, no voice constraint at all. */
  | "free";

/** Facts about the turn, already gathered by the caller. Nothing in here is
 *  fetched: `turnVoice` must stay pure so the truth table is testable
 *  (`scripts/turn-voice-check.ts`) without Convex, network or env. */
export type VoiceInput = {
  origin?: "human" | "wakeup";
  /** `isShortAckTurn(attrs)` — «ок» / «спасибо» stamped by the channel. */
  shortAck: boolean;
  /** Some open job is waiting on this person's answer. */
  waitingForHuman: boolean;
  /** `wakeupKind === "job_check"`. */
  jobCheck: boolean;
  /** How many jobs are overdue and owe the human a line (`dueJobNudges`). */
  dueNudges: number;
  /** `browserPollForceSpeak(attrs)` — a phased browser errand resolved. */
  browserPollForceSpeak: boolean;
};

/** Priority, highest first. The order IS the policy:
 *
 *  1. must_speak — `browserPollForceSpeak` or a due nudge. Both mean the
 *     server already resolved a concrete outcome (a finished order, a wait
 *     that overran its check-in), so silence is a regression that has bitten
 *     before: see the 2026-09-05 taxi incident in `silent-turn.ts`, where a
 *     resolved «Готово: Такси заказано» never reached the human.
 *  2. ack_only — a short ack while nothing waits on the human. If a job IS
 *     waiting on him, the ack is the answer to Bro's own question, so acking
 *     it back would stall the job: that case falls through to `free`.
 *  3. may_silent — a job_check with nothing due, or any other wakeup that
 *     nobody forced to speak. Background checks repeat; they owe nothing.
 *  4. free — everything else. */
export function turnVoice(input: VoiceInput): VoiceVerdict {
  if (input.browserPollForceSpeak || input.dueNudges > 0) return "must_speak";
  // «ок» means two different things depending on who is waiting. Unprompted,
  // it closes the exchange and deserves a tapback. But when an open job is
  // waiting on THIS person, the same word is the answer Bro asked for, and
  // acking it back strands the job on the step it was already cleared to take.
  if (input.shortAck) return input.waitingForHuman ? "ack_confirms" : "ack_only";
  if (input.jobCheck) return "may_silent";
  if (input.origin === "wakeup") return "may_silent";
  return "free";
}

const ACK_ONLY =
  "The latest human line is a short acknowledgement. Reply in one short line that ends with punctuation or an emoji, or a tapback then [SILENT]. Do not call browser_task, composio, worker, bro_mail, otp_lookup, or search tools. imessage_react / telegram_react are allowed.";

const ACK_CONFIRMS =
  "An open job is waiting on this person and their latest line is a short acknowledgement — that is the confirmation, not a new request. Take the next step now and do not ask them to confirm again. Write one short visible line before any tool.";

const MAY_SILENT =
  "Nobody is owed a message this turn. Make the next step of the job yourself; write only if you have something concrete. If you cannot make progress, answer exactly [SILENT] — the check repeats later.";

const MUST_SPEAK =
  "This turn owes the human one message: the outcome is already decided, so [SILENT] would leave him on read. Write one short line now, bad news first, in Bro's own words.";

/** The one voice line for this turn, or null when the turn is `free`.
 *
 *  Invariant enforced by `scripts/turn-voice-check.ts`: no verdict may ever
 *  produce text containing «ignore any later …». If a verdict needs to
 *  override another instruction, the fix is to remove that instruction from
 *  the prompt, not to ask the model to skip it. */
export function voiceInstruction(
  verdict: VoiceVerdict,
  ctx: { nudges?: readonly string[] } = {},
): string | null {
  switch (verdict) {
    case "must_speak": {
      const lines = (ctx.nudges ?? []).map((n) => n.trim()).filter(Boolean);
      return lines.length > 0 ? `${MUST_SPEAK}\n${lines.join("\n")}` : MUST_SPEAK;
    }
    case "ack_only":
      return ACK_ONLY;
    case "ack_confirms":
      return ACK_CONFIRMS;
    case "may_silent":
      return MAY_SILENT;
    case "free":
      return null;
  }
}
