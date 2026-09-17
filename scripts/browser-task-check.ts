/**
 * browser_task / profile_setup wiring (A3): pure-helper behavior plus
 * source-level assertions for the wiring that can't be exercised without a
 * live Browser Use Cloud / Convex deployment (billing gate, queue/clear
 * calls, notify gating). Behavioral coverage for the lower-level pieces
 * (queueMessage, cancelRun, hydrate scrubbing, …) already lives in
 * browser-queue-check.ts / browser-glue-check.ts.
 */
import {
  ackSessionLive,
  chargeKeyFor,
  holdableSteer,
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
// (e) «на воскресенье» is two words and carries no «?» — read as an ack it was
// answered with "это подтверждение, не пересылай результат заново" and never
// reached the live Cloud session. While a session is live (or a start is in
// flight) a short line is a detail for the errand, not applause.
for (const line of ["на воскресенье", "на двоих", "у окна", "готово"]) {
  assert(
    !isAckLike(line, { sessionLive: true }),
    `«${line}» is not swallowed as an ack while a session is live`,
  );
}
assert(isAckLike("спасибо", { sessionLive: false }), "with nothing live, a short reply is still an ack");
assert(isAckLike("спасибо"), "the ack reading is unchanged when liveness is not passed");

// ---------------------------------------------------------------------------
// ackSessionLive — S14: a start claim is liveness only for the errand it
// belongs to. A «спасибо» about the errand that just FINISHED, typed while a
// brand new one is mid-claim, used to read as a detail — so the reuse branch
// skipped the ack short-circuit and re-sent the old run's result.
// ---------------------------------------------------------------------------
{
  const t0 = Date.parse("2026-09-15T12:00:00.000Z");
  const claimed = t0 - 3_000;
  assert(
    ackSessionLive({ browserStatus: "running" }, t0),
    "a genuinely running errand is live",
  );
  assert(
    ackSessionLive({ browserStartingAt: claimed }, t0),
    "a first errand mid-claim (no stored run at all) is live",
  );
  assert(
    !ackSessionLive({ browserStatus: "completed", browserStartingAt: claimed }, t0),
    "a claim for the NEXT errand never makes the finished one live (S14)",
  );
  assert(
    !ackSessionLive({ browserStatus: "completed" }, t0),
    "a finished errand with no claim is not live",
  );
  assert(
    !ackSessionLive({ browserStartingAt: t0 - 5 * 60_000 }, t0),
    "an expired claim is not live",
  );
  assert(!ackSessionLive({}, t0), "an empty row is not live");
  // The S14 report, end to end: «спасибо» after a completed errand, while the
  // next one is still opening, must come back out as an ack.
  assert(
    isAckLike("спасибо", {
      sessionLive: ackSessionLive(
        { browserStatus: "completed", browserStartingAt: claimed },
        t0,
      ),
    }),
    "«спасибо» after a completed errand stays an ack while the next one opens",
  );
}

// ---------------------------------------------------------------------------
// holdableSteer — S4: what may be PARKED on the tenant row while a start is in
// flight. The claim loser used to park whatever the human typed, unfiltered,
// and the winner queued it into the Cloud session verbatim — which is how a
// pasted site password reached the vendor's browser. These are the exact lines
// from the report.
// ---------------------------------------------------------------------------
for (const line of [
  "Hunter2024",
  "мой пароль от озона Hunter2024",
  "спасибо",
  "как дела",
  "😀😀",
]) {
  assert(!holdableSteer(line), `«${line}» is never parked for the live session`);
}
for (const line of ["482913", "на воскресенье", "подожди", "не туда, Ленина 12"]) {
  assert(holdableSteer(line), `«${line}» is still parked — it belongs to the errand`);
}

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

assert(
  toolSrc.includes("const sessionLive = ackSessionLive(tenant);") &&
    toolSrc.includes("isAckLike(task, { sessionLive })"),
  "the reuse branch passes liveness into isAckLike through the shared policy",
);
assert(
  toolSrc.includes("cloudStartInFlight({ startingAt: tenant.browserStartingAt })"),
  "a start in flight is still what the inject path calls liveness",
);

// ---------------------------------------------------------------------------
// S2 — the poll branch's steer must never interrupt the run it is polling.
// An interrupting queue CANCELS the active run and spawns a new one (that is
// why resolveQueuedRun exists); this branch then waits on `tenant.browserRunId`
// — the run it just killed — sees `cancelled`, settles it as finished, tells
// the human «Job ended», and leaves the replacement run live, unpersisted,
// unfollowed, and its purchase unrecorded. The flag is passed EXPLICITLY, so
// the branch is correct whatever `injectQueueInterrupt("steer")` defaults to.
// ---------------------------------------------------------------------------
{
  const poll = toolSrc.slice(
    toolSrc.indexOf('if (action === "poll"'),
    toolSrc.indexOf('if (action === "continue"'),
  );
  assert(poll.length > 0, "found the poll branch");
  assert(
    /queueSteer\(tenant\.browserSessionId, injectIncoming, \{[^}]*interrupt: false/s.test(poll),
    "a poll appends its steer, never preempting the run it is about to wait on",
  );
  assert(
    !poll.includes("resolveQueuedRun("),
    "the poll branch does not (and now need not) re-resolve a replacement run",
  );
}

// ---------------------------------------------------------------------------
// S4 — the hold path filters. This code runs precisely when maybeInjectChat
// returned null, i.e. when the line was judged NOT injectable, so parking it
// unconditionally bypassed every exclusion (smalltalk, emoji, chatter and
// looksLikePasswordDump) and drainHeldSteer then queued it verbatim.
// ---------------------------------------------------------------------------
assert(
  /const held = holdableSteer\(injectIncoming\);\s*\n\s*if \(held\) \{\s*\n\s*await holdBrowserSteer\(phone, injectIncoming\)/.test(
    toolSrc,
  ),
  "the claim loser parks a line only when the inject text gate accepts it",
);
assert(
  /\.filter\(\(line\) => line\.length > 0 && line !== drop && holdableSteer\(line\)\)/.test(
    toolSrc,
  ),
  "the drain re-checks the gate — a parked row outlives the turn that wrote it",
);
assert(
  toolSrc.includes("эту строку я никуда не передавал"),
  "«я записал эту строку» is only said when a row was actually written",
);

// ---------------------------------------------------------------------------
// S10 — «поздно, но не потеряно». takeBrowserPendingSteer reads AND clears in
// one transaction, so a swallowed queue failure destroyed the follow-up: one
// Browser Use 5xx and the line was simply gone.
// ---------------------------------------------------------------------------
{
  const drain = toolSrc.slice(
    toolSrc.indexOf("async function drainHeldSteer"),
    toolSrc.indexOf("async function maybeInjectChat"),
  );
  assert(drain.length > 0, "found drainHeldSteer");
  assert(
    drain.includes("else failed.push(line);") &&
      /for \(const line of failed\) \{\s*\n\s*await holdBrowserSteer\(phone, line\)/.test(drain),
    "a line whose queueSteer failed is re-parked, not dropped",
  );
}

// ---------------------------------------------------------------------------
// S5 — one guard over the whole span from the claim to the first persist.
// Five throws were unguarded before (listVaultItems, readVaultSecret, the
// half-filled-card throw, vaultPasswordLoginForPages, and the persist AFTER a
// successful startRun), each wedging the tenant for START_CLAIM_MS while it
// answered every line with a «я записал эту строку» that was not true.
// ---------------------------------------------------------------------------
{
  const span = toolSrc.slice(toolSrc.indexOf("startClaimAt = claim.startingAt;"));
  assert(span.length > 0, "found the claimed start span");
  assert(
    span.includes("let claimSpanDone = false;") &&
      /\} finally \{\s*\n\s*if \(!claimSpanDone\) await dropStartClaim\(\);/.test(span),
    "the claimed span releases on every exit, return or throw",
  );
  assert(
    span.indexOf("claimSpanDone = true;") > span.indexOf("await persist(phone, opened, task, {"),
    "the claim is only considered settled once the run is actually on the row",
  );
  assert(
    !/await releaseBrowserStart\(phone\)/.test(toolSrc),
    "no per-return release survives, and none clears a claim it does not own",
  );
  assert(
    span.includes("if (openedRun) {") && span.includes("orphan run persist failed"),
    "a run that was opened before the failure is written down so it can be cancelled",
  );
}

// ---------------------------------------------------------------------------
// S6 — reset must not release a SIBLING's in-flight claim. It used to, and
// then reached the cleanup with a snapshot that had no runId/sessionId to
// cancel: two charged runs, the first browser orphaned beyond reach.
// ---------------------------------------------------------------------------
assert(
  !/if \(reset\) \{[\s\S]{0,200}releaseBrowserStart/.test(toolSrc),
  "reset no longer clears whatever claim happens to be on the row",
);
assert(
  toolSrc.includes("if (!claim.claimed && reset) {") &&
    toolSrc.includes("waitForSiblingStart(phone, claim.startingAt)") &&
    toolSrc.includes("tenant = landed;"),
  "a reset waits for the sibling's run to land so the cleanup can cancel it",
);
assert(
  toolSrc.includes("await releaseBrowserStart(phone, startClaimAt)"),
  "the release is compare-and-clear on this turn's own claim stamp",
);

// ---------------------------------------------------------------------------
// The continuation path takes the claim too. It never opens a browser and is
// never billed as a fresh job — but it does open a second AGENT into a session
// whose checkout already has the card bound, and it is reached exactly when
// the human answers a blocker, which is when they type twice in a row.
// ---------------------------------------------------------------------------
{
  const cont = toolSrc.slice(
    toolSrc.indexOf('if (action === "continue"'),
    toolSrc.indexOf("// Cheap part before the billing gate"),
  );
  assert(
    cont.indexOf("const contClaim = await takeStartClaim();") <
      cont.indexOf("started = await startRun(task, sessionId,"),
    "the continuation claims before its startRun round-trips",
  );
  assert(
    cont.includes("return parkBehindStart(phone, tenant, injectIncoming, notify, contClaim);"),
    "a continuation that loses the claim parks its line instead of opening a twin agent",
  );
  assert(
    /\} catch \(err\) \{\s*\n\s*await dropStartClaim\(\);\s*\n\s*throw err;/.test(cont),
    "a throw inside the continuation hands the claim back",
  );
}
// …and a continuation whose session had vanished carries its claim into the
// fresh start instead of re-claiming: `claimBrowserStart` would refuse the
// claim against ITSELF and the errand would be parked behind its own start.
assert(
  /let claim =\s*\n\s*startClaimAt === undefined\s*\n\s*\? await takeStartClaim\(\)\s*\n\s*: \{ claimed: true as const, startingAt: startClaimAt \};/.test(
    toolSrc,
  ),
  "the fresh-start path reuses a claim this turn already holds",
);

assert(toolSrc.includes("markTurnSpoke"), "browser_task marks the turn as spoken after its own notify");
assert(toolSrc.includes("fastAckOf"), "browser_task defers its own notify to a fast-ack");
assert(toolSrc.includes("browserPaying"), "browser_task persists/reads browserPaying");
assert(toolSrc.includes("browserPayHosts"), "browser_task persists/reads browserPayHosts");
assert(toolSrc.includes("need: tenant.browserNeed"), "inject attrs carry the tenant's browserNeed");
// Was `browserProbed: true` unconditionally. It cannot be: during a start
// claim there is no session id to probe yet, and "probed and found nothing"
// would then be read as a confirmed-absent browser (cloudSessionLooksLive's
// F1 rule) and kill the inject the claim exists to protect.
assert(
  toolSrc.includes("browserProbed: probed"),
  "inject attrs mark the browser as probed only when something was actually probed",
);
assert(
  /if \(sessionId \|\| tenant\.browserRunId\) \{\s*const browser = await findBrowserForSession/.test(
    toolSrc,
  ),
  "the browser probe only runs when there is a session or run to probe",
);
assert(toolSrc.includes("clearBrowserNeed(phone"), "a successful inject queue clears browserNeed*");
// The blocker guard moved into the gate both completion paths share
// (convex/lib/orderRecordPolicy.ts) — assert it there, and that the tool
// records through it.
assert(
  src("convex/lib/orderRecordPolicy.ts").includes(
    'parseCloudOutcome(run.result).needs !== "none"',
  ),
  "orderRowFromRun never records an order while a blocker is still parked",
);
assert(
  toolSrc.includes("orderRowFromRun({"),
  "maybeRecordOrder gates and parses through the shared orderRowFromRun",
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
// S6, the Convex half: releasing a start claim is compare-and-clear, so a turn
// can only ever drop the claim it took itself. An unconditional clear was a
// supported way to cancel somebody else's in-flight start.
assert(
  /args: \{ secret: v\.string\(\), phoneE164: v\.string\(\), startingAt: v\.number\(\) \}/.test(
    tenantsSrc,
  ),
  "releaseBrowserStart requires the claim's own startingAt",
);
assert(
  tenantsSrc.includes(
    "if ((existing.browserStartingAt ?? 0) !== args.startingAt) return null;",
  ),
  "releaseBrowserStart clears only a matching claim",
);
assert(
  tenantsSrc.includes("return { claimed: true, startingAt: args.now };"),
  "a won claim hands back its own stamp, so the winner can release exactly it",
);
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
assert(
  /releaseBrowserStart = \(\s*\n?\s*phoneE164: string,\s*\n?\s*startingAt: number,/.test(
    convexWrapperSrc,
  ),
  "the agent wrapper cannot release a claim without naming which one",
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
//
// Every ceiling here dropped by ~600-700 bytes when the generic browsing
// advice came out of the scaffold (agent/lib/errand-brief.ts). These calls
// pass no facts and no composed brief, so what they measure is the ENVELOPE
// alone; the ceilings for a task carrying the human's own facts live in
// scripts/errand-brief-check.ts, where growth is user content, not prose.
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
    2100,
  );
  underCeiling(
    "dry-run errand scaffold",
    scaffoldTask("покажи форму такси, не нажимай Заказать", {
      startPage: "https://taxi.yandex.ru/",
    }),
    2100,
  );
  underCeiling(
    "continuation scaffold",
    scaffoldTask("подтвердил в приложении", { continuation: true }),
    2100,
  );
  underCeiling(
    "vault-login errand scaffold",
    scaffoldTask("зайди на ozon и посмотри заказы", { login: true, profileSynced: true }),
    2400,
  );
  underCeiling(
    "paid errand scaffold",
    scaffoldTask("купи на ozon.ru кофе Lavazza 1 кг, оплати картой", {
      profileSynced: true,
      pay: payOpts,
      startPage: "https://www.ozon.ru/",
    }),
    3300,
  );
  underCeiling(
    "attach-card errand scaffold",
    scaffoldTask("привяжи карту в яндекс такси", {
      pay: { ...payOpts, hosts: expandPayHosts(["taxi.yandex.ru"]), attachCard: true },
      startPage: "https://taxi.yandex.ru/",
    }),
    3600,
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
