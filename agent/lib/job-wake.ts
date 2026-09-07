import type { JobWakeRow } from "./convex.ts";
import {
  nudgePrompt,
  shouldNudge,
  shouldSpeakNotSilent,
  type WaitingFor,
} from "../../convex/lib/jobNudgePolicy.ts";

/** Nudge/force-speak only on scheduled job_check wakeups, never human chat. */
export function isJobCheckWakeup(attrs: Record<string, unknown> | undefined): boolean {
  return attrs?.origin === "wakeup" && attrs?.wakeupKind === "job_check";
}

const JOB_FRAMING =
  "Open jobs for this person only. A user message starting with [event:mail] is inbound mail to Bro's mailbox, not the human speaking. If a worker or job is waiting on a one-time code, extract it from the letter (or call otp / otp_lookup) before asking in the thread.";

/** Extra context only when this person has open jobs. */
export function jobWakeInstruction(lines: readonly string[]): string | null {
  if (lines.length === 0) return null;
  return `${JOB_FRAMING}\n\n${lines.join("\n")}`;
}

/** `job_wait` payload: `джоб <id>: <goal>`. Same match as the old HTTP path. */
export function matchWakeJob(
  rows: readonly JobWakeRow[],
  payload: string,
): JobWakeRow | undefined {
  const text = payload.trim();
  if (!text) return undefined;
  const idMatch = /^джоб\s+(\S+):/.exec(text);
  if (idMatch?.[1]) {
    const hit = rows.find((j) => j.id === idMatch[1]);
    if (hit) return hit;
  }
  return rows.find((j) => text.includes(j.id));
}

export function jobCheckPayload(attrs: Record<string, unknown> | undefined): string {
  return typeof attrs?.wakeupPayload === "string" ? attrs.wakeupPayload : "";
}

/** Wakeup user text. No [SILENT] here — turn.started decides speak vs quiet. */
export function jobCheckWakePrompt(payload: string): string {
  return `[background wakeup] Фоновая проверка джоба: ${payload}. Открытые джобы этого человека уже в контексте. Сделай следующий шаг цепочки сам (проверь почту/статус нужным тулом: composio, browser_task, bro_mail, otp_lookup). Если ждёшь OTP — сначала inbox/archive, в тред только если письма нет. Если есть прогресс — сделай шаг и коротко напиши человеку. Если джоб уже закрыт или отменён — вызови cancel_wakeup с kind=job_check и payloadContains «джоб <id>».`;
}

export const JOB_CHECK_QUIET =
  "If you cannot make progress on this job_check, answer exactly [SILENT]. The check will repeat.";

export function dueJobNudges(
  rows: readonly JobWakeRow[],
  now: number,
  scope?: { payload: string },
): JobWakeRow[] {
  const pool = scope
    ? [matchWakeJob(rows, scope.payload)].filter((j): j is JobWakeRow => Boolean(j))
    : rows;
  return pool.filter((row) => {
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
  due: readonly JobWakeRow[],
): string | null {
  if (due.length === 0) return null;
  return due
    .map((job) => {
      const waitingFor = job.waitingFor as WaitingFor;
      const text = nudgePrompt({
        waitingFor,
        goal: job.goal,
        note: job.note,
      });
      return `This job has been waiting too long. Do NOT answer [SILENT] — write the human now: ${text}. Ignore any later line that allows [SILENT].`;
    })
    .join("\n");
}
