/**
 * browser_task / profile_setup wiring (A3): pure-helper behavior plus
 * source-level assertions for the wiring that can't be exercised without a
 * live Browser Use Cloud / Convex deployment (billing gate, queue/clear
 * calls, notify gating). Behavioral coverage for the lower-level pieces
 * (queueMessage, cancelRun, hydrate scrubbing, …) already lives in
 * browser-queue-check.ts / browser-glue-check.ts.
 */
import {
  chargeKeyFor,
  isAckLike,
  loginPagesFor,
  profileExtra,
  shortTask,
  taskLooksLikeBuy,
} from "../agent/lib/browser-task-policy.ts";
import { errandStartUrl } from "../convex/lib/browserStartPolicy.ts";
import { expandPayHosts, isAttachCardErrand } from "../agent/lib/browser-pay.ts";
import { nextBrowserAction } from "../agent/lib/browser-policy.ts";
import { loginWaitTask, scaffoldTask } from "../agent/lib/browseruse.ts";
import {
  injectFollowTask,
  injectQueueText,
  type CloudInjectKind,
} from "../convex/lib/browserInjectPolicy.ts";
import { loginVaultTask } from "../convex/lib/browserProfilePolicy.ts";

import { assert, eq, src } from "./lib/check.ts";

// ---------------------------------------------------------------------------
// loginPagesFor — item 3/F6: startPage (from errandStartUrl) participates in
// the vault-login lookup even for a keyword-only errand with no URL/pay.
// ---------------------------------------------------------------------------

{
  const startPage = errandStartUrl("вызови такси домой");
  const pages = loginPagesFor("вызови такси домой", undefined, startPage);
  assert(
    pages.includes("https://taxi.yandex.ru/"),
    "keyword-only taxi errand includes the taxi login page",
  );
}
eq(
  JSON.stringify(loginPagesFor("купи кроссовки", ["wildberries.ru"], undefined)),
  JSON.stringify(["https://wildberries.ru/"]),
  "pay hosts still resolve to a login page with no startPage",
);
{
  const pages = loginPagesFor(
    "Открой https://www.ozon.ru/product/1, купи товар",
    ["wildberries.ru"],
    "https://taxi.yandex.ru/",
  );
  assert(pages.includes("https://wildberries.ru/"), "pay host present");
  assert(pages.includes("https://taxi.yandex.ru/"), "startPage present");
  assert(
    pages.some((p) => p.startsWith("https://www.ozon.ru")),
    "explicit task URL present",
  );
}

// ---------------------------------------------------------------------------
// shortTask — coordinator fix 1: the busy hint must never echo a stored
// [bro-login]/[bro-errand] scaffold whole into a human-facing line
// ---------------------------------------------------------------------------

eq(shortTask("вызови такси домой"), "вызови такси домой", "a plain task is unchanged");
eq(shortTask(undefined), "", "no task → empty string, not \"undefined\"");
{
  const scaffold = loginWaitTask("https://www.ozon.ru");
  const short = shortTask(scaffold);
  assert(!short.startsWith("[bro-"), "the [bro-…] mark is stripped");
  assert(!short.includes("\n"), "only the first line survives");
  assert(short.length <= 80, "capped length");
}
eq(
  shortTask("  строка   с   лишними    пробелами  "),
  "строка с лишними пробелами",
  "internal whitespace is collapsed",
);
{
  const long = "а".repeat(120);
  const short = shortTask(long);
  assert(short.length === 80 && short.endsWith("…"), "long text is truncated with an ellipsis");
}

// ---------------------------------------------------------------------------
// isAckLike — item 7
// ---------------------------------------------------------------------------

assert(isAckLike("готово"), "single word ack");
assert(isAckLike("спасибо бро"), "two word ack");
assert(isAckLike("ок, супер"), "short comma ack");
assert(!isAckLike("готово?"), "question mark is not an ack");
assert(
  !isAckLike("готово, но курьер написал что задержится на полчаса"),
  "long follow-up is not a bare ack",
);
assert(!isAckLike(""), "empty text is not an ack");

// ---------------------------------------------------------------------------
// chargeKeyFor — item 10: one charge per errand
// ---------------------------------------------------------------------------

const now = Date.parse("2026-09-15T12:00:00.000Z");

assert(
  typeof chargeKeyFor({}, { rawAction: "start" }, now) === "string" &&
    chargeKeyFor({}, { rawAction: "start" }, now).length > 0,
  "a brand new errand always gets a non-empty key",
);
assert(
  chargeKeyFor({ browserSessionId: "sess-1" }, { rawAction: "start" }, now) !== "sess-1",
  "a plain fresh start never reuses the old session id as its charge key",
);

eq(
  chargeKeyFor(
    { browserSessionId: "sess-pay" },
    { pay: true, rawAction: "reuse" },
    now,
  ),
  "sess-pay",
  "a pay-forced restart of a reuse-eligible run keys off the existing session",
);

const loginTask = loginWaitTask("https://taxi.yandex.ru");
eq(
  chargeKeyFor(
    { browserSessionId: "sess-login", browserTask: loginTask, browserStartedAt: now - 5 * 60_000 },
    { rawAction: "start" },
    now,
  ),
  "sess-login",
  "an errand starting soon after a login run continues that session's charge",
);
assert(
  chargeKeyFor(
    {
      browserSessionId: "sess-login",
      browserTask: loginTask,
      browserStartedAt: now - 31 * 60_000,
    },
    { rawAction: "start" },
    now,
  ) !== "sess-login",
  "a login more than 30 minutes old gets a fresh charge key",
);
assert(
  chargeKeyFor(
    { browserSessionId: "sess-x", browserTask: "вызови такси", browserStartedAt: now - 1000 },
    { rawAction: "start" },
    now,
  ) !== "sess-x",
  "a plain (non-login) stored task never counts as continuing",
);

// ---------------------------------------------------------------------------
// profileExtra — item 4: needsProfileSync suppressed by a bound vault login
// or by a last-result need other than password
// ---------------------------------------------------------------------------

{
  const notReady = { cookieDomains: [], synced: false };
  const plain = profileExtra(notReady, "https://www.ozon.ru/");
  assert(plain.needsProfileSync === true, "unsynced + no suppression → needsProfileSync");

  const withVault = profileExtra(notReady, "https://www.ozon.ru/", { vaultLogin: true });
  assert(
    (withVault as { needsProfileSync?: boolean }).needsProfileSync === undefined,
    "vault login bound to this run suppresses needsProfileSync",
  );

  const need3ds = profileExtra(notReady, "https://www.ozon.ru/", { need: "3ds" });
  assert(
    (need3ds as { needsProfileSync?: boolean }).needsProfileSync === undefined,
    "a last result needing something other than password suppresses needsProfileSync",
  );

  const needPassword = profileExtra(notReady, "https://www.ozon.ru/", { need: "password" });
  assert(
    needPassword.needsProfileSync === true,
    "a last result that itself needs a password does not suppress",
  );

  const synced = profileExtra({ cookieDomains: ["ozon.ru"], synced: true }, "https://www.ozon.ru/");
  assert(
    (synced as { needsProfileSync?: boolean }).needsProfileSync === undefined,
    "already synced never needs a sync hint",
  );
}

// ---------------------------------------------------------------------------
// taskLooksLikeBuy — thin wrapper over purchase-policy, sanity only
// ---------------------------------------------------------------------------

assert(taskLooksLikeBuy("купи кроссовки"), "buy task");
assert(!taskLooksLikeBuy("вызови такси"), "non-buy task");

// ---------------------------------------------------------------------------
// Source-level wiring assertions
// ---------------------------------------------------------------------------

const toolSrc = src("agent/tools/browser_task.ts");

assert(toolSrc.includes("markTurnSpoke"), "browser_task marks the turn as spoken after its own notify");
assert(toolSrc.includes("fastAckOf"), "browser_task defers its own notify to a fast-ack");
assert(toolSrc.includes("browserPaying"), "browser_task persists/reads browserPaying");
assert(toolSrc.includes("browserPayHosts"), "browser_task persists/reads browserPayHosts");
assert(toolSrc.includes("need: tenant.browserNeed"), "inject attrs carry the tenant's browserNeed");
assert(toolSrc.includes("browserProbed: true"), "inject attrs mark the browser as probed");
assert(toolSrc.includes("clearBrowserNeed(phone"), "a successful inject queue clears browserNeed*");
assert(
  toolSrc.includes('parseCloudOutcome(run.result).needs !== "none"'),
  "maybeRecordOrder never records an order while a blocker is still parked",
);
assert(
  toolSrc.includes("chargeKeyFor("),
  "the billing gate is keyed so a continued errand cannot double-charge",
);
assert(
  /countBrowserJobStart\(phone, \{ chargeKey \}\)/.test(toolSrc),
  "countBrowserJobStart is called with the computed chargeKey",
);
assert(
  toolSrc.includes("browserNextTask: task") && toolSrc.includes('activeTask: tenant.browserTask'),
  "busy queues the incoming task as browserNextTask and reports the active one",
);
assert(
  /normalizeTask\(tenant\.browserNextTask\) === normalizeTask\(task\)/.test(toolSrc),
  "a start clears browserNextTask once the queued task actually begins",
);
assert(
  toolSrc.includes("alreadyTyped: decided.kind === \"code\" && submitted && !partial"),
  "a partial CDP fill never counts as already typed (item 17)",
);
assert(
  toolSrc.includes("entered: false") &&
    toolSrc.includes("не удалось передать") &&
    toolSrc.includes("страница уже закрылась"),
  "a failed queue reports the code/confirmation as not entered and names the reason",
);
assert(
  toolSrc.includes('status: browserListed ? (tenant.browserStatus ?? "running") : "no_wait"'),
  "a failed queue with no probed browser reports no_wait",
);

// jargon (item 8): none of these words may appear in a human-facing hint —
// pin the specific old strings that used to carry them (code identifiers
// like decideCloudInject/parseCloudOutcome legitimately keep "Cloud").
assert(!toolSrc.includes("другой браузер-джоб"), "busy hint no longer says «джоб»");
assert(!toolSrc.includes("джоб висит слишком долго"), "stuck-job hint no longer says «джоб»");
assert(!toolSrc.includes("живую Cloud-сессию"), "inject hints no longer say «Cloud»");
assert(
  toolSrc.includes("Не вызывай profile_setup"),
  "busy hint tells the model not to call profile_setup instead",
);
assert(
  toolSrc.includes("shortTask(tenant.browserTask)") && toolSrc.includes("shortTask(task)"),
  "busy hint uses shortTask for both the active and queued task text (coordinator fix 1)",
);
assert(
  toolSrc.includes("activeTask: tenant.browserTask,") && toolSrc.includes("queuedTask: task,"),
  "busy's activeTask/queuedTask fields stay raw — only the hint text is shortened",
);

// coordinator fix 2: the fresh charge is aliased onto the new session id so a
// pay-forced restart or a login→errand continuation (chargeKeyFor keys those
// off the session id) finds it already covered instead of double-charging.
assert(
  toolSrc.includes("aliasBrowserCharge(phone, opened.sessionId)"),
  "a fresh charged start aliases its charge onto the new session id",
);

// coordinator fix 3: the tool description is short, plain English, and never
// uses the vendor brand word (only code identifiers like decideCloudInject
// legitimately keep "Cloud").
{
  const descMatch = toolSrc.match(/description:\s*\n?\s*['"]([\s\S]*?)['"],\n\s*inputSchema/);
  assert(descMatch !== null, "found the tool description string");
  const desc = descMatch![1]!;
  assert(desc.length <= 900, `description is ${desc.length} chars, must be <= 900`);
  assert(!desc.includes("Cloud"), "description never uses the vendor brand word");
  assert(desc.includes("busy"), "description explains the busy status");
  assert(desc.includes("reset:true"), "description explains reset:true");
  assert(desc.includes("needsProfileSync"), "description explains needsProfileSync");
  assert(desc.includes("needsVaultSetup"), "description explains needsVaultSetup");
}

const profileSrc = src("agent/tools/profile_setup.ts");
assert(profileSrc.includes("errand: z.string()"), "profile_setup accepts an errand param");
assert(profileSrc.includes("nextLoginAction"), "profile_setup uses the reuse-guard decision");
assert(profileSrc.includes("cookieCacheStale"), "profile_setup revalidates the cookie cache");
assert(
  !profileSrc.includes("countBrowserJobStart") && !profileSrc.includes("browserGateFromResult"),
  "profile_setup no longer charges a browser job (item 13)",
);
assert(profileSrc.includes("fastAckOf"), "profile_setup defers its opening notify to a fast-ack");
assert(!profileSrc.includes("Cloud должен войти"), "profile_setup already-logged hint no longer says «Cloud»");

const tenantsSrc = src("convex/tenants.ts");
assert(tenantsSrc.includes("clearBrowserNeedPublic"), "tenants.ts exposes a public clearBrowserNeed");
assert(tenantsSrc.includes("chargeKey"), "countBrowserJobStart accepts a chargeKey");
assert(tenantsSrc.includes('`cloud:${key}`'), "cloud charge keys are namespaced in browserCharges");

const convexWrapperSrc = src("agent/lib/convex.ts");
assert(
  convexWrapperSrc.includes("export const clearBrowserNeed"),
  "agent/lib/convex.ts wraps clearBrowserNeedPublic",
);
assert(
  convexWrapperSrc.includes("chargeKey: opts?.chargeKey"),
  "agent/lib/convex.ts forwards chargeKey to countBrowserJobStart",
);

const pkg = src("package.json");
assert(pkg.includes("browser-task:check"), "package.json wires browser-task:check");

// ---------------------------------------------------------------------------
// scaffoldTask({ continuation: true }) — the continuation errand must say
// the page is already open from the previous step and never repeat the
// fresh-start "Сайт откроет Bro сам" navigation instruction (goal.md: the
// taxi incident was a fresh run re-navigating and re-driving the route).
// ---------------------------------------------------------------------------
{
  const cont = scaffoldTask("выбери карту из сейфа и заверши оплату", {
    continuation: true,
  });
  const lower = cont.toLowerCase();
  assert(lower.includes("страница уже открыта"), "continuation scaffold says the page is already open");
  assert(lower.includes("продолжай"), "continuation scaffold tells the model to continue from here");
  assert(!cont.includes("Сайт откроет Bro сам"), "continuation scaffold never repeats the fresh-start line");
  assert(cont.includes("выбери карту из сейфа и заверши оплату"), "continuation scaffold carries the human's own line");
  assert(
    !cont.includes("Страница уже открыта:"),
    "continuation never falls back to the plain startPage phrasing either",
  );
}
{
  // continuation and startPage are mutually exclusive in practice (browser_task
  // never passes both) — continuation wins if somehow both are set, since
  // re-navigating is exactly what a continuation must not do.
  const both = scaffoldTask("x", { continuation: true, startPage: "https://taxi.yandex.ru/" });
  assert(!both.includes("Страница уже открыта: https://taxi.yandex.ru/"), "continuation overrides startPage wording");
}

// ---------------------------------------------------------------------------
// Source-level wiring: the `continue` branch in browser_task.ts (goal.md) —
// resumes the SAME session, never tears down the old browser, never
// re-navigates over CDP, and is never billed as a fresh job.
// ---------------------------------------------------------------------------

const continueBlock = toolSrc.slice(
  toolSrc.indexOf('if (action === "continue"'),
  toolSrc.indexOf("// Cheap part before the billing gate"),
);
assert(continueBlock.length > 0, "found the continue branch in browser_task.ts");
assert(
  continueBlock.includes("startRun(task, sessionId,"),
  "continue starts the follow-up run with the SAME (stored) sessionId",
);
assert(
  continueBlock.includes("continuation: true"),
  "continue passes continuation:true through to startRun/scaffoldTask",
);
assert(
  !continueBlock.includes("cancelRun(") && !continueBlock.includes("stopBrowserForSession("),
  "continue never cancels the run or stops the browser — same session, same open tab",
);
assert(
  !continueBlock.includes("await waitForPageLanding("),
  "continue never re-navigates the open tab to the errand's start URL",
);
assert(
  !continueBlock.includes("await countBrowserJobStart("),
  "continue is never billed as a fresh job (same reasoning as the inject/resume path)",
);
assert(
  continueBlock.includes('needsVaultSetup: "payment"'),
  "a payment continuation with no vault card returns the standard needsVaultSetup shape",
);
assert(
  continueBlock.includes('tenant.browserNeed === "payment"') &&
    continueBlock.includes("continuationPayHosts("),
  "a payment continuation binds the vault card even when the model forgot `pay`",
);
assert(
  continueBlock.includes("clearBrowserNeed(phone, tenant.browserRunId)"),
  "continue clears the resolved browserNeed once the follow-up run starts",
);

// Coordinator fix 1: the ORIGINAL errand (with its start URL etc.) stays the
// stored/followed/settled task — the continuation text is only the Cloud
// run's own instruction, never what later errandStartUrl/progress-note/
// wakeup lookups key off (same pattern as maybeInjectChat's
// `tenant.browserTask ?? incoming`).
assert(
  (continueBlock.match(/tenant\.browserTask \?\? task/g) ?? []).length >= 1,
  "continue derives `errand` from tenant.browserTask ?? task, not the raw continuation text",
);
assert(
  continueBlock.includes("persist(phone, started, errand,") &&
    continueBlock.includes("persist(phone, done, errand)"),
  "continue persists the ORIGINAL errand, not the continuation text",
);
assert(
  continueBlock.includes("task: errand,"),
  "continue's startBrowserFollow is keyed on the original errand text",
);
assert(
  /return settle\(\s*phone,\s*done,\s*errand,/.test(continueBlock),
  "continue settles with the original errand text",
);
assert(
  continueBlock.includes("startRun(task, sessionId,") && !continueBlock.includes("startRun(errand, sessionId,"),
  "the continuation text (not the original errand) is still what actually goes to the Cloud run",
);

// Coordinator fix 2: a `continue` target session can be gone by the time the
// human answers (Browser Use's 4h hard cap, or sweepWaiting's 40min stop) —
// check before committing to it, and never let a startRun failure into a
// vanished session take down the whole errand.
const actionBlock = toolSrc.slice(
  toolSrc.indexOf("const preAction ="),
  toolSrc.indexOf('if (action === "continue"'),
);
assert(
  actionBlock.includes('preAction === "continue"') &&
    actionBlock.includes("findBrowserForSession(tenant.browserSessionId)"),
  "a `continue` decision is checked against findBrowserForSession before it is committed to",
);
assert(
  continueBlock.includes("try {") && continueBlock.includes("fallbackToStart"),
  "continue wraps its startRun call in try/catch with a fallbackToStart flag",
);
assert(
  continueBlock.includes("continue: session gone, starting fresh"),
  "a startRun failure into a vanished session is logged, not thrown",
);
assert(
  /if \(started && !fallbackToStart\)/.test(continueBlock),
  "continue only takes the continuation path when startRun actually succeeded",
);

// ---------------------------------------------------------------------------
// Card flow: an attach-card errand («привяжи карту в яндекс такси») binds the
// vault card even when the chat model sends no `pay`, and binds it to the
// domains the card form actually lives on. Source-level — the full path needs
// a live Browser Use session and a real Yandex account.
// ---------------------------------------------------------------------------
{
  const startPage = errandStartUrl("привяжи карту в яндекс такси");
  eq(startPage, "https://taxi.yandex.ru/", "an attach-card taxi errand resolves its site");
  assert(
    isAttachCardErrand("привяжи карту в яндекс такси"),
    "«привяжи карту» is recognised as a card errand",
  );
  assert(
    expandPayHosts([startPage!]).includes("yandex.ru"),
    "the site it resolves widens to the domain the card form lives on",
  );
}

{
  const attachBlock = toolSrc.slice(
    toolSrc.indexOf("// Cheap part before the billing gate"),
    toolSrc.indexOf("const chargeKey = chargeKeyFor("),
  );
  assert(attachBlock.length > 0, "found the pre-billing card-resolution block");
  assert(
    attachBlock.includes("if (pay || attachCard) {"),
    "an attach-card errand resolves a vault card even with no `pay`",
  );
  assert(
    attachBlock.includes("errandStartUrl(task)"),
    "with no `pay`, the hosts come from the errand's own site",
  );
  assert(
    attachBlock.includes('needsVaultSetup: "payment"'),
    "«привяжи карту» with an empty vault asks for vault_setup instead of running blind",
  );
  assert(
    attachBlock.includes("expandPayHosts(rawHosts)"),
    "the bound domains are the widened set",
  );
  assert(
    /if \(pay && payHostsBase\.length === 0\)/.test(attachBlock),
    "an explicit `pay` with no usable hostname is still rejected",
  );
}

{
  // 3-D Secure / SMS / push during a card flow must be resumable in the SAME
  // session: the widened bindings are re-sent and the human's code is queued
  // into the tab that is already sitting on the bank page.
  assert(
    toolSrc.includes("const contAttachCard = isAttachCardErrand(tenant.browserTask ?? task);"),
    "a continuation knows the original errand was an attach-card one",
  );
  assert(
    toolSrc.includes('tenant.browserNeed === "payment" || contAttachCard'),
    "an attach-card continuation re-binds the card without waiting for `pay`",
  );
  assert(
    toolSrc.includes("contAttachCard ? { attachCard: true } : {}"),
    "the continuation keeps the attach-card shape in its prompt",
  );
  for (const need of ["3ds", "sms_code", "push"] as const) {
    assert(
      nextBrowserAction({
        runId: "r1",
        status: "completed",
        storedTask: "привяжи карту в яндекс такси",
        sessionId: "sess-1",
        need,
        incomingTask: "готово, подтвердил",
      }) === "continue",
      `a card errand parked on ${need} resumes in the same session`,
    );
  }
}

// ---------------------------------------------------------------------------
// Byte ceilings. The owner's complaint about the Cloud console was "гигантская
// волна текста": the task field is the whole brief the Browser Use agent gets,
// and every sentence added to it competes with the goal for the model's
// attention. ~670 of these bytes are the mandatory outcome block, which is
// contract and may not shrink — everything above the ceilings is operating
// prose, and it must not creep back. Raising a ceiling is a decision, not a
// side effect: if one of these fires, cut a sentence instead.
// ---------------------------------------------------------------------------

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function underCeiling(label: string, text: string, ceiling: number): void {
  assert(
    bytes(text) <= ceiling,
    `${label} is ${bytes(text)} bytes, ceiling ${ceiling} — cut a sentence, do not raise it`,
  );
}

{
  const payOpts = {
    hosts: expandPayHosts(["ozon.ru"]),
    holder: "IVAN PETROV",
    account: "Visa · •••• 1111",
    maxRub: 5000,
  };
  underCeiling(
    "plain errand scaffold",
    scaffoldTask("вызови такси до Шереметьево", { startPage: "https://taxi.yandex.ru/" }),
    2700,
  );
  underCeiling(
    "dry-run errand scaffold",
    scaffoldTask("покажи форму такси, не нажимай Заказать", {
      startPage: "https://taxi.yandex.ru/",
    }),
    2700,
  );
  underCeiling(
    "continuation scaffold",
    scaffoldTask("подтвердил в приложении", { continuation: true }),
    2900,
  );
  underCeiling(
    "vault-login errand scaffold",
    scaffoldTask("зайди на ozon и посмотри заказы", { login: true, profileSynced: true }),
    3200,
  );
  underCeiling(
    "paid errand scaffold",
    scaffoldTask("купи на ozon.ru кофе Lavazza 1 кг, оплати картой", {
      profileSynced: true,
      pay: payOpts,
      startPage: "https://www.ozon.ru/",
    }),
    4200,
  );
  underCeiling(
    "attach-card errand scaffold",
    scaffoldTask("привяжи карту в яндекс такси", {
      pay: { ...payOpts, hosts: expandPayHosts(["taxi.yandex.ru"]), attachCard: true },
      startPage: "https://taxi.yandex.ru/",
    }),
    4300,
  );
}

// Mid-run messages go into a session that already holds the errand and the
// open tab (POST /sessions/{id}/queue runs them as the next turn), so they are
// follow-ups, not briefs. They stay far smaller than a scaffold.
for (const kind of ["code", "wait", "confirm", "correction", "steer"] as const) {
  const human = kind === "code" ? "482911" : "Ленина 12";
  underCeiling(
    `injectQueueText(${kind})`,
    injectQueueText({ kind, humanText: human, code: kind === "code" ? human : undefined }),
    600,
  );
  underCeiling(
    `injectFollowTask(${kind})`,
    injectFollowTask({
      kind: kind as CloudInjectKind,
      humanText: human,
      originalTask: "[bro-errand]\nвызови такси до Шереметьево",
      code: kind === "code" ? human : undefined,
    }),
    900,
  );
}
underCeiling("loginWaitTask", loginWaitTask("https://www.ozon.ru"), 1400);
underCeiling("loginVaultTask", loginVaultTask("https://taxi.yandex.ru"), 1000);

console.log("browser-task-check ok");
