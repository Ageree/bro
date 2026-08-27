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

export const WAKEUP_CLAIM_LEASE_MS = 120_000;

/** `{runId}:{phase}:{claimedAtMs}` — lease, not a permanent lock. */
export function browserWakeupClaimKey(
  runId: string,
  phase: WakeupPhase,
  claimedAtMs: number,
): string {
  return `${runId}:${phase}:${claimedAtMs}`;
}

export function parseWakeupClaim(claim: string | undefined): {
  runId: string;
  phase: string;
  claimedAtMs: number;
} | null {
  if (!claim) return null;
  const last = claim.lastIndexOf(":");
  if (last <= 0) return null;
  const claimedAtMs = Number(claim.slice(last + 1));
  if (!Number.isFinite(claimedAtMs)) return null;
  const mid = claim.lastIndexOf(":", last - 1);
  if (mid <= 0) return null;
  return {
    runId: claim.slice(0, mid),
    phase: claim.slice(mid + 1, last),
    claimedAtMs,
  };
}

export function claimMatchesRunPhase(
  claim: string | undefined,
  runId: string,
  phase: WakeupPhase,
): boolean {
  const parsed = parseWakeupClaim(claim);
  if (parsed) return parsed.runId === runId && parsed.phase === phase;
  return claim === `${runId}:${phase}`;
}

export type WakeupClaimDecision = "ok" | "duplicate" | "stale_run";

/**
 * Fresh same-key claim is duplicate. Expired lease (or legacy key without ts)
 * can be reclaimed so a crash between claim and POST is not a permanent loss.
 * Duplicate send inside the lease is covered by eve idempotencyKey.
 */
export function decideWakeupClaim(opts: {
  tenantRunId: string | undefined;
  runId: string;
  phase: WakeupPhase;
  existingClaim: string | undefined;
  now: number;
  leaseMs?: number;
}): WakeupClaimDecision {
  if (opts.tenantRunId !== opts.runId) return "stale_run";
  const parsed = parseWakeupClaim(opts.existingClaim);
  if (!parsed || parsed.runId !== opts.runId || parsed.phase !== opts.phase) {
    return "ok";
  }
  const lease = opts.leaseMs ?? WAKEUP_CLAIM_LEASE_MS;
  if (opts.now - parsed.claimedAtMs < lease) return "duplicate";
  return "ok";
}

/** Legacy dispatcher wakeups omit runId — skip the stale-run gate. */
export function wakeupCarriesRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length > 0;
}

export const FOLLOW_RETRY_HINT =
  "доводка временно не подцепилась — спроси человека или вызови browser_task ещё раз";

export function followStartRetry(result: { error?: string } | null): boolean {
  return result?.error === "retry_later";
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
