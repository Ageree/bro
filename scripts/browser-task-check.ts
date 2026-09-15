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
import { loginWaitTask } from "../agent/lib/browseruse.ts";

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

console.log("browser-task-check ok");
