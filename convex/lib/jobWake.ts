/** Shared wake-line format for open jobs. Agent and Convex must stay in sync. */

export type JobWakeFields = {
  _id: string;
  goal: string;
  doneWhen: string;
  status: string;
  waitingFor?: string;
  note?: string;
  emailMessageId?: string;
  waitingSince?: number;
  lastNudgeAt?: number;
};

export function formatJobWakeLine(j: JobWakeFields): string {
  const wait = j.waitingFor ? ` waitingFor=${j.waitingFor}` : "";
  const note = j.note ? ` note=${j.note}` : "";
  const mail = j.emailMessageId ? ` emailMessageId=${j.emailMessageId}` : "";
  const since = j.waitingSince != null ? ` waitingSince=${j.waitingSince}` : "";
  const nudged = j.lastNudgeAt != null ? ` lastNudgeAt=${j.lastNudgeAt}` : "";
  return `id=${j._id} goal="${j.goal}" doneWhen="${j.doneWhen}" status=${j.status}${wait}${note}${mail}${since}${nudged}`;
}
