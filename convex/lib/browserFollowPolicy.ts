const DONE = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "error",
]);

export const POLL_INTERVAL_MS = 2 * 60_000;
export const POLL_GIVE_UP_MS = 20 * 60_000;

export function isFollowTerminal(status: string): boolean {
  return DONE.has(status.trim().toLowerCase());
}

export function pollGiveUp(
  startedAt: number | undefined,
  now: number,
): boolean {
  if (startedAt === undefined) return false;
  return now - startedAt > POLL_GIVE_UP_MS;
}

export type FollowDecision = "wakeup" | "giveup" | "sleep";

export function nextFollowDecision(opts: {
  status: string;
  startedAt: number | undefined;
  now: number;
}): FollowDecision {
  if (isFollowTerminal(opts.status)) return "wakeup";
  if (pollGiveUp(opts.startedAt, opts.now)) return "giveup";
  return "sleep";
}

export function maxPollRounds(): number {
  return Math.ceil(POLL_GIVE_UP_MS / POLL_INTERVAL_MS);
}

/** Start a follow-through workflow only while the Browser Use job is still live. */
export function shouldStartFollowThrough(opts: {
  status: string;
  startedAt: number | undefined;
  now: number;
}): boolean {
  return nextFollowDecision(opts) === "sleep";
}

export function sameBrowserRun(
  tenantRunId: string | undefined,
  runId: string,
): boolean {
  return tenantRunId === runId;
}

export type WakeupPhase = "done" | "giveup";

export function wakeupIdempotencyKey(runId: string, phase: WakeupPhase): string {
  return `browser_poll:${runId}:${phase}`;
}

export type ExistingWorkflowAction = "reuse" | "cancel_then_start" | "start" | "retry_later";

/** One in-progress workflow per runId. Status/cancel errors must not start a twin. */
export function decideExistingWorkflow(opts: {
  statusOk: boolean;
  statusType?: string;
  workflowRunId?: string;
  runId: string;
}): ExistingWorkflowAction {
  if (!opts.statusOk) return "retry_later";
  if (opts.statusType === "inProgress") {
    return opts.workflowRunId === opts.runId ? "reuse" : "cancel_then_start";
  }
  return "start";
}
