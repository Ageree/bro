import type { JobWakeRow } from "./convex.ts";
import {
  nudgePrompt,
  shouldNudge,
  shouldSpeakNotSilent,
  type WaitingFor,
} from "../../convex/lib/jobNudgePolicy.ts";

const JOB_FRAMING =
  "Open jobs for this person only. A user message starting with [event:mail] is inbound mail to Bro's mailbox, not the human speaking. If a worker or job is waiting on a one-time code, extract it from the letter (or call otp / otp_lookup) before asking in the thread.";

/** Extra context only when this person has open jobs. */
export function jobWakeInstruction(lines: readonly string[]): string | null {
  if (lines.length === 0) return null;
  return `${JOB_FRAMING}\n\n${lines.join("\n")}`;
}

export function dueJobNudges(
  rows: readonly JobWakeRow[],
  now: number,
): JobWakeRow[] {
  return rows.filter((row) => {
    const waitingFor = row.waitingFor;
    if (
      waitingFor !== "human" &&
      waitingFor !== "email" &&
      waitingFor !== "browser"
    ) {
      return false;
    }
    return (
      shouldNudge({
        waitingFor,
        waitingSince: row.waitingSince,
        lastNudgeAt: row.lastNudgeAt,
        now,
      }) && shouldSpeakNotSilent(waitingFor)
    );
  });
}

export function jobNudgeInstruction(
  rows: readonly JobWakeRow[],
  now: number,
): string | null {
  const due = dueJobNudges(rows, now);
  if (due.length === 0) return null;
  return due
    .map((job) => {
      const waitingFor = job.waitingFor as WaitingFor;
      const text = nudgePrompt({
        waitingFor,
        goal: job.goal,
        note: job.note,
      });
      return `This job has been waiting too long. Do NOT answer [SILENT] — write the human now: ${text}`;
    })
    .join("\n");
}
