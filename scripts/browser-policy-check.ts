import { readFileSync } from "node:fs";
import {
  BROWSER_WAIT_MS,
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
  FOLLOW_FIRST_SLEEP_MS,
  followSleepMs,
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  sameBrowserRun,
  WAKEUP_CLAIM_LEASE_MS,
  wakeupCarriesRunId,
  wakeupIdempotencyKey,
  wakeupRetryWaitBeforeLastMs,
} from "../convex/lib/browserFollowPolicy.ts";
import {
  applyProxyCountry,
  proxyCountryCode,
  scaffoldTask,
} from "../agent/lib/browseruse.ts";

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

const priorDone = {
  runId: "r1",
  status: "completed",
  storedTask: "обувь на ozon",
} as const;
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "забронируй столик в ресторане Сыроварня на пятницу 19:00",
  }) === "start",
  "booking after done starts",
);
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "запиши меня к стоматологу на чистку",
  }) === "start",
  "appointment after done starts",
);
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "закажи такси на завтра в 9 утра",
  }) === "start",
  "taxi after done starts",
);
assert(
  nextBrowserAction({ ...priorDone, incomingTask: "ну что" }) === "reuse",
  "short ping after done reuses",
);
assert(
  nextBrowserAction({ ...priorDone, incomingTask: "как там" }) === "reuse",
  "status ping after done reuses",
);

const raw = "забронируй столик в Сыроварне на пятницу 19:00";
const wrapped = scaffoldTask(raw);
assert(wrapped.startsWith("[bro-errand]"), "scaffold starts with marker");
assert(wrapped.includes(raw), "scaffold contains raw task");
assert(scaffoldTask(wrapped) === wrapped, "scaffold is idempotent");
assert(scaffoldTask("x").includes("Работай быстро"), "scaffold skip-slow");
assert(
  scaffoldTask("x", { profileSynced: true }).includes("Cloud-профиле"),
  "synced scaffold uses saved profile",
);
assert(
  scaffoldTask("x").includes("пришлёт человеку ссылку"),
  "unsynced scaffold asks for a login link",
);

const t0 = Date.parse("2026-08-27T12:00:00.000Z");
assert(pollTimedOut(t0, t0 + 10 * 60_000) === false, "poll not expired");
assert(pollTimedOut(t0, t0 + 30 * 60_000) === false, "poll exactly 30min");
assert(pollTimedOut(t0, t0 + 30 * 60_000 + 1) === true, "poll expired");
assert(pollTimedOut(undefined, t0) === false, "poll missing start");

assert(POLL_INTERVAL_MS === 2 * 60_000, "sleep 2min");
assert(FOLLOW_FIRST_SLEEP_MS === 20_000, "first re-sleep is 20s");
assert(followSleepMs(0) === FOLLOW_FIRST_SLEEP_MS, "poll 0 uses first sleep");
assert(followSleepMs(1) === POLL_INTERVAL_MS, "later polls use 2min");
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
  browserWakeupClaimKey("r1", "done", t0, "pending") === `r1:done:${t0}:pending`,
  "claim key run:phase:ts:pending",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    phase: "done",
    existingClaim: undefined,
    now: t0,
  }) === "ok",
  "first claim writes pending",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    phase: "done",
    existingClaim: `r1:done:${t0}:pending`,
    now: t0 + 30_000,
  }) === "pending_in_flight",
  "fresh pending must throw, not succeed",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    phase: "done",
    existingClaim: `r1:done:${t0}:pending`,
    now: t0 + WAKEUP_CLAIM_LEASE_MS,
  }) === "ok",
  "expired pending can be reclaimed",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    phase: "done",
    existingClaim: `r1:done:${t0}:sent`,
    now: t0 + 1_000,
  }) === "duplicate",
  "sent is a real duplicate",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r1",
    runId: "r1",
    phase: "done",
    existingClaim: "r1:done",
    now: t0,
  }) === "ok",
  "legacy claim without status is reclaimable",
);
assert(
  wakeupRetryWaitBeforeLastMs() >= WAKEUP_CLAIM_LEASE_MS,
  "worst-case retry wait covers the lease",
);
assert(
  decideWakeupClaim({
    tenantRunId: "r2",
    runId: "r1",
    phase: "done",
    existingClaim: undefined,
    now: t0,
  }) === "stale_run",
  "claim other run refused",
);
assert(wakeupCarriesRunId("r1") === true, "explicit runId is checked");
assert(wakeupCarriesRunId("") === false, "empty runId is legacy");
assert(wakeupCarriesRunId(undefined) === false, "missing runId is legacy");
assert(followStartRetry({ error: "retry_later" }) === true, "retry_later is retry");
assert(followStartRetry({ error: "stale_run" }) === false, "stale is not retry_later");
assert(FOLLOW_RETRY_HINT.includes("не подцепилась"), "retry hint");

assert(proxyCountryCode(undefined) === undefined, "proxy unset");
assert(proxyCountryCode("") === undefined, "proxy empty");
assert(proxyCountryCode("  ") === undefined, "proxy blank");
assert(proxyCountryCode("ru") === "ru", "proxy ru");
assert(proxyCountryCode("RU") === "ru", "proxy RU");
assert(proxyCountryCode(" rus") === undefined, "proxy not alpha-2");
assert(
  !("browserSettings" in applyProxyCountry({ task: "x" }, undefined)),
  "no proxy field when unset",
);
assert(
  JSON.stringify(applyProxyCountry({ task: "x" }, "ru").browserSettings) ===
    JSON.stringify({ proxyCountryCode: "ru" }),
  "proxyCountryCode in browserSettings",
);

assert(BROWSER_WAIT_MS === 2_000, "wait is short; follow-through still delivers");

const browserTool = readFileSync(
  new URL("../agent/tools/browser_task.ts", import.meta.url),
  "utf8",
);
assert(browserTool.includes("BROWSER_WAIT_MS"), "start and poll use shared wait");
assert(!browserTool.includes("WAIT_MS = 12_000"), "old 12s park is gone");
const startPath = browserTool.slice(browserTool.indexOf("const started = await startRun"));
assert(
  startPath.indexOf("startBrowserFollow") < startPath.indexOf("waitForRun"),
  "follow-through starts before the in-turn wait",
);
assert(browserTool.includes("deliverHumanRouted"), "canned notify uses auth routing");
assert(
  browserTool.includes("turnLooking"),
  "canned ищу skips only when this turn already said ищу",
);

const follow = readFileSync(
  new URL("../convex/browserFollow.ts", import.meta.url),
  "utf8",
);
const handler = follow.slice(follow.indexOf("}).handler"));
const firstPoll = handler.search(/pollRun/);
const firstSleep = handler.search(/step\.sleep/);
assert(firstPoll >= 0, "follow-through polls");
assert(firstSleep >= 0, "follow-through still sleeps between polls");
assert(firstPoll < firstSleep, "first poll comes before the first sleep");
assert(handler.includes("followSleepMs"), "first re-sleep is shorter than 2min");

const waitFor = readFileSync(
  new URL("../agent/lib/browseruse.ts", import.meta.url),
  "utf8",
);
const waitFn = waitFor.slice(waitFor.indexOf("export async function waitForRun"));
assert(
  waitFn.indexOf("bu(`/runs/${runId}/status`)") < waitFn.indexOf("return hydrate"),
  "waitForRun status-polls before hydrating",
);
assert(waitFn.includes("Math.min(2000, remaining)"), "waitForRun does not oversleep the budget");
const hydrateFn = waitFor.slice(waitFor.indexOf("export async function hydrate"));
assert(
  hydrateFn.includes("isTerminal(status)") && hydrateFn.includes("/sessions/"),
  "hydrate skips session GET while the run is live and already has a URL",
);

console.log("browser-policy-check ok");
