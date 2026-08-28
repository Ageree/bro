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

export type WakeupClaimStatus = "pending" | "sent";

/**
 * Workpool retry after attempt k: initialBackoffMs * base^(k-1) * jitter(0.5..1.5).
 * Worst-case wait before attempt 9: 0.5*500*(2^8-1)=63750ms > 60s lease, so a
 * pending_claim_in_flight throw is retried until the lease expires and reclaim
 * succeeds. Nominal (no jitter) wait before attempt 8 is already 63500ms.
 */
export const WAKEUP_CLAIM_LEASE_MS = 60_000;
export const WAKEUP_STEP_MAX_ATTEMPTS = 9;
export const WAKEUP_STEP_INITIAL_BACKOFF_MS = 500;
export const WAKEUP_STEP_BACKOFF_BASE = 2;
export const WAKEUP_RETRY_JITTER_MIN = 0.5;

export const wakeupStepRetry = {
  maxAttempts: WAKEUP_STEP_MAX_ATTEMPTS,
  initialBackoffMs: WAKEUP_STEP_INITIAL_BACKOFF_MS,
  base: WAKEUP_STEP_BACKOFF_BASE,
};

export function wakeupRetryWaitBeforeLastMs(
  jitter = WAKEUP_RETRY_JITTER_MIN,
): number {
  const delays = WAKEUP_STEP_MAX_ATTEMPTS - 1;
  return (
    jitter *
    WAKEUP_STEP_INITIAL_BACKOFF_MS *
    (WAKEUP_STEP_BACKOFF_BASE ** delays - 1)
  );
}

/** `{runId}:{phase}:{claimedAtMs}:{pending|sent}` */
export function browserWakeupClaimKey(
  runId: string,
  phase: WakeupPhase,
  claimedAtMs: number,
  status: WakeupClaimStatus,
): string {
  return `${runId}:${phase}:${claimedAtMs}:${status}`;
}

export function parseWakeupClaim(claim: string | undefined): {
  runId: string;
  phase: string;
  claimedAtMs: number;
  status: WakeupClaimStatus;
} | null {
  if (!claim) return null;
  const parts = claim.split(":");
  if (parts.length < 4) return null;
  const status = parts.at(-1);
  const claimedRaw = parts.at(-2);
  const phase = parts.at(-3);
  if (status !== "pending" && status !== "sent") return null;
  const claimedAtMs = Number(claimedRaw);
  if (!Number.isFinite(claimedAtMs) || !phase) return null;
  const runId = parts.slice(0, -3).join(":");
  if (!runId) return null;
  return { runId, phase, claimedAtMs, status };
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

export type WakeupClaimDecision =
  | "ok"
  | "duplicate"
  | "stale_run"
  | "pending_in_flight";

/**
 * sent → real duplicate (POST already landed).
 * pending + fresh lease → throw so workflow retries (not a silent success).
 * pending + expired / legacy → reclaim.
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
  if (parsed.status === "sent") return "duplicate";
  const lease = opts.leaseMs ?? WAKEUP_CLAIM_LEASE_MS;
  if (opts.now - parsed.claimedAtMs < lease) return "pending_in_flight";
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
