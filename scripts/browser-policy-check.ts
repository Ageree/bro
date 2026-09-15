import {
  BROWSER_WAIT_MS,
  isActiveStatus,
  looksLikeNewJob,
  nextBrowserAction,
  nextFollowDecision,
  normalizeTask,
  sharesKeyword,
  shouldStartFollowThrough,
} from "../agent/lib/browser-policy.ts";
import {
  browserWakeupClaimKey,
  decideExistingWorkflow,
  decideWakeupClaim,
  DONE,
  FOLLOW_RETRY_HINT,
  followSchedule,
  followStartRetry,
  maxPollRounds,
  FOLLOW_STEADY_SLEEP_MS,
  followSleepMs,
  persistableStatus,
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  sameBrowserRun,
  STALLED_STATUS,
  UNKNOWN_STATUS,
  WAKEUP_CLAIM_LEASE_MS,
  wakeupCarriesRunId,
  wakeupIdempotencyKey,
  wakeupRetryWaitBeforeLastMs,
} from "../convex/lib/browserFollowPolicy.ts";
import {
  applyProxyCountry,
  DEFAULT_BROWSER_MODEL,
  envSyncedProfileId,
  hashedProfileName,
  isDryRunErrand,
  proxyCountryCode,
  resolveBrowserModel,
  scaffoldTask,
} from "../agent/lib/browseruse.ts";

import { assert, src, withEnv } from "./lib/check.ts";

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

// --- busy: a second, unrelated errand must not be silently dropped (F1) ---
const priorRunning = {
  runId: "r1",
  status: "running",
  storedTask: "вызови такси домой",
} as const;
assert(
  nextBrowserAction({
    ...priorRunning,
    incomingTask: "купи кроссовки на вб 42 размер",
  }) === "busy",
  "unrelated errand while running is busy, not dropped",
);
assert(
  nextBrowserAction({ ...priorRunning, incomingTask: "ну что" }) === "poll",
  "short ping while running still polls",
);
assert(
  nextBrowserAction({
    ...priorRunning,
    incomingTask: "вызови такси домой",
  }) === "poll",
  "same task while running polls, not busy",
);

// A ping that merely mentions the running errand's own keyword must still
// poll, not busy — sharing a significant word with storedTask means "same
// errand", even though the NEW_JOB regex also matches that word.
assert(
  nextBrowserAction({ ...priorRunning, incomingTask: "ну что там с такси?" }) === "poll",
  "ping about the same errand (такси) polls, not busy",
);
assert(
  nextBrowserAction({ ...priorRunning, incomingTask: "такси уже едет?" }) === "poll",
  "another same-errand ping polls, not busy",
);
assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "купи кроссовки на вб 42 размер",
    incomingTask: "нашёл кроссовки?",
  }) === "poll",
  "ping about a different running errand (кроссовки) polls, not busy",
);
assert(
  nextBrowserAction({ ...priorRunning, incomingTask: "купи молоко" }) === "busy",
  "an actually unrelated errand (milk) while taxi runs is still busy",
);
assert(
  nextBrowserAction({
    runId: "r1",
    status: "queued",
    storedTask: "вызови такси домой",
    incomingTask: "запиши меня к стоматологу на чистку",
  }) === "busy",
  "queued counts as active for busy too",
);

// --- stalled (our give-up sentinel) is terminal → a new errand starts ---
assert(
  nextBrowserAction({
    runId: "r1",
    status: STALLED_STATUS,
    storedTask: "вызови такси домой",
    incomingTask: "купи кроссовки на вб",
  }) === "start",
  "stalled run is treated as done, new errand starts",
);
assert(
  nextBrowserAction({
    runId: "r1",
    status: STALLED_STATUS,
    storedTask: "вызови такси домой",
    incomingTask: "ну что",
  }) === "reuse",
  "stalled run + ack-like ping reuses like any other done run",
);

// --- looksLikeNewJob: a 48+ char follow-up sharing a word with the stored
// task is a continuation, not a fresh (separately-billed) errand (F9). The
// follow-up text below deliberately avoids every NEW_JOB keyword so only the
// length + shared-keyword fallback is exercised.
const longFollowUp =
  "уточни пожалуйста во сколько примерно мастер придёт чинить трубы сегодня";
const plumberStored = "вызови мастера почистить трубы в ванной";
assert(longFollowUp.length >= 48, "follow-up fixture is long enough to test");
assert(
  looksLikeNewJob(longFollowUp, plumberStored) === false,
  "long follow-up sharing a keyword with the stored task is not new",
);
assert(
  looksLikeNewJob(longFollowUp) === true,
  "same long text with no stored task falls back to the length heuristic",
);
assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: plumberStored,
    incomingTask: longFollowUp,
  }) === "reuse",
  "long same-topic follow-up after done reuses, does not start a new paid run",
);

const raw = "забронируй столик в Сыроварне на пятницу 19:00";
const wrapped = scaffoldTask(raw);
assert(wrapped.startsWith("[bro-errand]"), "scaffold starts with marker");
assert(wrapped.includes(raw), "scaffold contains raw task");
assert(scaffoldTask(wrapped) === wrapped, "scaffold is idempotent");
assert(scaffoldTask("x").includes("Работай быстро"), "scaffold skip-slow");
const synced = scaffoldTask("x", { profileSynced: true });
assert(synced.includes("уже могут быть куки прошлой сессии"), "synced scaffold mentions cookies");
assert(synced.includes("Куки не значат"), "cookies are not proof of login");
assert(synced.includes("«Войти»"), "synced scaffold still clicks Войти");
assert(!synced.includes("Ты уже в аккаунтах"), "no already-logged-in lie");
assert(!synced.includes("Не открывай паспорт"), "must not forbid passport");
assert(
  !synced.includes("просит логин — остановись"),
  "must not stop at a login wall",
);
assert(
  scaffoldTask("x").includes("войди сам"),
  "unsynced scaffold still logs in",
);
assert(
  scaffoldTask("x").includes("Если в задаче есть логин или пароль"),
  "unsynced scaffold types a supplied password",
);
assert(
  scaffoldTask("x", { profileSynced: true }).includes(
    "Если в задаче есть логин или пароль",
  ),
  "synced scaffold still types a supplied password",
);
const taxiOpen = scaffoldTask("вызови такси", {
  startPage: "https://taxi.yandex.ru/",
});
assert(
  taxiOpen.includes("Страница уже открыта: https://taxi.yandex.ru/"),
  "scaffold says the site is already open",
);
assert(taxiOpen.includes("паспорт"), "open taxi may go to passport");
assert(taxiOpen.includes("нажми «Заказать»"), "real taxi finishes the order");
assert(!taxiOpen.includes("Не нажимай «Заказать»"), "real taxi is not a dry-run");
assert(isDryRunErrand("покажи форму, не нажимай Заказать") === true, "dry-run flag");
assert(isDryRunErrand("вызови такси домой") === false, "real taxi is not dry-run");
assert(
  scaffoldTask("покажи форму, не нажимай Заказать").includes(
    "Не нажимай «Заказать»",
  ),
  "explicit dry-run forbids Заказать",
);

const t0 = Date.parse("2026-08-27T12:00:00.000Z");

// pollTimedOut/POLL_GIVE_UP_MS (30min) were dead — nothing but their own test
// consumed them, and the real give-up threshold below (20min) always won.
assert(!src("agent/lib/browser-policy.ts").includes("pollTimedOut"), "dead 30min timeout is gone");
assert(!src("agent/lib/browser-policy.ts").includes("POLL_GIVE_UP_MS"), "dead constant is gone");

assert(POLL_INTERVAL_MS === 2 * 60_000, "legacy 2min constant kept for old callers");
assert(
  JSON.stringify(followSchedule()) ===
    JSON.stringify([10_000, 15_000, 20_000, 30_000, 45_000, 60_000]),
  "ramp schedule is 10/15/20/30/45/60s",
);
assert(followSleepMs(0) === 10_000, "poll 0 sleeps 10s");
assert(followSleepMs(1) === 15_000, "poll 1 sleeps 15s");
assert(followSleepMs(2) === 20_000, "poll 2 sleeps 20s");
assert(followSleepMs(3) === 30_000, "poll 3 sleeps 30s");
assert(followSleepMs(4) === 45_000, "poll 4 sleeps 45s");
assert(followSleepMs(5) === 60_000, "poll 5 sleeps 60s");
assert(followSleepMs(6) === FOLLOW_STEADY_SLEEP_MS, "poll 6+ steadies at 90s");
assert(followSleepMs(50) === FOLLOW_STEADY_SLEEP_MS, "steady cadence holds far out");
assert(POLL_GIVE_UP_MS === 20 * 60_000, "give-up 20min");
{
  // The loop's cap (maxPollRounds()+2 in followThrough) must not fire before
  // real elapsed time reaches POLL_GIVE_UP_MS under the new ramp — otherwise
  // give-up would trigger early, before the 20 minutes it's supposed to mean.
  const rounds = maxPollRounds();
  let cumulative = 0;
  for (let i = 0; i < rounds; i++) cumulative += followSleepMs(i);
  assert(cumulative >= POLL_GIVE_UP_MS, "maxPollRounds covers a full 20min under the new cadence");
  assert(rounds === 18, "18 rounds under the ramp+steady schedule");
}
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

{
  const prev = process.env.BROWSERUSE_PROXY_COUNTRY;
  delete process.env.BROWSERUSE_PROXY_COUNTRY;
  assert(proxyCountryCode(undefined) === undefined, "proxy unset");
  if (prev === undefined) delete process.env.BROWSERUSE_PROXY_COUNTRY;
  else process.env.BROWSERUSE_PROXY_COUNTRY = prev;
}
assert(proxyCountryCode("") === undefined, "proxy empty");
assert(proxyCountryCode("  ") === undefined, "proxy blank");
assert(proxyCountryCode("ru") === "ru", "proxy ru");
assert(proxyCountryCode("RU") === "ru", "proxy RU");
assert(proxyCountryCode(" rus") === undefined, "proxy not alpha-2");
assert(
  !("browserSettings" in applyProxyCountry({ task: "x" }, "")),
  "no proxy field when unset",
);
assert(
  JSON.stringify(applyProxyCountry({ task: "x" }, "ru").browserSettings) ===
    JSON.stringify({ proxyCountryCode: "ru" }),
  "proxyCountryCode in browserSettings",
);

assert(DEFAULT_BROWSER_MODEL === "gpt-5.6-luna", "cloud default is GPT-5.6 Luna");
assert(resolveBrowserModel(undefined) === DEFAULT_BROWSER_MODEL, "unset model uses default");
assert(resolveBrowserModel("") === DEFAULT_BROWSER_MODEL, "empty model uses default");
assert(resolveBrowserModel("  ") === DEFAULT_BROWSER_MODEL, "blank model uses default");
assert(resolveBrowserModel(" grok-4.5 ") === "grok-4.5", "BRO_BROWSER_MODEL override");

assert(BROWSER_WAIT_MS === 2_000, "wait is short; follow-through still delivers");

const browserTool = src("agent/tools/browser_task.ts");
assert(browserTool.includes("BROWSER_WAIT_MS"), "start and poll use shared wait");
assert(browserTool.includes("waitForPageLanding"), "errand opens the site over cdp");
assert(browserTool.includes("errandStartUrl"), "errand picks taxi/shop url");
assert(!browserTool.includes("WAIT_MS = 12_000"), "old 12s park is gone");
const startPath = browserTool.slice(browserTool.indexOf("const started = await startRun"));
assert(
  startPath.indexOf("startBrowserFollow") < startPath.indexOf("waitForRun"),
  "follow-through starts before the in-turn wait",
);
assert(browserTool.includes("deliverHumanRouted"), "canned notify uses auth routing");
assert(
  browserTool.includes("turnSpoke"),
  "canned ищу skips only when this turn already spoke",
);
assert(browserTool.includes("maybeInjectChat"), "relevant chat is injected into the live run");
assert(
  src("agent/lib/browseruse.ts").includes("INJECT_MARK"),
  "follow-up inject is not re-wrapped as a new errand",
);

const follow = src("convex/browserFollow.ts");
const handler = follow.slice(follow.indexOf("}).handler"));
const firstPoll = handler.search(/pollRun/);
const firstSleep = handler.search(/step\.sleep/);
assert(firstPoll >= 0, "follow-through polls");
assert(firstSleep >= 0, "follow-through still sleeps between polls");
assert(firstPoll < firstSleep, "first poll comes before the first sleep");
assert(handler.includes("followSleepMs"), "first re-sleep is shorter than 2min");

const waitFor = src("agent/lib/browseruse.ts");
const startFn = waitFor.slice(
  waitFor.indexOf("export async function startRun"),
  waitFor.indexOf("async function runEvents"),
);
assert(startFn.includes("body.model = resolveBrowserModel()"), "every cloud run sends a model");
assert(!startFn.includes("if (process.env.BRO_BROWSER_MODEL)"), "model is no longer env-gated");
// v4 POST /runs rejects unknown keys outright (422 extra_forbidden) —
// `session_id` is not a real field, only `sessionId` is; sending both used
// to fail every session-reusing call (verified live against Browser Use).
// This checks the REQUEST body specifically — startRun's own response
// parsing (`pick(created, ["sessionId", "session_id"])`) legitimately reads
// `session_id` back as a defensive fallback key and must stay untouched.
assert(startFn.includes("body.sessionId = sessionId"), "startRun sends the camelCase sessionId");
assert(!startFn.includes("body.session_id"), "startRun never sends the rejected snake_case session_id");
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
assert(
  hydrateFn.indexOf(".catch(") < hydrateFn.indexOf("if (!run)"),
  "hydrate's primary /runs fetch is guarded before anything reads run",
);
assert(hydrateFn.includes('status: "unknown"'), "a failed run fetch degrades, never throws");
assert(hydrateFn.includes("scrubSecrets(rawResult)"), "hydrate scrubs the result before it is stored/returned");
assert(
  src("convex/lib/browseruse.ts").includes("scrubSecrets(rawResult)"),
  "convex-side hydrate scrubs the result too",
);

// --- status enum: documented six + our own `stalled` sentinel (A6) ---
assert(
  JSON.stringify([...DONE].sort()) ===
    JSON.stringify(["cancelled", "completed", "failed", "stalled"].sort()),
  "DONE is the documented terminal states plus stalled",
);
assert(STALLED_STATUS === "stalled", "stalled sentinel name");
assert(isActiveStatus("dispatching") === true, "dispatching is active (was missing before)");
assert(isActiveStatus("queued") === true, "queued is active");
assert(isActiveStatus("running") === true, "running is active");
assert(isActiveStatus("stalled") === false, "stalled is not active");
assert(waitFor.includes("DONE.has(status.trim().toLowerCase())"), "isTerminal reuses the documented DONE set");
assert(
  !waitFor.slice(waitFor.indexOf("export function isTerminal")).includes('"stopped"'),
  "isTerminal no longer treats undocumented statuses as terminal",
);

// --- session/run lifecycle: cancel + stop exist and are wired in (F1/F2/A6) ---
assert(waitFor.includes("export async function cancelRun"), "agent cancelRun exists");
assert(waitFor.includes("export async function stopBrowserForSession"), "agent stopBrowserForSession exists");
assert(waitFor.includes("/runs/${runId}/cancel"), "cancelRun hits POST /runs/{id}/cancel");
assert(waitFor.includes('action: "stop"'), "stopBrowserForSession hits PATCH /browsers/{id} action:stop");
const convexBu = src("convex/lib/browseruse.ts");
assert(convexBu.includes("export async function cancelRun"), "convex cancelRun exists");
assert(convexBu.includes("export async function stopBrowserForSession"), "convex stopBrowserForSession exists");

assert(browserTool.includes("cancelRun(tenant.browserRunId)"), "start branch cancels an active previous run");
assert(browserTool.includes("stopBrowserForSession(tenant.browserSessionId)"), "start branch stops the old browser session");
assert(
  browserTool.includes("await startRun(task, undefined,"),
  "a fresh errand never hands the old session id to startRun",
);
const cancelIdx = browserTool.indexOf("cancelRun(tenant.browserRunId)");
const startRunIdx = browserTool.indexOf("const started = await startRun(task, undefined,");
assert(cancelIdx > 0 && startRunIdx > cancelIdx, "old run is cancelled before the new one starts");
assert(
  browserTool.includes('action === "busy"'),
  "a second, unrelated errand while one is active gets a busy outcome, not silence (F1)",
);
assert(
  browserTool.includes("looksLikePasswordDump(task)"),
  "a password-shaped task is rejected before it ever reaches the cloud (item 12)",
);

// --- follow-through give-up stops the run + marks the tenant stalled (F2) ---
assert(follow.includes("cancelRunAction"), "followThrough calls the new cancel/stop action");
assert(follow.includes("STALLED_STATUS"), "give-up patches the tenant to stalled");
assert(
  follow.indexOf("stopGivenUpRun") < follow.indexOf("internal.browserFollow.wakeupAgent"),
  "the run is stopped before the human is told give-up happened",
);

// --- startFollowThrough: a cancel failure must still start the new run (F5) ---
const startFollow = follow.slice(
  follow.indexOf("export const startFollowThrough"),
  follow.indexOf("export const cancelFollowThrough"),
);
const cancelBlock = startFollow.slice(
  startFollow.indexOf('if (next === "cancel_then_start")'),
  startFollow.indexOf("const workflowId = await workflow.start"),
);
assert(
  !cancelBlock.includes("retry_later"),
  "cancel failure no longer bails out before workflow.start",
);
assert(
  cancelBlock.includes("browser follow cancel failed"),
  "cancel failure is still logged",
);
assert(
  startFollow.indexOf("workflow.cancel(ctx, id)") < startFollow.indexOf("await workflow.start"),
  "cancel is attempted, then the new workflow always starts",
);

// --- profile identity: hashed name/id, env only for the one named phone ---
const hashed1 = hashedProfileName("+79991234567");
const hashed2 = hashedProfileName("+79991234567");
const hashedOther = hashedProfileName("+79997654321");
assert(hashed1 === hashed2, "hashedProfileName is deterministic");
assert(hashed1 !== hashedOther, "hashedProfileName differs per phone");
assert(hashed1.startsWith("bro-"), "hashed profile name has the bro- prefix");
assert(!hashed1.includes("79991234567"), "hashed profile name never carries the raw phone");
assert(/^bro-[0-9a-f]{40}$/.test(hashed1), "hashed profile name is bro- + 40 hex chars");

withEnv(
  { BROWSER_USE_PROFILE_ID: "shared-id", BROWSER_USE_PROFILE_PHONE: "+79991234567" },
  () => {
    assert(
      envSyncedProfileId("+79991234567") === undefined,
      "a non-uuid BROWSER_USE_PROFILE_ID is rejected even for the matching phone",
    );
  },
);
withEnv(
  {
    BROWSER_USE_PROFILE_ID: "550e8400-e29b-41d4-a716-446655440000",
    BROWSER_USE_PROFILE_PHONE: "+79991234567",
  },
  () => {
    assert(
      envSyncedProfileId("+79991234567") === "550e8400-e29b-41d4-a716-446655440000",
      "env profile applies to the one tenant it is bound to",
    );
    assert(
      envSyncedProfileId("+79997654321") === undefined,
      "env profile does not leak to a different tenant",
    );
  },
);
withEnv(
  { BROWSER_USE_PROFILE_ID: "550e8400-e29b-41d4-a716-446655440000", BROWSER_USE_PROFILE_PHONE: undefined },
  () => {
    assert(
      envSyncedProfileId("+79991234567") === undefined,
      "no owner phone configured → no tenant gets the shared profile",
    );
  },
);

assert(
  waitFor.includes("hashedProfileName(phone)"),
  "createProfile sends the hashed name, not the raw phone",
);
assert(
  browserTool.includes("envSyncedProfileId(phone)"),
  "browser_task resolves the synced profile for this tenant's phone",
);
assert(
  src("agent/tools/profile_setup.ts").includes("envSyncedProfileId(phone)"),
  "profile_setup resolves the synced profile for this tenant's phone",
);

// --- sharesKeyword: the primitive the busy-vs-poll fix relies on ---
assert(sharesKeyword("такси уже едет?", "вызови такси домой") === true, "такси overlaps");
assert(sharesKeyword("купи молоко", "вызови такси домой") === false, "milk shares nothing with taxi");
assert(sharesKeyword("ну что", "вызови такси домой") === false, "too-short words never count");

// --- persistableStatus: "unknown" (hydrate's guarded-failure placeholder)
// must never be persisted over a known status (coordinator review fix #2) ---
assert(persistableStatus("running") === "running", "a real status passes through");
assert(persistableStatus("completed") === "completed", "a terminal status passes through");
assert(persistableStatus("unknown") === undefined, "unknown is not persistable");
assert(persistableStatus("Unknown") === undefined, "unknown is case-insensitive");
assert(persistableStatus(` ${UNKNOWN_STATUS} `) === undefined, "unknown is trimmed");

const persistFn = browserTool.slice(
  browserTool.indexOf("async function persist("),
  browserTool.indexOf("function payload("),
);
assert(persistFn.includes("persistableStatus(run.status)"), "persist() checks persistableStatus before writing");
assert(
  persistFn.indexOf("const status = persistableStatus") <
    persistFn.indexOf("browserStatus: status"),
  "persist() only writes browserStatus/browserLiveUrl when the status is known",
);

const pollRunFn = follow.slice(
  follow.indexOf("export const pollRun"),
  follow.indexOf("export const wakeupAgent"),
);
assert(pollRunFn.includes("persistableStatus(run.status)"), "pollRun checks persistableStatus before writing");
assert(
  pollRunFn.indexOf("if (status === undefined)") <
    pollRunFn.indexOf("patchBrowserInternal"),
  "pollRun skips the tenant write and returns early on an unknown status",
);
assert(
  pollRunFn.includes("tenant.browserStatus ?? UNKNOWN_STATUS"),
  "pollRun falls back to the tenant's last-known status, not unknown",
);

// ---------------------------------------------------------------------------
// nextBrowserAction "continue": a completed run parked on a human-resolvable
// need must resume in the SAME Cloud session, not reuse the stale blocked
// result nor spawn a fresh one — the taxi incident this fixes (goal.md).
// "continue" requires ALL FOUR: terminal status, a human-resolvable need, a
// sessionId to resume into, and the incoming task continuing the same
// errand (not a fresh, unrelated job).
// ---------------------------------------------------------------------------

const paymentNeedDone = {
  runId: "r1",
  status: "completed",
  storedTask: "вызови такси домой",
  sessionId: "sess-1",
  need: "payment",
} as const;

assert(
  nextBrowserAction({
    ...paymentNeedDone,
    incomingTask:
      "Продолжи в текущей сессии Яндекс Такси: в способе оплаты выбери карту из сейфа",
  }) === "continue",
  "all four conditions hold: payment need + sessionId + same errand + done → continue",
);

// 1. terminal status only — an active run still just polls/busies, `need`
// and `sessionId` never override that.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    status: "running",
    incomingTask: "Продолжи такси, оплати картой из сейфа",
  }) === "poll",
  "an active (non-terminal) run never continues, whatever the need",
);

// 2. need must be human-resolvable — "none" (or absent) never continues,
// even with a sessionId and a same-errand follow-up; it reuses like any
// other clean completion.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    need: "none",
    incomingTask: "ну что",
  }) === "reuse",
  "need:none never continues — falls back to the ordinary reuse/start logic",
);
assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "вызови такси домой",
    sessionId: "sess-1",
    incomingTask: "ну что",
  }) === "reuse",
  "no need at all never continues either",
);

// 3. sessionId must exist — without one there is nothing to resume into, so
// a same-errand, need-pending follow-up starts fresh instead of reusing a
// result that never actually finished.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    sessionId: undefined,
    incomingTask: "Продолжи такси, оплати картой из сейфа",
  }) === "start",
  "no sessionId → start, never continue and never a stale reuse",
);

// 4. the incoming task must continue the SAME errand — a genuinely new,
// unrelated errand still starts fresh even while a need is parked.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    incomingTask: "купи кроссовки на вб 42 размер",
  }) === "start",
  "a genuinely new errand while a need is parked still starts fresh, not continue",
);

// reset:true always wins, even over a pending human-resolvable need.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    reset: true,
    incomingTask: "Продолжи такси, оплати картой из сейфа",
  }) === "start",
  "reset:true still starts fresh over a pending need",
);

// A short, non-keyword follow-up shares no NEW_JOB keyword but still reads
// as the same errand via the length/keyword fallback in looksLikeNewJob.
assert(
  nextBrowserAction({
    ...paymentNeedDone,
    incomingTask: "картой из сейфа",
  }) === "continue",
  "a short same-errand follow-up with no NEW_JOB keyword still continues",
);

console.log("browser-policy-check ok");
