// Documented v4 run terminal states (docs.browser-use.com/cloud/api-v4:
// get-run/get-run-status/get-session all use the same six-value status
// enum) plus our own `stalled` sentinel for a run followThrough gave up on.
export const DONE = new Set(["completed", "failed", "cancelled", "stalled"]);

/** Terminal status followThrough writes on give-up — never sent by the vendor. */
export const STALLED_STATUS = "stalled";

/**
 * hydrate()'s guarded-failure placeholder for a transient upstream miss.
 * Never a real Browser Use status — never let it overwrite one on the tenant.
 */
export const UNKNOWN_STATUS = "unknown";

/** undefined when `status` is hydrate's "unknown" placeholder — a caller should skip the write. */
export function persistableStatus(status: string): string | undefined {
  return status.trim().toLowerCase() === UNKNOWN_STATUS ? undefined : status;
}

// Kept for callers/checks that still name the old steady cadence; the
// schedule below no longer uses it internally.
export const POLL_INTERVAL_MS = 2 * 60_000;
export const POLL_GIVE_UP_MS = 20 * 60_000;

// Poll cadence after a run starts: ramp 10s→15s→20s→30s→45s→60s, then a
// steady 90s until give-up. No webhook exists (v4 confirmed) — this is the
// only lever for follow-through latency.
export const FOLLOW_SCHEDULE_MS = [
  10_000, 15_000, 20_000, 30_000, 45_000, 60_000,
] as const;
export const FOLLOW_STEADY_SLEEP_MS = 90_000;

export function followSchedule(): number[] {
  return [...FOLLOW_SCHEDULE_MS];
}

export function followSleepMs(pollIndex: number): number {
  return FOLLOW_SCHEDULE_MS[pollIndex] ?? FOLLOW_STEADY_SLEEP_MS;
}

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

/** Loop rounds whose cumulative sleep approximates POLL_GIVE_UP_MS under followSchedule(). */
export function maxPollRounds(): number {
  const rampSum = FOLLOW_SCHEDULE_MS.reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, POLL_GIVE_UP_MS - rampSum);
  const steadyRounds = Math.ceil(remaining / FOLLOW_STEADY_SLEEP_MS);
  return FOLLOW_SCHEDULE_MS.length + steadyRounds;
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

/**
 * `need` — a labelled or heuristic stop that waits on the human (code, 3DS,
 * captcha, password, missing data). `failed` — a terminal failed/cancelled
 * run with no pending need. `done`/`giveup` are unchanged from A1.
 */
export type WakeupPhase = "done" | "need" | "failed" | "giveup";

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
