import {
  nextBrowserAction,
  nextFollowDecision,
  normalizeTask,
  pollTimedOut,
  shouldStartFollowThrough,
} from "../agent/lib/browser-policy.ts";
import {
  browserWakeupClaimKey,
  decideExistingWorkflow,
  decideWakeupClaim,
  FOLLOW_RETRY_HINT,
  followStartRetry,
  maxPollRounds,
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  sameBrowserRun,
  wakeupIdempotencyKey,
} from "../convex/lib/browserFollowPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(normalizeTask("  Купить   скотч ") === "купить скотч", "normalize");

assert(
  nextBrowserAction({ incomingTask: "скотч на ozon" }) === "start",
  "fresh start",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "ну что",
  }) === "poll",
  "ping while running polls",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "queued",
    incomingTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
  }) === "poll",
  "queued is in-flight",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
    incomingTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
  }) === "reuse",
  "identical completed task is reused, not re-run",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "обувь на ozon",
    incomingTask: "скотч на wb",
  }) === "start",
  "new task after complete starts",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "Купить обувь 40 на Ozon",
    incomingTask: "ну что",
  }) === "reuse",
  "short ping after complete reuses result",
);

assert(
  nextBrowserAction({
    reset: true,
    runId: "r1",
    status: "running",
    incomingTask: "x",
  }) === "start",
  "reset starts",
);

const t0 = Date.parse("2026-08-27T12:00:00.000Z");
assert(pollTimedOut(t0, t0 + 10 * 60_000) === false, "poll not expired");
assert(pollTimedOut(t0, t0 + 20 * 60_000) === false, "poll exactly 20min");
assert(pollTimedOut(t0, t0 + 20 * 60_000 + 1) === true, "poll expired");
assert(pollTimedOut(undefined, t0) === false, "poll missing start");

assert(POLL_INTERVAL_MS === 2 * 60_000, "sleep 2min");
assert(POLL_GIVE_UP_MS === 20 * 60_000, "give-up 20min");
assert(maxPollRounds() === 10, "10 poll rounds");
assert(
  nextFollowDecision({ status: "running", startedAt: t0, now: t0 + 2 * 60_000 }) ===
    "sleep",
  "running → sleep",
);
assert(
  nextFollowDecision({
    status: "completed",
    startedAt: t0,
    now: t0 + 4 * 60_000,
  }) === "wakeup",
  "completed → wakeup",
);
assert(
  nextFollowDecision({
    status: "failed",
    startedAt: t0,
    now: t0 + 2 * 60_000,
  }) === "wakeup",
  "failed → wakeup",
);
assert(
  nextFollowDecision({
    status: "running",
    startedAt: t0,
    now: t0 + POLL_GIVE_UP_MS + 1,
  }) === "giveup",
  "running past 20min → giveup",
);
assert(
  shouldStartFollowThrough({
    status: "queued",
    startedAt: t0,
    now: t0 + 60_000,
  }) === true,
  "start workflow while live",
);
assert(
  shouldStartFollowThrough({
    status: "completed",
    startedAt: t0,
    now: t0 + 60_000,
  }) === false,
  "no workflow when done",
);
assert(
  shouldStartFollowThrough({
    status: "running",
    startedAt: t0,
    now: t0 + POLL_GIVE_UP_MS + 1,
  }) === false,
  "no workflow after give-up",
);

assert(sameBrowserRun("r1", "r1") === true, "same run");
assert(sameBrowserRun("r1", "r2") === false, "other run is stale");
assert(sameBrowserRun(undefined, "r1") === false, "missing run is stale");
assert(
  wakeupIdempotencyKey("r1", "done") === "browser_poll:r1:done",
  "idempotency done",
);
assert(
  wakeupIdempotencyKey("r1", "giveup") === "browser_poll:r1:giveup",
  "idempotency giveup",
);
assert(
  decideExistingWorkflow({
    statusOk: true,
    statusType: "inProgress",
    workflowRunId: "r1",
    runId: "r1",
  }) === "reuse",
  "reuse same run workflow",
);
assert(
  decideExistingWorkflow({
    statusOk: true,
    statusType: "inProgress",
    workflowRunId: "old",
    runId: "r1",
  }) === "cancel_then_start",
  "cancel leftover workflow for new run",
);
assert(
  decideExistingWorkflow({ statusOk: false, runId: "r1" }) === "retry_later",
  "status error → do not start a twin",
);
assert(
  decideExistingWorkflow({
    statusOk: true,
    statusType: "completed",
    workflowRunId: "r1",
    runId: "r1",
  }) === "start",
  "completed workflow can start again",
);

assert(
  browserWakeupClaimKey("r1", "done") === "r1:done",
  "claim key run:phase",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    existingClaim: undefined,
    claimKey: "r1:done",
  }) === "ok",
  "first claim writes",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    existingClaim: "r1:done",
    claimKey: "r1:done",
  }) === "duplicate",
  "same claim is duplicate",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r2",
    runId: "r1",
    existingClaim: undefined,
    claimKey: "r1:done",
  }) === "stale_run",
  "claim other run refused",
);
assert(followStartRetry({ error: "retry_later" }) === true, "retry_later is retry");
assert(followStartRetry({ error: "stale_run" }) === false, "stale is not retry_later");
assert(FOLLOW_RETRY_HINT.includes("не подцепилась"), "retry hint");

console.log("browser-policy-check ok");
