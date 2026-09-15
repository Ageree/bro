# A2 — chat → live Cloud session injection (read-only audit)

## 1. Summary

The inject slice (`decideCloudInject` / `cloudSessionLooksLive` / `cdpTypeIntoPage` / `queueMessage`) is well
covered by `scripts/browser-inject-check.ts` and `scripts/browser-queue-check.ts` for the *happy path* (bare code
on a code page, «подожди», address correction). The holes are all at the *edges* the checks don't exercise:
staleness of "is this session actually still alive", messages that don't look like any of the three recognized
kinds, and messages that look like a code but aren't relevant to what's on screen.

The three worst holes:

1. **`cloudSessionLooksLive` has a pure-timeout fallback** (`now - startedAt < 20min`) that returns `true` with
   no check of run status, browser existence, or page — so a code sent minutes after the Cloud agent completed
   and its browser was recycled is still "injected" (queued into a dead/absent session, or a brand-new blank
   run), while Bro tells the human "код ушёл в живую Cloud-сессию." This is exactly the scenario the owner
   described (Cloud "stopped and gave a live URL" = the run is `completed`).
2. **Push/bank-app confirmations («подтвердил», «готово», «ок») are not recognized as inject candidates at
   all** — `injectCandidate()` only tests for a numeric code, a wait-phrase, or an address/size correction. A
   Cloud agent parked on "подтвердите вход в приложении" never gets resumed; this is a silent dead end, not a
   flaky one.
3. **A bare short number is always treated as an OTP code** once any Cloud errand is "live" by (1)'s loose
   definition, and the relevance gate falls back to "is this any Bro Cloud task" when the current page URL
   can't be read — so a price, a quantity, or a partial address number typed as a short reply gets typed into
   a random input field and/or queued to the Cloud agent as "here is the one-time code."

None of these are covered by the existing check scripts (they all assert the model-facing behavior on inputs
the classifiers were designed for, not on stale-session or off-domain inputs).

## 2. Findings

### F1 — P0 — `cloudSessionLooksLive` reports "live" from elapsed time alone, independent of run/browser state
`convex/lib/browserInjectPolicy.ts:231-245`
```
export function cloudSessionLooksLive(opts: CloudInjectAttrs): boolean {
  if (!opts.sessionId && !opts.runId) return false;
  if (isActiveCloudStatus(opts.status)) return true;
  if (opts.browserListed) return true;
  if (opts.pageUrl && pageWaitsForCode(opts.pageUrl)) return true;
  const now = opts.now ?? Date.now();
  if (opts.sessionId && typeof opts.startedAt === "number" && now - opts.startedAt < SESSION_LIVE_MS) {
    return true;
  }
  return false;
}
```
**Scenario (owner's Yandex-Taxi walk-through, step 1):** the Cloud agent reaches `passport.yandex.ru`, needs an
SMS code, and — per its own scaffold (`agent/lib/browseruse.ts:148-149`, `errandLoginBlock`) — "Код из SMS,
почты или пуш — остановись и дай live-URL." Stopping means the run's *status becomes terminal*
(`completed`, see `isTerminal` in `agent/lib/browseruse.ts:529-533`). `browser_task`'s `settle()`
(`agent/tools/browser_task.ts:334-352`) sees `isTerminal(run.status)`, cancels the wakeup and the follow-through
workflow, and returns "Send these results to the human now. Do not start another search."
(`agent/tools/browser_task.ts:96-101`). At this point Browser Use Cloud is free to tear the browser down.
The human then texts «482913». `maybeInjectChat` (`agent/tools/browser_task.ts:106-290`) tries to hydrate the
run and list the browser (`findBrowserForSession`); if either is already gone (cleaned up, or the CDP `/json`
call errors), `browserListed=false`, `pageUrl` falls back to whatever `hydrate()` last knew (a *first-seen* URL
from `pageUrlFromEvents`, `convex/lib/browserLivePolicy.ts:266-276` returns `urls[0]`, not the latest), which is
very often **not** a code-waiting URL. With `status="completed"` and `browserListed=false` and `pageUrl` not
code-shaped, the only thing keeping `cloudSessionLooksLive` `true` is the bare `now - startedAt < 20min` clause.
**The function was designed to say "the browser is still around," but it can say `true` purely because the wall
clock hasn't hit 20 minutes, with zero evidence the browser exists.**

**Why:** the 20-minute clause is documented as "A V4 Cloud browser is eligible for cleanup after ~20 min without
run activity" (line 226-228) — i.e. it's meant as an upper bound on staleness, not a substitute for a liveness
check. But it is `OR`-ed with the real signals instead of gating them, so it can fire alone.

**Consequence:** `decideCloudInject` proceeds to `codeRelevantToSession` (line 247-258), which independently
accepts via `resultWaitsForCode` (the stored "Needs user input: код…" result text, still present after
completion) — so the code path is taken. `queueMessage(sessionId, …)` (`agent/lib/browseruse.ts:330-354`) is
POSTed against a session that may no longer have a browser. Depending on the Cloud API's behavior this either
errors (see F2) or spins up a **brand new run in a fresh, contextless browser** that receives only the short
follow-up text ("Введи его в поле кода на уже открытой странице… Не открывай новый сайт" — but there is no open
page), producing a confusing/no-op result while Bro has already told the human "код ушёл в живую Cloud-сессию."

**This same loose check is reused, with even less information, at the instruction-steering layer:**
`agent/instructions/jobs.ts:63-72` calls `cloudSessionLooksLive({status, sessionId, runId, startedAt,
storedTask})` — **without `pageUrl`, `browserListed`, or `result`** — purely to decide whether to tell the model
"there is a live session, first bubble «ввожу код», call browser_task" vs. "say there's no session." So the
model itself is told the session is live under the same false-positive conditions, before the tool call even
happens.

**Proposed fix:** require the elapsed-time clause to be an upper bound alongside a real signal, not an
independent `true`, e.g.:
```
if (opts.browserListed) return true;
if (opts.pageUrl && pageWaitsForCode(opts.pageUrl)) return true;
if (isActiveCloudStatus(opts.status)) return true;
// terminal status: only "live" if recently completed AND we still have no reason to think the browser is gone
if (isDoneCloudStatus(opts.status) && opts.browserListed !== false) return false; // browserListed explicitly checked and absent → dead
```
More robust: make `maybeInjectChat` treat "browser not listed" as authoritative once it has actually tried
`findBrowserForSession` (it already always calls it) — i.e. drop the `startedAt` fallback whenever
`browserListed` was explicitly probed and came back `false`, and only keep the timeout fallback for the case
where `findBrowserForSession` itself threw (network error, not "confirmed absent"). Also pass `pageUrl`/`browserListed`
into the `jobs.ts` steer call so the instruction layer doesn't independently diverge.

**Check:** extend `scripts/browser-inject-check.ts` with a case: `status: "completed"`, `browserListed: false`
(explicitly probed, not merely absent), `pageUrl` a non-code page (or none), within `SESSION_LIVE_MS` →
`cloudSessionLooksLive` must be `false`.

---

### F2 — P0 — the "code delivered" hint is returned even when `queueMessage` failed
`agent/tools/browser_task.ts:219-235`
```
const codeHint =
  "код ушёл в живую Cloud-сессию (открытая вкладка). Не цитируй цифры и не проси пароль.";
const otherHint = "уточнение ушло в живую Cloud-сессию. Не проси пароль.";
const hint = decided.kind === "code" ? codeHint : otherHint;

if (!queued) {
  // CDP typing may still have entered the code; report best-effort state.
  return {
    status: tenant.browserStatus ?? "running",
    entered: typed,
    injected: decided.kind,
    typed,
    submitted,
    alreadyNotified: Boolean(conv),
    hint,
  };
}
```
`hint` is computed *before* the `if (!queued)` branch and reused unchanged inside it. `queued` is only falsy when
`queueMessage(...).catch(...)` swallowed a thrown error (line 212-217) — i.e. **the queue POST failed** (e.g.
because the session/browser is gone, per F1). The tool result the model sees still says "код ушёл в живую
Cloud-сессию" — the opposite of what happened. The model has no signal to distinguish this from success other
than `typed`/`submitted` (CDP-only, usually `false` in the same failure mode since the browser is gone too), and
nothing in the returned object says "the queue call itself failed."

**Consequence:** the human is told (via the model, which just paraphrases the hint) that the code was delivered
in a case where it demonstrably was not — one of the "no dead ends" failure modes the owner is worried about,
except worse: it *looks* handled.

**Fix:** branch the hint text on `queued`:
```
const hint = !queued
  ? "не удалось передать код в Cloud-сессию — скажи человеку, что сессия недоступна, предложи войти заново"
  : decided.kind === "code" ? codeHint : otherHint;
```
**Check:** `scripts/browser-queue-check.ts` already stubs `fetch`; add a case where `/sessions/.../queue` 404s
and assert the returned `hint` does **not** contain "ушёл" / claim success.

---

### F3 — P0 — a push/bank-app confirmation is not an inject candidate at all
`convex/lib/browserInjectPolicy.ts:297-303` (`injectCandidate`), used by `agent/tools/browser_task.ts:116`:
```
export function injectCandidate(text: string): boolean {
  return (
    isChatCodeMessage(text) ||
    isWaitInject(text) ||
    looksLikeCorrectionText(text)
  );
}
```
`isChatCodeMessage` needs a 4-8 digit run; `isWaitInject` needs `WAIT_HEAD` (`подожди|погоди|стой|wait|...`,
line 39-40); `looksLikeCorrectionText` needs `CORRECTION` (address/size/ПВЗ words) or a `STREET_LINE` shape. None
of these match «подтвердил», «подтвердил вход», «готово», «одобрил», «ок» — the exact words a human sends after
tapping "confirm" on a bank push or Yandex "подтвердите вход в приложении."

**Trace:** `maybeInjectChat` (`agent/tools/browser_task.ts:106-116`) returns `null` immediately
(`if (!injectCandidate(incoming)) return null;`), so the tool call falls straight through to the normal
`nextBrowserAction` branch with `task = "подтвердил"` — `looksLikeNewJob("подтвердил")` is false and
`isDoneStatus`/`isActiveStatus` decide `poll`/`reuse`/`start` with no reference to the confirmation at all; no
`queueMessage`/CDP call ever happens. The Cloud agent, parked mid-run waiting on the push, is **never told the
human approved it** — it will eventually time out (`convex/browserFollow.ts` `pollGiveUp` after
`POLL_GIVE_UP_MS` = 20 min) and the follow-through workflow gives up (`phase: "giveup"`), even though the human
did their part within seconds.

This is also not reachable through `agent/instructions.md`'s OTP section (`agent/instructions.md:78-88`): point 7
says "3-D Secure / банк-приложение / push — liveUrl, не OTP из почты. Код из чата всё равно вводи в вкладку" —
i.e. it assumes the push flow always eventually surfaces as a *code*, not a plain confirmation word, so the
instructions never anticipate «подтвердил» either.

**Fix:** add a fourth `CloudInjectKind = "confirm"` with a `PUSH_CONFIRM` regex (`подтвердил|одобрил|approved|
готово|нажал подтвердить|подтверд.*вход|готов[оа]?\b` guarded the same way `WAIT_HEAD` is — head-anchored, not a
substring match, to avoid catching "готово" as a general acknowledgement of something else). Queue text: "Человек
подтвердил вход в приложении/push со своего телефона. Проверь, продвинулся ли экран после подтверждения, и
продолжи поручение." First bubble: `CHAT_INJECT_ACK` ("ввожу") is fine, or a dedicated "принял подтверждение."
Do **not** attempt CDP typing for this kind (nothing to type) — just queue.

**Check:** add to `scripts/browser-inject-check.ts`: `injectCandidate("подтвердил")` and `injectCandidate("готово")`
must become `true` once the fix lands; `decideCloudInject("подтвердил", liveRun).kind === "confirm"`.

---

### F4 — P0 (session live) / P1 (session terminal-but-flagged-live per F1) — a bare short number is always a "code," and the relevance gate degrades to "any live Bro task"
`convex/lib/browserInjectPolicy.ts:115-128` (`isChatCodeMessage`) + `:247-258` (`codeRelevantToSession`):
```
export function isChatCodeMessage(text: string): boolean {
  ...
  const extra = t.replace(/\d/g, "").replace(/[\s:.\-–—]/g, "").replace(/ё/gi, "е").toLowerCase();
  if (!extra || CODE_WRAPPER.test(extra)) return true;   // <-- bare digits always qualify
  return /код|otp|sms|смс|пуш|push/i.test(t);
}
...
function codeRelevantToSession(opts: CloudInjectAttrs): boolean {
  if (pageWaitsForCode(opts.pageUrl)) return true;
  if (resultWaitsForCode(opts.result, opts.storedTask)) return true;
  if (isLoginWaitTask(...) || isLoginVaultTask(...)) return true;
  if (opts.pageUrl && !pageWaitsForCode(opts.pageUrl)) return false;
  return isBroCloudTask(opts.storedTask);   // <-- fallback when pageUrl is simply unknown
}
```
**Scenario (Q4 "price 1500 руб"):** `extractChatCode("1500")` — `digitsOnly = "1500"`, 4 digits, not a year →
returned as a code (`browserInjectPolicy.ts:100-103`). `isChatCodeMessage("1500")`: `extra` is empty after
stripping digits → `!extra` is `true` → returns `true` unconditionally, **regardless of what "1500" means in
context.** (The guarded form "1500 руб" is correctly rejected — `extra = "руб"` fails both the wrapper check and
the `код|otp|...` check — but the bare number is not.)

If any Cloud errand is currently "live" (including via F1's false positive), `codeRelevantToSession` is reached.
`pageUrl` is frequently unavailable in practice (CDP `/json` fetch can fail transiently, or `hydrate()`'s events
call can 404/empty — both are `.catch(() => undefined)`'d away throughout `browser_task.ts`/`browseruse.ts`).
When `opts.pageUrl` is `undefined`, the guard `if (opts.pageUrl && !pageWaitsForCode(opts.pageUrl)) return false;`
does **not** trigger (falsy `pageUrl` short-circuits it), so the function falls through to
`isBroCloudTask(opts.storedTask)`, which is `true` for **any** `[bro-errand]`-tagged task
(`convex/lib/browserInjectPolicy.ts:215-224`) — i.e. any errand at all, not specifically one waiting on a code.

**Concrete failure:** human is mid-errand (e.g. taxi is booked, driver is on the way, Bro is idle-polling), and
answers an unrelated question with a short number — "3" (how many bags), "1500" (a price someone asked about),
a partial house number. If `pageUrl` couldn't be read that turn, this gets typed via `cdpTypeIntoPage` into
whichever visible input scores highest on the currently open page (see F6) and is queued to the Cloud agent as
"Одноразовый код для входа (не пароль сайта, не цитируй): 1500. Введи его в поле кода… и подтверди вход." —
actively steering the Cloud agent to type "1500" into a login/code field and click confirm.

**Fix:** tighten the fallback — `isBroCloudTask` alone is too broad for a *contextless* bare-digit message.
Require `isLoginWaitTask`/`isLoginVaultTask` (already checked above it) **or** a persisted "waiting for code"
signal (see Idea below) before accepting a bare-digit code when `pageUrl` is unknown; only accept the loose
`isBroCloudTask` fallback when the message also carries an OTP keyword (i.e., merge with the
`isChatCodeMessage` "extra" check — a message that says nothing but digits should require *some* corroborating
live signal, not just "an errand exists").

**Check:** add to `scripts/browser-inject-check.ts`: `decideCloudInject("1500", {...liveRun, pageUrl: undefined,
result: undefined}).kind` should be `null` (or require a stronger signal), where today it is `"code"`.

---

### F5 — P1 — two digit-runs in one message silently drops the code (false negative, no feedback)
`convex/lib/browserInjectPolicy.ts:94-113` (`extractChatCode`):
```
const found: string[] = [];
const re = /\b(\d{4,8})\b/g;
while ((m = re.exec(normalized))) { ... if (!found.includes(code)) found.push(code); }
return found.length === 1 ? found[0] : null;
```
**Scenario (Q4):** the human pastes the SMS verbatim, e.g. "Ваш код 482913, не сообщайте его никому. Заказ
55081234." — or simply "код 482913, а ещё сколько стоит доставка 350 руб" (350 is 3 digits, safe, but a 4+ digit
order/tracking number in the same text is common). Two qualifying digit runs → `found.length === 2` → `null` →
`isChatCodeMessage` is `false` → `injectCandidate` is `false` → **the whole message is treated as ordinary
chat.** No inject, no `NO_LIVE_RUN_TEXT`, no ack — the human gets whatever the model says about the *rest* of
the message (if anything) and has no idea the code wasn't picked up.

**Fix:** when there are exactly one high-confidence candidate (immediately preceded/followed by "код"/"code"/
"otp"/"sms"/"пуш" within a few characters, mirroring `otp-policy.ts`'s `OTP_HINT`-anchored extraction which
already exists for the mailbox path) prefer that one instead of bailing to `null`. `agent/lib/otp-policy.ts`
already has a working pattern for this disambiguation (`extractOtpCodes` + context window check against
`ORDERISH`, lines 96-119) — reuse/port that logic into `extractChatCode` instead of maintaining a second, weaker
copy.

**Check:** `scripts/browser-inject-check.ts` — add `extractChatCode("код 482913, заказ 55081234") === "482913"`.

---

### F6 — P1 — CDP typing can land in the wrong (non-OTP) field when only one input is visible
`agent/lib/browser-cdp.ts:162-175`:
```
const boxes = inputs.filter((el) => el instanceof HTMLInputElement && el.maxLength === 1);
let typed = false;
if (boxes.length >= 4 && boxes.length <= 8 && /^\d+$/.test(value)) { ... }
else {
  const ranked = [...inputs].sort((a, b) => score(b) - score(a));
  const target = ranked[0];
  if (target && (score(target) > 0 || document.activeElement === target || ranked.length === 1)) {
    setValue(target, value);
    typed = true;
  }
}
```
`ranked.length === 1` types into the sole visible input **unconditionally**, even with `score(target) === 0`.
Combined with `pageWaitsForCode` (`convex/lib/browserInjectPolicy.ts:181-204`) treating **any** path on a
`passport.*`/`id.*` host as code-waiting (`host.startsWith("passport")` is checked unconditionally, not just as
part of the `identity` gate — so the *password* step of `passport.yandex.ru` also satisfies `pageWaitsForCode`),
this is Q3's "code arrives before Cloud asked for it" case made concrete: if the human proactively forwards the
SMS while Cloud is still on the single-field phone/login step of the passport flow, the code gets typed into
that field (password inputs are excluded by type, but a login/phone field is not).

**Fix:** drop the `ranked.length === 1` escape hatch, or restrict it to inputs whose `type` is `tel`/`text` *and*
`autocomplete` is empty/`one-time-code`-ish (i.e. don't override a `0` score just because it's the only input —
require at least a weak positive signal, e.g. `document.activeElement === target` alone, dropping the bare
`ranked.length === 1` clause).

**Check:** add a `browser-cdp` unit-ish check (there is no offline DOM check today — this logic only lives
inline as a string executed via `Runtime.evaluate`, untestable without a DOM). Recommend extracting
`TYPE_INTO_PAGE`'s scoring function into a plain, importable module tested with `jsdom` or a hand-rolled fake DOM
so `scripts/browser-inject-check.ts` (or a new `browser-cdp-check.ts`) can assert on scoring decisions directly
instead of only `assert(cdp.includes("password"))`-style string checks (current check, lines 348-352, only
greps for substrings).

---

### F7 — P2 — multi-box OTP UI with a progressively-revealed box set is mistyped
`agent/lib/browser-cdp.ts:162-166`. The box-fill branch requires `boxes.length >= 4` among **currently visible**
`maxLength===1` inputs. Sites that reveal box 2-6 only after box 1 is filled (common JS-driven OTP widgets) start
with `boxes.length === 1`, missing the `>=4` branch; the single-input branch then calls
`setValue(target, "482913")` on a `maxLength=1` box. `maxlength` is not enforced by browsers for a programmatic
`.value =` assignment (only for user keystrokes), so the box silently receives the whole 6-digit string and the
site's own paste-splitting JS (which normally listens for an `input` event to redistribute pasted digits across
boxes) may or may not trigger correctly depending on how it's wired — this is a real, plausible mistype with no
error surfaced (`typed: true` is still returned).
**Fix:** when `setValue` targets a `maxLength===1` box, truncate to 1 char and dispatch a `paste`-shaped event
(or a synthetic `beforeinput`) that better mimics the framework's expected input path; alternatively, retry the
box-count check after a short delay if `boxes.length` is `1` and the value is longer than 1 char.
**Check:** same recommendation as F6 — extract the scoring/typing function for isolated testing.

---

### F8 — P2 (documentation, not a bug) — CDP typing is structurally blind to iframes (3-D Secure)
`agent/lib/browser-cdp.ts` `openCdpPage`/`cdpTypeIntoPage`: `Runtime.evaluate` is called against the single
top-level `page`-type CDP target only (`pickCdpPage`, `convex/lib/browserCdp.ts:47-49`); there is no
`Target.getTargets`/`Page.createIsolatedWorld` traversal into an iframe's own execution context. 3-D Secure ACS
challenge pages and most bank in-app push confirmation widgets are near-universally cross-origin iframes, so
`document.querySelectorAll("input, textarea")` never sees their fields — `cdpTypeIntoPage` will correctly return
`typed: false` (safe: no misfire), silently doing nothing. Since the "reliable path" is `queueMessage` to the
real Cloud LLM (which, being a full browser-use agent, *can* interact with iframes), this is not a functional
gap today, but worth documenting explicitly (and in F3's fix, since `confirm`-kind messages have nothing for CDP
to type into anyway) so nobody "fixes" the CDP no-op without realizing it's iframe-related and inherent.
**No fix needed** beyond a code comment; no check needed beyond F6/F7's DOM-testable extraction (which would
also make this documented behavior explicit in a test).

---

### F9 — P0 (confirmed mechanism) / open question (end-to-end effect) — background wakeups (browser_poll "done"/"giveup") are only ever addressed to the iMessage conversation
`convex/tenants.ts:504-535` (`claimBrowserWakeup`):
```
return {
  ok: true as const,
  conversationId: existing.inkboxConversationId,
  inkboxHandle: existing.inkboxHandle,
};
```
This is the **only** place `convex/browserFollow.ts`'s `wakeupAgent` (line 356-395) gets a `conversationId` from;
it is always `tenant.inkboxConversationId` — never `telegramChatId`/`photonConversationId`, and never gated on
`tenant.lastChannel`. `agent/channels/telegram.ts` registers **no** `/internal/wakeup` route at all (confirmed by
grep — zero matches for `wakeup` in that file), so every background wakeup (`browser_poll`, `brief`, `watcher`,
`job_check`, `event`) is posted to eve as `from(conversationId).send(...)` where `conversationId` is always the
iMessage-side id (`agent/channels/imessage.ts:729`).

**Relevance to Q5:** the *immediate* inject ack (`injectAckText`, e.g. «ввожу код») **is** routed correctly to
whichever channel the human is currently texting from — `maybeInjectChat` builds `notify.attrs` from
`attrsFromSession(ctx.session)` (the *current* turn's auth attributes) and calls `deliverHumanRouted`
(`agent/lib/deliver-routed.ts:29-49`), whose `routingFromAuth` (`agent/lib/turn-routing.ts:20-52`) picks
`telegram` when the current turn's attributes say so. So: human starts an errand in iMessage, later sends the
OTP correction in Telegram → the "ввожу код" ack correctly appears in Telegram.

**But** the *eventual* "done"/"failed" message, delivered minutes later by the `browserFollow` workflow via
`wakeupAgent` → `/internal/wakeup` → a fresh model turn with **only** `{conversationId: <inkboxConversationId>,
origin: "wakeup", wakeupKind: "browser_poll"}` as auth attributes (`agent/channels/imessage.ts:736-739`) — has no
Telegram-identifying attribute at all. If the model's own visible reply for that turn is delivered through
whatever transport is bound to `conversationId` at the protocol/session level (as opposed to being explicitly
re-routed via `deliverHumanRouted`/`tenant.lastChannel`, the way the manual acks in `browser_task.ts` are), it
would go out over iMessage regardless of the human's current Telegram-side conversation. I could not confirm
from this repo (eve's session/`from()` transport binding lives outside `agent/`) whether the model's plain-text
reply on a wakeup turn is (a) auto-delivered via the iMessage transport tied to that `conversationId`, or (b)
resolved again through `tenant.lastChannel` at send time the way manual `deliverHumanRouted` calls are. **This is
listed as an Open Question below** because it is the difference between "cosmetic, wrong-channel notification"
and "channel-correct" — but the input to the decision (`claimBrowserWakeup` always returning the iMessage
conversation id, never checking `lastChannel`) is a confirmed, citable fact either way, and is inconsistent with
how the immediate ack is routed.

**Proposed fix (regardless of the answer):** make `claimBrowserWakeup` (and the `job_check`/`brief`/`watcher`/
`event` wakeup paths, which share the same mechanism) select the conversation id consistent with
`tenant.lastChannel` — e.g. when `lastChannel === "telegram"`, still deliver the wakeup *content* through a path
that ends in `deliverHumanRouted`-style channel resolution rather than relying on the wakeup's own
`conversationId` for anything other than resuming the eve session/history.

**Check:** none today directly test cross-channel wakeup delivery; `scripts/wakeups-check.ts` should gain a case
asserting that a wakeup for a `lastChannel: "telegram"` tenant results in a Telegram-routed delivery (would
currently need a stubbed `deliverHuman`/telegram sender to observe).

---

### F10 — P1 — no code-level guard against a password-shaped `task` reaching Browser Use Cloud
`agent/tools/browser_task.ts:447-644` (`execute`). `looksLikePasswordDump` (`convex/lib/browserInjectPolicy.ts:83-88`)
is only consulted inside the *inject* candidates (`isChatCodeMessage`, `isWaitInject`, `looksLikeCorrectionText`
each explicitly exclude it) — i.e. it protects the "type into the live tab" path. It is never checked against
the tool's own `task` argument before `startRun(task, ...)` → `scaffoldTask(task, ...)` interpolates the raw
string into `Задача: ${task}` (`agent/lib/browseruse.ts:203-210`), which is POSTed verbatim to the third-party
Browser Use Cloud API. If the model ever calls `browser_task` with a password-shaped string as `task` (e.g. it
misreads a human's pasted password as an errand description, or a downstream bug feeds raw input through), there
is **no code-level backstop** — the guard against leaking a password lives entirely in `agent/instructions.md`'s
Trust section prose, not in the tool itself, unlike the inject path which has both a prompt instruction *and* a
policy-level `looksLikePasswordDump` check.
**Fix:** add `if (looksLikePasswordDump(task)) return { status: "invalid", hint: "site password, not a task" }`
(or similar) as a defense-in-depth check at the top of `execute()`, mirroring the inject path's guard.
**Check:** add to `scripts/browser-inject-check.ts` or a small addition in `browser-policy-check.ts`.

---

### F11 — P2 — `NO_LIVE_RUN_TEXT` doesn't offer the obvious next action
`convex/lib/browserInjectPolicy.ts:19-20`:
```
export const NO_LIVE_RUN_TEXT =
  "Сейчас нет открытой сессии в браузере, которая ждёт этот код. Если нужно войти заново — напиши.";
```
This is reasonable and already password-safe (asserted by the check), but it puts the burden back on the human
("напиши" — write [what, exactly?]) instead of proactively offering the retry the owner's "no dead ends" goal
implies. **Suggested wording:** "Сейчас нет сессии, которая ждёт этот код — она уже закрылась. Если нужно,
попробую войти заново, скажи куда/во что." or, better, have the model (per `cloudInjectInstruction`'s "code,
not live" branch, `browserInjectPolicy.ts:326-329`) proactively offer to re-run the last errand rather than
just stating the absence.

---

### F_extra — P1 — fast-ack lane can fire a status bubble for a bare OTP code with no idea a Cloud session exists
`agent/lib/fast-ack.ts:26-75` (`shouldFastAck`). For an inbound message that is just digits (e.g. «482913»):
`shouldFastAck` returns `true` (not empty, not `isShortAck`, not `[`-prefixed, `<=600` chars) — so the tiny
no-context fast-ack model (`FAST_ACK_SYSTEM`, lines 49-56) is asked to judge it with **no examples for bare
digits** and, critically, **no information about whether a Cloud session is even open** (the fast-ack lane runs
in the webhook, before `browser_task`/`decideCloudInject` ever sees the message). Two failure modes:
1. If it emits a plausible-looking status phrase (its few-shot examples are all "action verb + noun," so a
   6-digit string is out-of-distribution and the model could latch onto something like "проверяю" or "ввожу
   код" per pattern-matching), the human sees a status bubble *before* the real turn determines there is no
   live session — and when the real turn then says `NO_LIVE_RUN_TEXT`, the earlier bubble is left uncontradicted
   and confusing.
2. Conversely if there genuinely IS a live session waiting on this code, a fast-ack of "ищу…" or similar is
   simply wrong framing (Bro isn't "looking," it's entering a code) — cosmetically inconsistent with the "ввожу
   код" ack the real turn sends moments later (`CHAT_CODE_ACK`, `browserInjectPolicy.ts:15`), risking two
   different-looking first bubbles for the same action if `turnSpoke` bookkeeping doesn't line up (it should
   dedupe via `peelFastAck`/`turnSpoke`, but that logic works on *text characters*, not intent — "ищу" and
   "ввожу код" don't overlap enough for `peelFastAck` to merge them, so a human could see both).
`sanitizeFastAck`'s `>=5 digits → null` rule (`fast-ack.ts:120`) prevents the model from echoing digits back, but
does nothing to prevent a wrong *word* being sent.
**Fix:** make `shouldFastAck` return `false` for a message that `isChatCodeMessage`-shaped (bare-digit or
digit+code-keyword) — the fast-ack lane has no way to know whether a code is relevant, so it should defer to the
real turn entirely for anything that looks like a one-time code, same as it already defers for `[`-prefixed
system-injected text.
**Check:** `scripts/latency-check.ts` (owns `fast-ack`-adjacent checks per the earlier grep) or a new assertion
in a fast-ack check: `shouldFastAck("482913") === false`.

## 3. Ideas

### Idea 1 — Persistent pending-input state on the tenant (`browserWaitingFor`)
**What:** add to the tenant row (alongside the existing `browserRunId`/`browserStatus`/`browserTask`/etc.):
```
browserWaitingFor: "code" | "push" | "3ds" | "captcha" | undefined
browserWaitingSince: number | undefined
```
**Why:** today "is this session waiting on a human input, and for what" is *reconstructed* on every message from
regexes over `result` text, `pageUrl` host/path, and a task-string prefix (`OTP_RESULT`, `pageWaitsForCode`,
`isLoginWaitTask` — three independent guesses that have to agree, and that degrade to "any live task" the moment
one of the inputs (typically `pageUrl`) is unavailable — this is F4's root cause). A single persisted field,
set once when the Cloud agent's own stop reason is unambiguous, removes the guessing:
- **Set** `browserWaitingFor = "code"` in `convex/browserFollow.ts`'s `pollRun` (or in `browser_task.ts`'s
  `settle()`/`persist()`) whenever a *terminal* run's `result` matches the existing `OTP_RESULT`/`isOtpChallenge`
  pattern, or whenever `pageUrl` at hydrate-time matched `pageWaitsForCode`. Set `"push"` when the result/page
  matches a push/3-D-Secure signature (bank app names, "подтвердите вход в приложении", ACS iframe host list).
  Set `"3ds"` specifically when the page host is a known ACS/bank-challenge domain (can start with a small
  allow-list, same shape as `PREVIEW_HOSTS` in `browserLivePolicy.ts`). Set `"captcha"` when the result text
  matches a captcha-refusal phrase (Cloud's own scaffold already says "если сайт требует капчу — пропусти", so a
  captcha stop is distinguishable from an OTP stop in the result text).
- **Clear** it as soon as: (a) a code/push-confirm/correction is successfully queued (`maybeInjectChat`'s success
  path), (b) the run transitions to a new non-terminal status (Cloud resumed on its own), or (c) `reset` starts
  a fresh run.
- **Use it in `decideCloudInject`/`codeRelevantToSession`:** replace the `isBroCloudTask(storedTask)` fallback
  (F4) with `opts.waitingFor === "code"`; a bare-digit message is only accepted as a code when the tenant is
  actually recorded as waiting for one — independent of whether `pageUrl` could be freshly read this turn. This
  directly fixes F4 without needing a live CDP round-trip on every ambiguous message.
- **Use it in the `agent/instructions/jobs.ts` steer** to phrase the system instruction precisely ("there is a
  live session waiting for a push confirmation" vs. generic "there is a live session"), and to unlock F3's new
  `confirm` kind only when `waitingFor === "push"`.
- **Use it for Idea 2** (below) and for the `[background wakeup] browser_poll` prompt (`agent/channels/imessage.ts:702`,
  Q8) — the wakeup prompt currently *asks the model to guess* ("если человек уже прислал код и он ещё не
  введён"); with `browserWaitingFor` persisted, the wakeup prompt can instead say precisely what is being waited
  on, and — combined with Idea 3 — whether it was already supplied.

**Size:** M. Touches: `convex/schema.ts` (new optional tenant fields), `convex/tenants.ts` (a small
`patchBrowserWaiting`-style internal mutation, mirroring the existing `patchBrowserInternal`), `convex/browserFollow.ts`
(`pollRun` sets it), `agent/tools/browser_task.ts` (`settle`/`persist` sets/clears it, `maybeInjectChat` reads
it), `convex/lib/browserInjectPolicy.ts` (`codeRelevantToSession` takes `waitingFor` instead of/alongside
`storedTask`), `agent/instructions/jobs.ts` (steer text), `scripts/browser-inject-check.ts` /
`scripts/wakeups-check.ts` (new cases).

### Idea 2 — Automatic mailbox OTP for Cloud sessions (answers Q9)
**What:** `otp_lookup`/`findFreshOtp` (`agent/lib/otp-lookup.ts`) already finds fresh OTP codes in Bro's own
mailbox (`agent/tools/otp_lookup.ts`), but per its own description ("Pass the code only to the waiting
worker...") and every call site found (`scripts/otp-check.ts`, `agent/subagents/otp/**`, `agent/tools/bro_mail.ts`),
it is wired **only** into the `worker` (Kernel/Playwright) flow — never into `browser_task`/`browserFollow`. Yet
the Cloud scaffold (`agent/lib/browseruse.ts:149`, `errandLoginBlock`) tells the Cloud agent to stop and give a
live URL for *any* code — SMS, email, **or push** — with no distinction, even though an email OTP sent to Bro's
own mailbox needs no human at all.
**Why:** this is a direct, code-confirmed instance of the owner's "holes in доводка" pain point — Bro has the
capability to read the code himself and doesn't use it for the one flow (Cloud) that most needs it, forcing an
unnecessary live-URL round trip to the human for something fully automatable.
**Sketch:** when `convex/browserFollow.ts`'s `pollRun` detects a terminal run whose result matches
`isOtpChallenge`/`OTP_RESULT` (i.e., about to set `browserWaitingFor: "code"` per Idea 1) *and* the challenge
looks email-shaped (result mentions "почт"/"email"/"mail", or the site is one that's typically emailed, as
opposed to "push"/"смс" wording which can't be resolved this way), have `wakeupAgent` fire a **distinct** wakeup
kind (e.g. `browser_otp_email`) whose prompt tells the model to call `otp_lookup` *first*, and if found, call
`browser_task` with that code exactly as if the human had sent it (reusing the existing `injectQueueText`/`code`
kind path end to end) — only falling back to "ask the human" (today's behavior) when `otp_lookup` comes back
`missing`/`ambiguous`. This requires no new browser-side plumbing — `maybeInjectChat`'s code-kind path already
does everything needed once it has a `code` string; the only new wiring is *where the code string comes from*
for this one wakeup kind.
**Size:** M. Touches: `convex/browserFollow.ts` (detect email-shaped OTP stop, new wakeup phase/kind or payload
flag), `agent/channels/imessage.ts` (new wakeup prompt branch), `agent/tools/otp_lookup.ts`/`otp-lookup.ts` (no
change — reused as-is), `scripts/otp-check.ts` / `scripts/browser-inject-check.ts` (new integration case).

### Idea 3 — Explicit "already supplied, not yet applied" marker (answers Q8)
**What:** when `maybeInjectChat` successfully classifies and queues a code/confirm/correction but `resolveQueuedRun`
can't yet confirm the Cloud agent actually consumed it (e.g. `queued` succeeded but the resolved run is still
`pending`), persist a short-lived `browserPendingInject: {kind, text, queuedAt}` alongside `browserWaitingFor`.
Clear it once the next poll shows the run moved past the wait (`browserWaitingFor` cleared, or status changes).
The `[background wakeup] browser_poll` prompt (`agent/channels/imessage.ts:702`) can then be generated
deterministically ("человек прислал код 482913 в 21:04, он поставлен в очередь, ещё не подтверждён — проверь
экран") instead of asking the model to infer this from chat history it may not fully have on a cold wakeup turn.
This also answers Q8's "is it dropped while a human turn is still running" concern less by chance: today, if the
human's code arrives while eve is mid-turn on a *previous* message, whatever serializes eve's turns per session
(outside this repo) determines whether it's queued or dropped; a persisted `browserPendingInject` at least makes
the *next* turn (whichever kind) self-sufficient regardless of ordering, rather than depending on the specific
turn that received the code to have fully completed its queueing steps before being interrupted.
**Size:** S–M, mostly riding on Idea 1's schema addition.
**Files:** `convex/schema.ts`, `convex/tenants.ts`, `agent/tools/browser_task.ts` (`maybeInjectChat`),
`agent/channels/imessage.ts` (`browser_poll` prompt text).

## 4. Open questions

1. **F9 (channel routing for background wakeups):** does eve's `from(conversationId).send(...)` for a
   `wakeup`-origin turn deliver the model's own plain-text reply through the transport bound to that specific
   `conversationId` (always iMessage, per `claimBrowserWakeup`), or does final delivery get re-resolved via
   `tenant.lastChannel` the same way `deliverHumanRouted` does for the manual acks in `browser_task.ts`? This
   determines whether a Telegram-primary human ever sees the *final* "готово"/"не получилось" message for a
   Cloud errand they've been correcting over Telegram, or whether it silently lands in iMessage instead. Not
   answerable from `agent/`/`convex/` alone — needs eve's session/transport internals.
2. **Browser Use Cloud's actual behavior on `POST /sessions/{id}/queue` against a session whose browser was
   already recycled:** does it error (as F2 assumes), silently no-op, or spin up a brand-new browser for a new
   run? This changes how bad F1's consequence actually is in practice (dead letter vs. confusing fresh-browser
   run) — not determinable from this repo, would need Browser Use Cloud's own docs/support or an integration
   test against the real API.
3. Whether `agent/instructions.md`'s OTP section point 7 ("push — liveUrl, не OTP из почты") is meant to imply
   the human is *expected* to reply with a code even for a push (i.e., "код из чата всё равно вводи в вкладку"
   might mean "if they happen to also have a code, use it," not "pushes always produce a code") — if so, F3's
   gap (push-only confirmations aren't recognized) is squarely a missed case rather than a misunderstanding of
   intent; I read it as the latter, but the instructions file itself doesn't disambiguate.
