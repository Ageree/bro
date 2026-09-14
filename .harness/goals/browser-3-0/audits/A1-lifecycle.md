# A1 — Browser run lifecycle & follow-through («доводка») audit

## 1. Summary

The single-in-flight-job model (`nextBrowserAction`) and the durable Convex workflow
(`followThrough`) are individually well tested (`scripts/browser-policy-check.ts`,
`scripts/wakeups-check.ts`, `scripts/browser-queue-check.ts` are thorough for the
pure-function layer), and the claim/lease dance around `claimBrowserWakeup` /
`claimBrowserLoginLink` is genuinely careful — it's the best-built part of the slice.

The three worst holes:

1. **A second, unrelated errand sent while the first is still active is silently
   swallowed** (`agent/lib/browser-policy.ts:44`, `agent/tools/browser_task.ts:482-502`).
   "закажи такси" then, a minute later, "купи молоко" → the milk errand is never
   started, never queued, never mentioned to the model as lost — the tool just
   returns the taxi run's poll status. This is the core promise of the product
   ("no dead ends") broken by construction, not by a bug in a single function.
2. **Give-up never stops the Cloud run.** There is no stop/cancel call to
   Browser Use anywhere in the repo (`grep` for cancel/stop/DELETE against
   `/runs` returns nothing). After 20 minutes Bro tells the human it's giving up,
   but the Cloud browser keeps running (and billing, up to `maxCostUsd`) with
   nothing watching it — if it finishes at minute 25 the *next*, unrelated
   errand from the human will silently inherit its stale result via the "poll"
   branch.
3. **The wakeup delivered-once guarantee is per-process, in-memory, on a
   platform whose own README brags that "eve runs the turn in a separate
   queue-triggered Vercel function."** `agent/lib/wakeup-dedupe.ts`'s own doc
   comment admits "lost on restart and not shared across instances." Convex's
   `wakeupAgent` retries this POST up to 9 times over ~64s on any failure
   (`convex/lib/browserFollowPolicy.ts:76-97`); if a retry lands on a fresh
   Vercel container the in-memory de-dupe map is empty and the same "нашёл
   такси!" bubble can go out twice.

Two independent notification paths can also fire for the same browser errand
at once: the automatic `browserFollow` workflow (2 min cadence) and, if the
model followed the explicit instruction to `job_open`/`job_wait` for "browser
running" work (`agent/instructions.md:98`), a `job_check` wakeup (8 min
cadence, unrelated idempotency scheme) polling the same job independently.

## 2. Findings

### F1 — P0 — second errand while one is active is silently dropped
**Where:** `agent/lib/browser-policy.ts:35-55` (`nextBrowserAction`), consumed at
`agent/tools/browser_task.ts:462-502`.

**Scenario:** Human: «вызови такси домой». Run starts, status becomes
`running`. 90s later, still running, human sends «купи кроссовки на вб 42».
`nextBrowserAction` sees `isActiveStatus(status)` true and returns `"poll"`
*regardless of `incomingTask`* — the incoming text is never compared to the
stored task while a run is active (only compared when `isDoneStatus`, lines
45-52). `browser_task.ts:482-502` then does `waitForRun(tenant.browserRunId,
...)` and `settle(phone, run, tenant.browserTask ?? task, ...)` — note
`tenant.browserTask`, the OLD stored "такси" task, is what's returned to the
model, not the new "кроссовки" request. The tool payload's `hint` says
"Still running... tell the human you're looking" — about the taxi, not the
shoes. The shoes errand is not started, not queued anywhere (unlike the
OTP/wait/correction path, `купи кроссовки` does not match `injectCandidate` /
`decideCloudInject` in `convex/lib/browserInjectPolicy.ts`, so `maybeInjectChat`
returns `null` and it falls straight into `nextBrowserAction`). The model has
no signal in the tool response that anything was dropped, and per
`agent/instructions.md:59` ("Never a second search while one runs") it is
actively told this is correct behavior. The shoe errand is gone; nothing will
ever surface it again unless the human repeats it.

**Root cause:** `nextBrowserAction`'s active-status branch has no
"does the incoming text still describe the same job?" check — that comparison
only exists in the *done*-status branch (`looksLikeNewJob`/`normalizeTask`
equality, lines 45-52).

**Fix:** When status is active, also compare `incomingTask` against
`storedTask`/`looksLikeNewJob`. If it looks like a different job, return a new
outcome (e.g. `"busy"`) so `browser_task.ts` can tell the model explicitly:
"a browser job is already running for X; the new request cannot start until it
finishes — tell the human and offer to park it as a job (`job_open`) or wait."
At minimum, surface `busy: true, activeTask: tenant.browserTask` in the poll
payload so the model doesn't silently drop the second ask.

**Check:** `scripts/browser-policy-check.ts` already tests "ping while running
polls" (line 44) with `incomingTask: "ну что"` — it never tests an unrelated,
substantive `incomingTask` (e.g. `"купи кроссовки на вб 42 размер"`) against an
active run. Add that case and assert on the new `busy` signal.

---

### F2 — P0 — give-up never stops the Cloud run; money and a stale run keep going
**Where:** `convex/browserFollow.ts:82-105` (`followThrough` handler, `giveup`
branch), `agent/lib/browseruse.ts` / `convex/lib/browseruse.ts` (no stop/cancel
endpoint call exists anywhere — confirmed by repo-wide grep for
`stop`/`cancel`/`DELETE` against `/runs`).

**Scenario:** A run gets stuck (e.g. Cloud LLM loops on a CAPTCHA) past the
20-minute `POLL_GIVE_UP_MS` (`convex/lib/browserFollowPolicy.ts:11`). The
workflow sends `phase: "giveup"` → `wakeupAgent` → the human is told the job
hung. The workflow then returns `{outcome: "timeout"}` and ends — nothing ever
calls Browser Use to stop the run. The Cloud browser keeps executing (and
billing against `maxCostUsd`, `agent/lib/browseruse.ts:278-279`, default $1)
until Cloud's own internal limits kick in. Meanwhile `tenant.browserRunId`
still points at this run and its `browserStatus` is whatever the last poll
wrote (typically still `running`/`queued`). The *next* unrelated errand from
the human hits `nextBrowserAction`'s active branch (see F1) and silently polls
this zombie run instead of starting fresh — if it finishes at minute 25 with
some unrelated leftover Cloud output, `settle()` will happily hand that stale
result back to the model as if it answered the *new* request (`maybeRecordOrder`
can even file an order row from it if it parses as one, `browser_task.ts:304-324`).

**Root cause:** No `POST /runs/{id}/stop` (or equivalent) call exists in the
codebase. Give-up is purely a "we stopped watching" signal, not a
"the run has ended" signal.

**Fix:** Add a `stopRun(runId)` call to `agent/lib/browseruse.ts` /
`convex/lib/browseruse.ts` and call it from the `giveup` branch in
`followThrough` before sending the wakeup (or right after). Also clear
`tenant.browserRunId`/`browserStatus` (e.g. to `"gave_up"`) so `nextBrowserAction`
does not treat it as still-active for the next errand.

**Check:** New assertions in `scripts/browser-queue-check.ts` (fetch-mock
style) verifying `followThrough`'s giveup path calls a stop endpoint; a
`browser-policy-check.ts` case asserting `nextBrowserAction` treats a
give-up-marked status as inactive.

---

### F3 — P1 — wakeup "exactly once" is a per-process Map on a multi-instance serverless platform
**Where:** `agent/lib/wakeup-dedupe.ts:1-20` (own doc comment: "Limitation:
per-process Map — lost on restart and not shared across instances"), consumed
at `agent/channels/imessage.ts:722-727`; the retrying caller is
`convex/browserFollow.ts:362-388` (`wakeupAgent`) using
`wakeupStepRetry` = 9 attempts, up to ~64s of backoff
(`convex/lib/browserFollowPolicy.ts:76-97`); README.md:69 documents "Eve runs
the turn in a separate queue-triggered Vercel function... in-memory prefetches
made in the webhook do not reach the model call."

**Scenario:** `wakeupAgent`'s POST to `/internal/wakeup` succeeds server-side
(the `takeWakeupDelivery` dedupe map records the key and `from(...).send(...)`
is enqueued) but the HTTP response is lost to a proxy hiccup /
`AbortSignal.timeout(60_000)` firing right at completion. The Convex action
sees a thrown error, releases the *Convex-side* claim
(`releaseBrowserWakeup`), and the workflow step retries. If the retry's HTTP
request is served by a *different* Vercel instance (cold start after scale-to-
zero, or just a different concurrent lambda), `wakeupDelivered` is a fresh,
empty `Map` there — `takeWakeupDelivery` returns `true` again, and the human
gets the same "нашёл такси!" turn a second time. This is exactly the
"duplicate «ищу» bubble" failure mode the product brief calls out as
unacceptable, just applied to the completion message instead of the ack.

**Root cause:** The de-dupe key lives in process memory
(`agent/lib/wakeup-dedupe.ts:5`) instead of Convex (which already has durable,
race-safe claim state one call away — `claimBrowserWakeup` /
`confirmBrowserWakeup` in `convex/tenants.ts:504-535,555-584`).

**Fix:** The Convex-side claim (`browserWakeupClaim`, "pending"→"sent") is
*already* the correct durable de-dupe — `decideWakeupClaim`
(`convex/lib/browserFollowPolicy.ts:150-167`) already treats a `"sent"` claim
as `"duplicate"`. The gap is only that eve's HTTP layer does its *own*,
weaker, redundant check on top. Simplest fix: drop `takeWakeupDelivery` from
the `browser_poll` path entirely (Convex's claim already guarantees at-most-
once *before* the fetch is sent) and rely on it purely for the legacy
`reminder`/`brief`/`watcher` kinds that don't have a durable claim of their
own — or better, give those kinds the same claim pattern.

**Check:** `scripts/wakeups-check.ts:129-140` tests the in-memory map in
isolation; it cannot exercise the actual multi-instance failure mode (that's
inherent to the platform, not unit-testable) — note this as a real residual
risk in the checklist rather than something a script can close.

---

### F4 — P1 — two independent notification paths for the same browser errand (job_check + browser_poll)
**Where:** `agent/instructions.md:98` ("Chat stays chat until work must wait
(clinic email, «этот слот?», **browser running**): `job_open`... `job_wait`"),
`agent/tools/job_wait.ts:1-49` (`defaultCheckInMinutes` browser = 8 min,
independent `scheduleWakeup(..., kind: "job_check", recurMinutes: minutes)`),
vs. `convex/browserFollow.ts` (`kind: "browser_poll"`, 2-min cadence, its own
claim/lease de-dupe).

**Scenario:** Model starts a taxi errand via `browser_task` (which
automatically kicks `startBrowserFollow` — the human never has to ask for
follow-through). Per the instruction at line 98, the model *also* treats
"browser running" as a case to `job_open` + `job_wait(waitingFor: "browser")`,
which schedules its own `job_check` wakeup every `checkInMinutes` (default 8).
Now the same errand has two independent wakers: `browserFollow`'s
`wakeupAgent` (fires once on done/giveup, with `browserWakeupClaim` de-dupe)
and the `job_check` wakeup (recurs every 8 min, its own instruction at
`agent/lib/job-wake.ts:39-41` tells the model to "Сделай следующий шаг цепочки
сам ... Если есть прогресс — сделай шаг и коротко напиши человеку"). If a
`job_check` wakeup lands within the same window as (or shortly after) the
`browser_poll` completion wakeup, the model can call `browser_task` from
*both* turns, see `status=completed` in both, and write the result to the
human twice — there is no shared coordination between the two wakeup kinds
(different `kind`, different idempotency keys, `wakeupCarriesRunId` stale-run
check at `imessage.ts:702-714` only applies to `browser_poll`, not
`job_check`).

**Root cause:** The product instructions tell the model to layer a generic
job-waiting mechanism on top of an errand type (browser) that already has its
own dedicated, purpose-built follow-through system. Nothing in code prevents
both being active for the same errand at once.

**Fix:** Either (a) instruct the model explicitly *not* to `job_open`/`job_wait`
for plain browser errands — `browser_task` already parks and wakes on its
own — reserving `job_open` for jobs that need a *human* or *email* wait after
the browser step; or (b) if a job is opened with `waitingFor: "browser"`, have
`job_wait` check for (and refuse to double-schedule against) an already-live
`browser_poll` wakeup for that tenant (`isLiveBrowserPoll` /
`liveOfKind` in `convex/lib/wakeupPolicy.ts:136-155` already has the primitive
to detect this).

**Check:** New case in `scripts/wakeups-check.ts` (or a new
`browser-followthrough-check.ts`): opening a job with `waitingFor: "browser"`
while a live `browser_poll` wakeup exists for the same tenant should be
refused or merged, not double-scheduled.

---

### F5 — P1 — startFollowThrough can fail to (re)start follow-through with no automatic retry
**Where:** `convex/browserFollow.ts:155-185` (`startFollowThrough`),
`convex/lib/browserFollowPolicy.ts:181-195` (`decideExistingWorkflow`).

**Scenario:** Human starts errand A; workflow W1 (for runId A) is running.
Errand A finishes; a little later, human starts errand B (`reset` or a
new "start" decision) with a fresh `runId=B`. `startFollowThrough` is called
again: `tenant.browserWorkflowId` still points at W1, `workflow.status`
succeeds and reports `"inProgress"` (W1 hasn't been told to stop yet — maybe
it's mid-`step.sleep`). `decideExistingWorkflow` returns `"cancel_then_start"`
(`workflowRunId !== runId`). The code calls `workflow.cancel(ctx, id)`
(line 179); **if that throws** (line 180-183, caught and logged via
`console.error("browser follow cancel failed", err)`), the function returns
`{error: "retry_later"}` **without ever calling `workflow.start` for the new
run B**. Back in `browser_task.ts:354-370` (`settle`), this becomes
`followUp: "retry", hint: FOLLOW_RETRY_HINT` — the model is told to tell the
human or call `browser_task` again, but nothing automatically retries
starting B's follow-through. If the human doesn't happen to ping again, run B
gets **no** periodic poll and **no** completion wakeup at all — a fully silent
job, the exact "no dead ends" failure the product brief calls out.

**Root cause:** `workflow.cancel` failing is treated as fully retryable by the
caller (the hint says so) but nothing in this codebase actually retries it —
`FOLLOW_RETRY_HINT` only fires if the model happens to call `browser_task`
again (poll/reuse path), which itself only re-attempts `startFollowThrough`
when not terminal.

**Fix:** On `workflow.cancel` failure, still attempt `workflow.start` for the
new run (an orphaned old workflow's future actions are already guarded by
`sameBrowserRun` in `pollRun`, so a leftover W1 running harmlessly stale is
strictly better than *no* workflow for B). Or: schedule a same-tenant
`browser_poll` wakeup as a fallback so at least a background check happens
without relying on the human pinging.

**Check:** `scripts/browser-policy-check.ts` tests `decideExistingWorkflow`
directly (lines 264-294) but nothing exercises `startFollowThrough`'s
"cancel throws" branch end-to-end. Add a fetch/mutation-mock check asserting a
new workflow still starts (or a fallback wakeup is scheduled) when cancel
fails.

---

### F6 — P1 — billed browser job start is not refunded on failure after the charge
**Where:** `agent/tools/browser_task.ts:530-584` (charge at
`countBrowserJobStart`, line 532, well before `startRun` at line 576);
`convex/tenants.ts:924-932` (`countBrowserJobStart` → `chargeBrowserJob`, a
one-way rate-limiter `.limit()` call, line 913-917) — no refund/`release`
mutation exists anywhere in `convex/tenants.ts` or `convex/lib/billingPolicy.ts`
(grep for "refund" is empty repo-wide).

**Scenario:** `countBrowserJobStart` succeeds (job counted, quota
decremented). Between there and the actual Cloud run starting, any of the
following can throw uncaught: `parsePaymentPayload` returning `undefined` →
`throw new Error("карта в сейфе заполнена не полностью")` (line 553);
`vaultPasswordLoginForPages` failing; or `startRun`'s `bu("/runs", ...)`
throwing on a Browser Use 4xx/5xx (`agent/lib/browseruse.ts:286-296`, which
deliberately rethrows a redacted error rather than swallowing it). In every
one of these cases the tool call throws, the human gets the generic
`TURN_FAILED_REPLY` fallback (README.md:75) — but the monthly browser-job
count has already been spent for a job that never ran.

**Root cause:** The billing gate is a pure charge with no compensating
transaction; it's called intentionally early "so a missing card must not burn
quota" (the `payHosts`/`payItem` checks at lines 504-528), but that reasoning
covers only the *known-recoverable* early-return cases, not any exception
raised afterward before `startRun` succeeds.

**Fix:** Wrap the vault-read/`startRun` sequence (lines 545-587) in a
try/catch that, on failure, calls a new `refundBrowserJobStart` mutation
(decrement the same rate-limiter key) before rethrowing/returning an error
payload. This is a small, mechanical addition given the existing
`rateLimiter` helper.

**Check:** New `scripts/browser-policy-check.ts` (or a dedicated
`billing-refund-check.ts`) case: simulate `startRun` throwing after a
successful `countBrowserJobStart` and assert the job count returns to its
pre-charge value.

---

### F7 — P1 — `hydrate`'s primary run fetch is unguarded while every secondary fetch is `.catch()`-guarded
**Where:** `agent/lib/browseruse.ts:481` (`const run = await bu(`/runs/${runId}`);`
— no `.catch`) vs. lines 486, 492 (`.catch(() => ({}))`, wrapped `runEvents`)
and `applyCdpPage`'s internal `.catch(() => undefined)` calls (line 454, 459);
same asymmetry in `convex/lib/browseruse.ts:90` (Convex-side `hydrate`, also
unguarded). Callers in `agent/tools/browser_task.ts` never wrap
`hydrate`/`waitForRun` in try/catch (lines 474, 483-487, 621-625).

**Scenario:** A transient Browser Use API hiccup (rate limit, 502, DNS blip)
on exactly the `/runs/{id}` GET inside `hydrate` — the one call every other
code path treats as load-bearing and unguarded — throws. This propagates
through `waitForRun`'s final `return hydrate(...)` (also unguarded,
`agent/lib/browseruse.ts:526`), through `browser_task.ts`'s `execute()` (no
try/catch anywhere around these calls), and kills the entire tool call and
turn. Per README.md:75 the human still gets a generic "что-то сломалось" line
(not silence), but a run that is actually fine (still running, or even just
completed) reports as a hard failure to the human instead of "still
looking," and no follow-through-through payload update happens for that turn
(the tenant row is not repersisted with the fresh status either, since
`persist()` never runs).

**Root cause:** Inconsistent defensiveness within the same function — every
*secondary* enrichment call (`/sessions`, `/browsers`, run events, CDP page
read) is optional-and-guarded, but the one primary call is not, even though
it's no more reliable than the others against the same upstream.

**Fix:** Wrap the primary `bu(`/runs/${runId}`)` call the same way (retry
once, or fall back to the last-known status rather than throwing), at least
in the *human-turn* path (`browser_task.ts`); the Convex workflow side
already gets resilience for free from `workpoolOptions.retryActionsByDefault`
(`convex/browserFollow.ts:50-57`), so this is specifically a gap in the
synchronous, in-turn path where a throw is user-visible immediately.

**Check:** A `browser-queue-check.ts`-style fetch-mock case: `/runs/{id}`
returns a 500 once; assert `waitForRun`/`hydrate` degrade to "still running"
rather than throwing.

---

### F8 — P1 (documentation/confusion) — two different, unreconciled give-up thresholds
**Where:** `agent/lib/browser-policy.ts:59-67` (`POLL_GIVE_UP_MS = 30 *
60_000`, `pollTimedOut`) vs. `convex/lib/browserFollowPolicy.ts:11`
(`POLL_GIVE_UP_MS = 20 * 60_000`, used by `nextFollowDecision` /
`pollGiveUp`, which is what `followThrough` actually runs on).

**What actually happens:** `pollTimedOut` (30 min) is **dead code in
production** — repo-wide grep shows it is referenced only by its own check
script (`scripts/browser-policy-check.ts:6,188-191`) and nowhere else in
`agent/` or `convex/`. The value that actually governs give-up everywhere
(`convex/browserFollow.ts:73-77` via `nextFollowDecision`, and
`browser_task.ts`'s `shouldStartFollowThrough` re-exported at
`agent/lib/browser-policy.ts:69-72`) is the 20-minute one. So the answer to
"which wins" is: the 20-minute one always wins, because the 30-minute
constant is never consulted by anything except its own unit test.

**Root cause:** Looks like an old constant left behind when the give-up
threshold was tuned down to 20 minutes in `browserFollowPolicy.ts` (the
comment history / brief at `.harness/goals/bro-2-0/briefs/p2-browser-followthrough.md:76`
suggests `pollTimedOut` was the original design for this).

**Fix:** Delete `pollTimedOut`/`POLL_GIVE_UP_MS` from
`agent/lib/browser-policy.ts` and its test in
`scripts/browser-policy-check.ts:188-191`, or if it was meant to gate
something else (e.g. a harder outer bound the tool itself checks
independently of the workflow), wire it in and document why two thresholds
exist.

**Check:** `scripts/browser-policy-check.ts` currently tests the dead
constant as if it mattered (lines 187-191) — this should be removed once the
constant is, or the test should assert it is *not* imported/used anywhere
(`grep`-based check like the ones already in the same file, e.g. lines
401-419).

---

### F9 — P2 — `looksLikeNewJob`'s length heuristic is a coarse proxy and can misfire either way
**Where:** `agent/lib/browser-policy.ts:25-32`.

**Scenario A (false "reuse"):** Job completes; human says «спасибо» (short,
no keyword match) → `nextBrowserAction` returns `"reuse"` (line 52) →
`browser_task.ts:473-480` re-hydrates the *same* run and calls `settle()`,
which for a terminal status returns the same `payload(run, {reused:true})` —
i.e. the old result is handed back to the model again. In practice the model
probably just says "пожалуйста" without re-pasting the result, but the tool
itself has no way to tell the model "this is just an ack, say nothing job-
related" versus "please resend the result" — both look identical
(`reused:true`, same `hint: "Send these results..."`).

**Scenario B (false "start"):** Any message ≥48 characters unconditionally
returns `true` from `looksLikeNewJob` (line 30) even with zero keyword
overlap — e.g. a 50-character *comment about the same errand* ("а можно
уточнить, во сколько примерно приедет машина") reads as length ≥48 and
starts a **brand new** Cloud run/charge instead of being recognized as a
continuation of the same, already-completed taxi errand.

**Root cause:** Single length threshold with no similarity check against
`storedTask`.

**Fix:** For scenario A, add a distinct `hint` when `reused && isAckLike`
(e.g. short, no question mark, no keyword) telling the model explicitly not
to restate the result. For scenario B, compare against `storedTask` (e.g.
shared keyword or fuzzy match) before falling back to the length heuristic,
so a long *follow-up* about the same errand doesn't necessarily start a new,
separately-billed run.

**Check:** Extend `scripts/browser-policy-check.ts`'s existing table (lines
44-136) with a 48+ char follow-up-about-the-same-job case and an assert that
it should not be `"start"`.

---

### F10 — P2 — `resolveQueuedRun` / injected-code path can start a second, unawaited follow-through workflow per injection
**Where:** `agent/tools/browser_task.ts:257-276` (`maybeInjectChat`'s tail:
`persist` → `startBrowserFollow` (`followKick`) → `waitForRun` → `await
followKick`).

**Scenario:** Human sends an OTP code while a Cloud login is live.
`maybeInjectChat` queues it, resolves the new/resumed `runId`, and — every
single time a code/correction is injected — calls `startBrowserFollow` again
(line 265). This is guarded server-side by `decideExistingWorkflow` (reuse if
same run+in-progress), so it's not a *duplicate* workflow, but it does mean
every OTP keystroke round-trips through `workflow.status` +
`cancelLeftoverBrowserPolls` (a paginated wakeup scan,
`convex/browserFollow.ts:110-132`) even when nothing needs to change. Not a
correctness bug, but worth noting as unnecessary Convex load on a hot path
(every injected message), and it means a slow `workflow.status` call
(`convex/browserFollow.ts:159-162`) sits in the critical path of "type this
code into the tab *now*."

**Fix:** Skip `startBrowserFollow` in `maybeInjectChat` when
`resolved.runId === tenant.browserRunId` and a workflow is already known to be
tracking it (compare `tenant.browserWorkflowRunId` client-side before making
the round trip).

**Check:** Not critical enough to require a new check; note in the "Ideas"
section instead.

---

## 3. Console.error swallows in this slice (human ends up with only partial/no signal)

| Location | What's swallowed | Human-visible effect |
|---|---|---|
| `agent/tools/browser_task.ts:322` (`record order failed`) | `recordOrder` write failure | Result text still reaches the human, but the order is never in `list_orders` — silent bookkeeping loss, could resurface as "do I actually have this order?" confusion later. |
| `agent/tools/browser_task.ts:618` (`browser start notify failed`) | The canned "Ищу, это может занять пару минут" ack | If `deliverHumanRouted` throws, this specific ack is lost; the human relies entirely on whatever text the model itself produces this turn (usually fine, but removes the safety net the comment implies). |
| `agent/tools/browser_task.ts:390,398` (`browser profile create/get failed`) | Profile creation/cookie lookup | Errand proceeds profile-less (cold login) with no explicit note to the human that sync failed — just slower/more login friction. |
| `agent/tools/browser_task.ts:535` (`billing browser count failed`) | Rate-limiter read/write error | Currently fails open (`BROWSER_JOBS_UNLIMITED = true`, `convex/lib/billingPolicy.ts:8`) so no visible effect *today* — but see F-idea below: flips to fail-*closed* the day that flag is turned off, at which point an infra hiccup would wrongly tell the human "лимит браузер-задач исчерпан." |
| `convex/browserFollow.ts:163` (`browser follow status failed`) | `workflow.status` throw | `startFollowThrough` returns `retry_later`; if this keeps failing, follow-through never (re)starts for that run — see F5. |
| `convex/browserFollow.ts:181,227` (`browser follow cancel failed`) | `workflow.cancel` throw | See F5 — can leave the *new* run with no follow-through at all. |
| `agent/lib/browseruse.ts:575` (`cdp page navigate failed`) | CDP navigate-to-target-page failure | `waitForPageLanding` keeps retrying within its budget; not silent, just slower to "landed." |

None of these produce a fully silent turn on their own (the README's
`TURN_FAILED_REPLY` fallback covers the case where the whole turn throws), but
several (F5, F6, F2) produce a **silently degraded background state** — a job
that nobody automatically follows up on again, or a quota charge nobody
refunds — which is arguably worse than a visible error, because the human has
no reason to notice or retry.

## 4. Ideas (beyond bugs)

1. **Give the "busy" case (F1) a real UX.** When a second, different errand
   arrives while one is active, offer the human a choice via the model's
   reply: wait for the current one, or `reset` (cancel the current Cloud run
   — once F2's stop call exists — and start the new one immediately). Size: M
   (touches `browser-policy.ts`, `browser_task.ts`, instructions.md).
2. **Move the `browser_poll` de-dupe fully into Convex** (drop the
   redundant in-memory layer for that kind specifically, per F3) — removes an
   entire class of platform-dependent duplicate-delivery risk for the
   highest-stakes wakeup kind (money/results). Size: S.
3. **Surface Cloud spend/`maxCostUsd` proximity to the human** on give-up
   (F2) — "джоб завис, я его остановил, потрачено ~$X" is a much better
   "no dead end" experience than silence about cost. Size: S once F2's stop
   call exists (Browser Use's stop/status response likely includes cost).
4. **A `browser_task` "status" mode with no side effects**, for the model to
   check "is a run active for this tenant and on what task" without
   triggering a poll/charge — would let the model itself detect the F1/F4
   collision cases before calling the tool destructively. Size: S.

## 5. Open questions

- Does the Browser Use Cloud v4 API actually expose a stop/cancel endpoint
  for a run or session? Not verifiable from this repo (no such call exists to
  read as a reference) — needs checking against Browser Use's own API docs
  before implementing F2's fix.
- Whether `/internal/wakeup`'s HTTP handler (`agent/channels/imessage.ts`) and
  the `webhooks/imessage` handler in the same file actually share a Vercel
  serverless *instance* in practice (same function, same `wakeupDelivered`
  module-level `Map`) — this determines how *often* F3's duplicate-delivery
  window opens in practice (constant cross-instance duplication vs. only on
  cold starts / instance churn). Not decidable by reading source; would need
  the Vercel deployment config (`vercel.json` / function grouping) which is
  outside this slice's file list.
- Whether Browser Use Cloud's own run-level timeout (independent of
  `maxCostUsd`) ever kills a run on its own before 20-30 minutes — if so, F2
  is less severe in practice (Cloud self-terminates) but still leaves the
  "stale run answers the next errand" problem (F1/F2's second half) intact.
