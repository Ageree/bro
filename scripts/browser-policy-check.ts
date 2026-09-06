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
  WAKEUP_CLAIM_LEASE_MS,
  wakeupCarriesRunId,
  wakeupIdempotencyKey,
  wakeupRetryWaitBeforeLastMs,
} from "../convex/lib/browserFollowPolicy.ts";
import { LOGIN_MARK } from "../convex/lib/browserProfilePolicy.ts";
import {
  acceptsReasoningEffort,
  applyProxyCountry,
  browserModel,
  browserSettingsForRun,
  buildRunBody,
  customProxyFromEnv,
  DEFAULT_BROWSER_MODEL,
  DEFAULT_MAX_COST_USD,
  DEFAULT_REASONING_EFFORT,
  detectRunKind,
  maxCostUsd,
  modelParamsFor,
  proxyCountryCode,
  reasoningEffort,
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

assert(detectRunKind("скотч на ozon") === "errand", "kind errand");
assert(detectRunKind(`${LOGIN_MARK}\nжди`) === "login", "kind login");
assert(
  detectRunKind("оплати", { pay: { hosts: ["ozon.ru"] } }) === "pay",
  "kind pay",
);
assert(browserModel("") === DEFAULT_BROWSER_MODEL, "empty model → luna");
assert(browserModel(" grok-4.5 ") === "grok-4.5", "model override");
assert(maxCostUsd("errand", undefined) === DEFAULT_MAX_COST_USD.errand, "errand cap");
assert(maxCostUsd("login", undefined) === DEFAULT_MAX_COST_USD.login, "login cap");
assert(maxCostUsd("pay", undefined) === DEFAULT_MAX_COST_USD.pay, "pay cap");
assert(maxCostUsd("errand", "1") === 1, "env cap overrides kind");
assert(maxCostUsd("errand", "nope") === DEFAULT_MAX_COST_USD.errand, "bad cap");
assert(
  reasoningEffort("errand", undefined) === DEFAULT_REASONING_EFFORT.errand,
  "errand effort",
);
assert(
  reasoningEffort("login", undefined) === DEFAULT_REASONING_EFFORT.login,
  "login effort",
);
assert(reasoningEffort("errand", "none") === "none", "effort override");
assert(reasoningEffort("errand", "wat") === "low", "bad effort");
assert(acceptsReasoningEffort("gpt-5.6-luna") === true, "luna reasoning");
assert(acceptsReasoningEffort("minimax-m3") === false, "minimax no reasoning");
assert(
  JSON.stringify(modelParamsFor("gpt-5.6-luna", "low")) ===
    JSON.stringify({ reasoning: { effort: "low" } }),
  "luna modelParams",
);
assert(modelParamsFor("grok-4.5", "low") === undefined, "grok no modelParams");
assert(customProxyFromEnv({}) === undefined, "no custom proxy");
assert(
  customProxyFromEnv({ BRO_BROWSER_PROXY_HOST: "p.example", BRO_BROWSER_PROXY_PORT: "0" }) ===
    undefined,
  "port 0 rejected",
);
const byop = customProxyFromEnv({
  BRO_BROWSER_PROXY_HOST: " p.example ",
  BRO_BROWSER_PROXY_PORT: "8080",
  BRO_BROWSER_PROXY_USER: "u",
  BRO_BROWSER_PROXY_PASS: "s",
});
assert(byop?.host === "p.example" && byop.port === 8080, "custom proxy parsed");
assert(
  JSON.stringify(
    browserSettingsForRun({
      country: "ru",
      customProxy: byop,
      profileId: "550e8400-e29b-41d4-a716-446655440000",
    }),
  ) ===
    JSON.stringify({
      customProxy: {
        host: "p.example",
        port: 8080,
        username: "u",
        password: "s",
      },
      proxyCountryCode: null,
      profileId: "550e8400-e29b-41d4-a716-446655440000",
    }),
  "BYOP disables managed residential",
);

const errandBody = buildRunBody({
  task: "скотч на ozon",
  proxyCountry: "ru",
  model: DEFAULT_BROWSER_MODEL,
  maxCostUsd: DEFAULT_MAX_COST_USD.errand,
  reasoningEffort: "low",
});
assert(errandBody.model === "gpt-5.6-luna", "errand pins luna");
assert(errandBody.maxCostUsd === 0.45, "errand cap on body");
assert(
  JSON.stringify(errandBody.modelParams) ===
    JSON.stringify({ reasoning: { effort: "low" } }),
  "errand not xhigh",
);
assert(
  JSON.stringify(errandBody.browserSettings) ===
    JSON.stringify({ proxyCountryCode: "ru" }),
  "errand keeps ru proxy",
);

const loginBody = buildRunBody({
  task: `${LOGIN_MARK}\nоткрой https://ozon.ru`,
  model: DEFAULT_BROWSER_MODEL,
  maxCostUsd: DEFAULT_MAX_COST_USD.login,
  reasoningEffort: DEFAULT_REASONING_EFFORT.login,
});
assert(loginBody.maxCostUsd === 0.15, "login cheaper cap");
assert(
  JSON.stringify(loginBody.modelParams) ===
    JSON.stringify({ reasoning: { effort: "none" } }),
  "login no reasoning",
);

const payBody = buildRunBody({
  task: "оплати",
  pay: { hosts: ["ozon.ru"], holder: "A", account: "Visa" },
  model: DEFAULT_BROWSER_MODEL,
  maxCostUsd: DEFAULT_MAX_COST_USD.pay,
  reasoningEffort: DEFAULT_REASONING_EFFORT.pay,
});
assert(payBody.maxCostUsd === 0.8, "pay higher cap");
assert(
  JSON.stringify(payBody.modelParams) ===
    JSON.stringify({ reasoning: { effort: "low" } }),
  "pay still low, not xhigh",
);

const grokBody = buildRunBody({
  task: "x",
  model: "grok-4.5",
  maxCostUsd: 0.45,
});
assert(grokBody.modelParams === undefined, "non-luna omits modelParams");

console.log("browser-policy-check ok");
