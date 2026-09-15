# A4 — worker (Kernel) / otp subagent / browser_task↔worker hand-off audit

## Summary

`worker` and `browser_task` are two structurally different browsers with two
separate persistent profiles, two separate vault-injection mechanisms, and two
separate live-view UX flows. Most of the individual pieces (autofill origin
binding, screenshot masking, OTP text extraction, per-worker-assignment
billing) are careful and well-tested by their check scripts. The three worst
holes:

1. **`execute_playwright_code` has no protection against reading back a vault
   secret that `fill_from_vault` just typed.** The masking in
   `screenshot-mask.ts` only covers `computer_action` screenshots; Kernel's
   Playwright execution has full `page`/`context`/`browser` access and can
   trivially `.value` a masked field or dump `context.cookies()`. This is
   enforced only by a prompt instruction ("never inspect filled values"), not
   by code.
2. **A worker's Kernel browser cannot outlive its `timeout_seconds`, and
   Kernel's API has no way to extend it after creation** (`BrowserUpdateParams`
   has no timeout field at all). The default is the 15‑minute floor, nothing
   in the worker instructions tells the model to raise it before returning
   `Needs user input:` for an OTP, and the OTP wait path (mailbox lookup,
   `job_wait checkInMinutes=3`, possibly a slow human) can easily exceed 15
   minutes. Root then resumes a worker whose Kernel session is already gone.
3. **Root instructions literally route "3‑D Secure the cloud job cannot
   finish" to `worker`** (`agent/instructions.md:66`), but `worker`'s Kernel
   browser is a different browser/profile/session than the Cloud run showing
   the challenge — it cannot ever "finish" that specific 3DS flow (the bank
   ties the challenge to the exact browser/session/IP that initiated the
   payment). The only real fix is the Cloud run's own `liveUrl`, which the
   same instructions file already describes two lines earlier. This is a
   self-contradiction that can strand a live payment.

## Findings

### 1. [P0] `execute_playwright_code` can read back and exfiltrate vault-filled secrets

- `file:line`: `agent/subagents/worker/tools/execute_playwright_code.ts:1-58`,
  `agent/subagents/worker/tools/computer_action.ts:158-173`,
  `agent/subagents/worker/lib/screenshot-mask.ts:1-72`,
  `agent/subagents/worker/lib/autofill/native.ts:392-403,851-425` (marks
  `dataset.vaultSecret = "true"`, i.e. sets `data-vault-secret="true"` — a
  real DOM attribute, not a code-side redaction),
  `node_modules/.pnpm/@onkernel+sdk@0.97.0/.../resources/browsers/playwright.d.ts:9-13`
  ("has access to 'page', 'context', and 'browser' variables").
- What happens: worker fills a card/login field via `fill_from_vault`
  (Chromium native autofill over CDP). The card number, CVC, or password now
  sits as a real value in the page's DOM (`input.value`), and as real cookies
  in `context`. `withVaultScreenshotMask` only adds a CSS rule
  (`color:transparent`, `-webkit-text-security:disc`) around elements marked
  `data-vault-secret="true"`, and only wraps `computer_action`'s screenshot
  capture. `execute_playwright_code` runs arbitrary
  Playwright/TypeScript with full page access and is never wrapped by that
  mask. Nothing stops (accidentally, or via a prompt-injected page telling
  the model "confirm the card by printing it") code like
  `return await page.$eval('input[name=cc-number]', el => el.value)` or
  `return await context.cookies()`, which returns the plaintext secret in
  `result`, flows straight into the model's tool-call transcript (visible to
  the root coordinator, and from there potentially into a memo line or
  chat), truncated only at 12,000 characters
  (`boundedResult`, execute_playwright_code.ts:60-70) — no redaction.
- Why: the entire vault-secrecy guarantee for `execute_playwright_code` is a
  prompt instruction ("After injection, never read those fields... or return
  them through another tool" — `instructions.md:14`/SKILL.md:15) with zero
  enforcement in code. CSS masking (`-webkit-text-security`) changes
  rendering only; it never hides `.value`/`.innerText`/cookies from a script.
- Proposed fix (minimal, in repo style): add a pure allow-list check in
  `execute_playwright_code`'s `execute()` (or a wrapping helper next to
  `withVaultScreenshotMask`) that statically rejects code referencing
  `.value`, `context.cookies`, `document.cookie`, or `dataset.vaultSecret`
  after a `fill_from_vault` call was made on that session — at minimum,
  redact `result`/`stdout` for any string matching a live vault secret's
  known shape (card number/CVC pattern) before it reaches `toModelOutput`,
  the same way `boundedResult`/`truncate` already post-process the payload.
  Even a coarse regex + a "was fill_from_vault used this session" state flag
  closes the highest-value hole cheaply.
- Check script: extend `scripts/worker-check.ts` with a pure unit for the new
  redaction/guard function (it does not need a live Kernel browser to test a
  string-transform).

### 2. [P0] Kernel browser timeout cannot be extended, and the default (15 min) is shorter than a realistic OTP wait

- `file:line`: `agent/subagents/worker/tools/manage_browsers.ts:23,30-35,78-79`
  (`browserTimeoutFloorSeconds = 15*60`; `timeout_seconds: input.timeout_seconds ?? browserTimeoutFloorSeconds` — only read in the `create` branch),
  `manage_browsers.ts:149-157` (the `update` action only ever passes
  `{ viewport }`; `timeout_seconds` is accepted by the input schema but never
  forwarded to Kernel on update),
  `node_modules/.pnpm/@onkernel+sdk@0.97.0/.../resources/browsers/browsers.d.ts:1057-1100`
  (`BrowserUpdateParams` has no timeout/TTL field — Kernel's own API gives no
  way to extend a running session), `agent/lib/otp-policy.ts:2`
  (`OTP_CHECK_IN_MINUTES = 3`), `agent/skills/otp/SKILL.md:13` (`job_wait
  waitingFor=email, checkInMinutes=3`).
- What happens: worker hits an OTP wall, preserves the browser, and returns
  `Needs user input:` (per `instructions.md:16`/SKILL.md:24). If the model
  did not pass a larger `timeout_seconds` at `manage_browsers create` (nothing
  in `instructions.md` or `SKILL.md` tells it to), the Kernel browser is
  scheduled to die in 15 minutes. Root then calls `otp`/`otp_lookup`; if the
  letter hasn't arrived yet it does `job_wait waitingFor=email
  checkInMinutes=3` and re-checks every 3 minutes. A merchant/bank that is
  slow to send the code, or a human who is slow to notice an "ambiguous /
  missing" follow-up question, easily pushes the round trip past 15 minutes.
  When root finally resumes `worker` with `agentId` + the code, every
  worker tool call (`execute_playwright_code`, `fill_from_vault`,
  `computer_action`) hits a session ID Kernel has already deleted — the
  errand is a dead end, and the human already gave up their code for
  nothing.
- Why: (a) the model is never told to size `timeout_seconds` for an
  OTP-shaped task, and (b) even if it wanted to fix this after the fact,
  Kernel's API gives no lever to extend a live session's timeout — the
  `update` action in this codebase would have nowhere to send it even if it
  tried.
- Proposed fix: have `manage_browsers create` default to a larger floor when
  the assignment is known to risk an OTP/login wall (e.g. any assignment
  that is not a trivial one-shot lookup), or simplest: raise
  `browserTimeoutFloorSeconds` itself, and add one instructions line telling
  the model to pass a longer `timeout_seconds` (e.g. 30–45 min) whenever the
  task involves login/checkout/OTP. This is a policy choice
  (`browserTimeoutFloorSeconds`), so it belongs in the same pure-function
  style as `browser-policy.ts`.
- Check script: `scripts/worker-check.ts` — assert the default
  `timeout_seconds` passed to `kernel().browsers.create` for a
  login/OTP-shaped assignment is above some minimum (requires exposing the
  create-time default as a pure function first).

### 3. [P0] Root instructions route Cloud-side 3-D Secure to `worker`, which cannot resolve it

- `file:line`: `agent/instructions.md:66` ("`worker` is one-screen / CDP /
  3-D Secure the cloud job cannot finish.") vs `agent/instructions.md:61`
  ("`liveUrl` → login or 3-D Secure, not a re-approve.") and
  `agent/instructions.md:88` ("3-D Secure / банк-приложение / push — liveUrl,
  не OTP из почты."); `agent/subagents/worker/lib/kernel.ts:32-39`
  (`profileNameForTenant` — a Kernel profile keyed by phone hash, entirely
  separate from the Cloud profile in `convex/lib/browserProfilePolicy.ts`);
  `agent/tools/browser_task.ts:84-97` (`payload()` returns the Cloud run's
  own structured `liveUrl`).
- What happens: a Browser Use Cloud run reaches checkout and the bank shows a
  3-D Secure/OTP-app challenge inside the *Cloud* browser tab. Per
  `instructions.md:66`, the model may decide this is a case for `worker`
  ("the cloud job cannot finish") and delegate a bounded assignment to it.
  `worker` opens a brand-new Kernel browser with the tenant's Kernel profile
  (different cookies, different IP/proxy, different browser fingerprint) and
  navigates to the site fresh — it has no way to reach the exact in-flight
  bank challenge tied to the Cloud session that initiated the payment. Best
  case the model notices the mismatch and reports failure, burning a browser
  job and a user message ("захожу..."); worst case it logs the tenant into
  the *Kernel* profile and reports something misleadingly close to success
  while the actual Cloud payment is still stuck waiting for the 3DS approval
  that only the Cloud `liveUrl` can surface.
- Why: `instructions.md:66` was written to describe worker's own use cases
  (challenges *worker itself* hits inside its own Kernel session — a
  legitimate case, matching `browser-execution/SKILL.md:19,23`) but is worded
  as if it also covers the Cloud job's blockers ("the cloud job cannot
  finish"), directly conflicting with the correct routing already stated at
  lines 61 and 88 of the same file.
- Proposed fix: reword `instructions.md:66` to make explicit that `worker` is
  only for challenges *inside worker's own Kernel session*, never a stand-in
  for a Cloud run's `liveUrl`/3DS/CAPTCHA — e.g. "`worker` is a *second*,
  independent browser for one-screen/CDP tasks the Cloud job structurally
  can't do (its own site, its own login) — never to finish a challenge that
  appeared inside the *Cloud* tab; that is always the Cloud run's own
  `liveUrl`."
- Check script: none currently asserts on instruction text; consider a small
  lexical check in a new `scripts/instructions-check.ts` (or extend
  `browser-policy-check.ts`) that fails if `instructions.md` contains the
  phrase "3-D Secure the cloud job" without also asserting the correct
  `liveUrl` routing nearby — low value, mostly a doc fix.

### 4. [P1] Cloud profile and Kernel profile never share logins

- `file:line`: `convex/lib/browserProfilePolicy.ts:149+` (Cloud
  `cookieDomainsCoverPage`, `tenant.browserProfileId`),
  `agent/subagents/worker/lib/kernel.ts:32-39` (`profileNameForTenant`, a
  wholly separate Kernel profile store), `agent/tools/profile_setup.ts`
  (only ever touches the Cloud profile / vault `kind: login`), no code path
  anywhere shares a login or cookie between the two.
- What happens: (a) `profile_setup`/`browser_task` says "вход уже сохранён"
  (Cloud cookies cover the page) and skips the login step for a Cloud
  errand; a later `worker` assignment on the very same site sees a guest
  Kernel profile, hits the login wall, and returns `Needs profile sync` —
  the human is asked to log in *again*, on a browser they were just told was
  already signed in. (b) The reverse: a human completes a login through
  worker's own live-view (Kernel), but the next `browser_task` errand on
  that site still shows "Войти" because the Cloud profile never got those
  cookies, so Cloud logs in a second time (or asks for a second
  `profile_setup` round). Both directions produce a double-login experience
  the product vision explicitly wants to avoid ("no dead ends... no lost
  OTP codes").
- Why: two entirely independent persistent-profile systems by design (Cloud
  profile lives in `convex` tenant fields + Browser Use's own profile store;
  Kernel profile is a SHA-256'd name in Kernel's own profile store) with no
  cross-reference, and no instruction warns the model that a "logged in"
  signal from one browser says nothing about the other.
- Proposed fix: at minimum, add an instructions line making explicit that a
  Cloud "уже сохранён" does not imply worker is logged in (and vice versa),
  so the model doesn't act surprised or repeat vault typing needlessly; a
  deeper fix (size L) would track "logged in on {cloud, kernel} x {site}"
  per tenant so `worker`/`browser_task` can decide up front which browser
  already has the needed session instead of finding out mid-errand.
- Check script: `scripts/profile-sync-check.ts` currently likely only
  exercises the Cloud side (`browserProfilePolicy.ts`) — confirm it has no
  equivalent Kernel-side case, since none exists in code to test.

### 5. [P1] worker's `final_output` has no structured live-view field

- `file:line`: `agent/subagents/worker/agent.ts:5-8` (`taskCompletionSchema =
  { status, message }`), vs `agent/tools/browser_task.ts:84-97` (`payload()`
  returns a first-class `liveUrl` field alongside `status`/`hint`).
- What happens: when worker hits a CAPTCHA/3DS/passkey inside its own Kernel
  session and needs human takeover, the *only* place it can put the
  `browser_live_view_url` (from `manage_browsers`) is inside the free-text
  `message` string of `final_output`. The root coordinator must then parse
  or paraphrase that text to relay a clickable link to the human — unlike
  the Cloud path, where `liveUrl` is a dedicated field the root can use
  directly. A model that summarizes worker's `message` instead of quoting it
  verbatim can silently drop the link.
- Why: `outputSchema` for the worker subagent (`agent.ts`) was written as a
  minimal `{status, message}` contract and was never extended to carry a
  `liveViewUrl` field the way `browser_task`'s ad hoc payload does.
- Proposed fix: add an optional `liveViewUrl` (and maybe `sessionId`) field
  to worker's `taskCompletionSchema`, and update
  `instructions.md`/`SKILL.md` to say "put the live-view URL in the
  `liveViewUrl` field, not just the message," mirroring `browser_task`'s
  contract.
- Check script: `scripts/worker-check.ts` — assert the schema shape includes
  the new optional field once added.

### 6. [P1] OTP code picking never matches the merchant/site that actually needs it

- `file:line`: `agent/lib/otp-policy.ts:151-189` (`pickOtp` — ranks purely by
  `source` (`archive` vs `bro_mail`), `confidence` (`high`/`medium`), and
  recency; no merchant/hint matching at all), `otpSearchQuery` (line 191-195)
  only folds the hint into the *archive search query string*, never into the
  ranking/filtering of already-fetched mailbox candidates.
- What happens: root calls `otp_lookup` with `hint: "wildberries"` while
  worker is blocked on a WB OTP. If a bank OTP (also "high" confidence, also
  fresh) arrived in the same 15-minute window — plausible during a normal
  banking+shopping session — `pickOtp` may return that bank code as
  `status: found` with no `ambiguous` flag (ambiguity only triggers when two
  *high-confidence* candidates are within 1 rank point of each other; a
  clearly higher-ranked wrong-merchant code wins outright). Root then feeds
  the *wrong* code into `worker`, which types a bank OTP into a WB form —
  guaranteed rejection, wasted attempt (some sites lock out after N wrong
  OTP tries), and the correct WB code may have already scrolled out of the
  15-minute window by the time this is discovered.
- Why: `candidatesFromMail`/`pickOtp` treat "fresh + OTP-shaped" as
  sufficient; the `hint` argument is never checked against `from`/`subject`
  content when scoring or filtering hits, only used to widen the archive
  search query.
- Proposed fix: in `pickOtp` (or a new wrapper), when a `hint` is supplied,
  boost/require candidates whose `from`/`subject` textually match the hint
  (simple case-insensitive substring against known sender patterns already
  in `KNOWN_SENDERS`), and demote/exclude same-window candidates that
  clearly belong to a different known sender.
- Check script: `scripts/otp-check.ts` — add a case with two fresh
  high-confidence candidates from different `KNOWN_SENDERS` and a `hint`
  naming one of them, asserting `pickOtp`/`findFreshOtp` prefers the hinted
  sender instead of picking by rank alone.

### 7. [P1] No GC for orphaned Kernel browsers / stale Convex `browserSessions` rows

- `file:line`: `convex/browsers.ts:1-123` (no cron, no TTL sweep — `register`
  only checks `saveChanges` rows for the 20-minute `WRITER_TTL_MS` window at
  write time; `drop` is only ever called from `manage_browsers delete`, or
  incidentally from a 404 seen by `list`/`get`), `convex/crons.ts:1-26` (no
  browser-session job among the four registered crons),
  `agent/subagents/worker/tools/manage_browsers.ts:158-168` (`delete` is the
  only explicit cleanup path, and only runs when the model calls it).
- What happens: if a worker session crashes (timeout, tool error, eve
  process restart mid-turn) after `manage_browsers create` but before
  `delete`, nothing ever deletes the real Kernel browser (it keeps running —
  and, per the product's own docs, billing — until its own
  `timeout_seconds` elapses, which could be anywhere from 15 minutes to 3
  days if the model requested a long one) and the Convex `browserSessions`
  row is never removed unless something later happens to call `list` or
  `get`/`retrieveBrowser` on that exact session ID and hits a 404. A tenant
  who never triggers that path keeps a phantom row forever. Separately, the
  writer-exclusivity check (`WRITER_TTL_MS = 20 min`, `browsers.ts:6,40-48`)
  only looks at the stale row's `createdAt`, so after 20 minutes a *new*
  writable browser can be created for the same tenant while the leaked one
  might still be alive (if its own `timeout_seconds` was set longer than 20
  minutes) — two concurrent `save_changes: true` Kernel browsers on the same
  profile is exactly the race the "only one writable session" comment in
  `manage_browsers.ts:45` is meant to prevent, and nothing in this codebase
  confirms Kernel itself enforces single-writer-per-profile.
- Why: cleanup is entirely reactive (delete-on-success, 404-on-touch) with
  no proactive sweep.
- Proposed fix: add a `browserSessions`-sweeping cron alongside the existing
  four in `convex/crons.ts` (in the same style as "prune composio events")
  that calls Kernel to check/delete any tenant row older than its
  presumed max lifetime and is missing from Kernel's own `browsers.list`, or
  simply older than e.g. 24h with no matching active Kernel session.
- Check script: new `scripts/browser-gc-check.ts` for the pure staleness
  predicate (age > threshold), following the existing check-script pattern.

## Ideas

- **Give worker a `liveViewUrl` output field** (ties into finding 5) — S,
  `agent/subagents/worker/agent.ts`, `instructions.md`, `SKILL.md`.
- **Merchant-aware OTP ranking** (ties into finding 6) — S/M,
  `agent/lib/otp-policy.ts`, `scripts/otp-check.ts`.
- **One shared "who's logged in where" table** — L, would need a new Convex
  table keyed by tenant+site+browser-kind, read by both `profile_setup` and
  `worker`'s login-wall check, so the model (and the human) get one
  consistent answer about whether a site needs a fresh login. Directly
  addresses finding 4 and the owner's stated "no dead ends" pain point.
- **Static guard on `execute_playwright_code` for known secret-read patterns**
  (ties into finding 1) — S/M, cheapest real mitigation short of a full
  sandbox redesign.
- **Routing table for `worker` vs `browser_task`** (see item 8 below) — S,
  purely a documentation/instructions fix that would have prevented finding
  3 outright.

## Item-by-item answers (audit questions 1–9)

1. **Not crisp.** See Finding 3. The rule as literally written
   ("3-D Secure the cloud job cannot finish" → `worker`) is incoherent:
   worker's Kernel browser is a different browser/profile/session and cannot
   reach the Cloud run's in-flight 3DS challenge. The correct behavior
   (already present two lines above in the same file, `instructions.md:61`,
   and again at `instructions.md:88`) is: 3DS/CAPTCHA/push inside a *Cloud*
   run is always resolved by that run's own `liveUrl`
   (`agent/tools/browser_task.ts:84-97`). `worker` should be reserved for
   challenges that occur *inside worker's own Kernel session* (which is a
   legitimate, already-correct use per `SKILL.md:19,23`). Recommend fixing
   the wording at `instructions.md:66` per Finding 3's proposed fix.

2. **Documented in Finding 4.** Cloud profile
   (`convex/lib/browserProfilePolicy.ts`, keyed by `tenant.browserProfileId`)
   and Kernel profile (`agent/subagents/worker/lib/kernel.ts`,
   `profileNameForTenant`) never intersect. Concretely: (a) Cloud
   "уже сохранён" ⇏ worker logged in → worker hits `Needs profile sync` on
   the same site; (b) a login done through worker's own live-view never
   reaches the Cloud profile, so a later `browser_task` on that site still
   shows "Войти". No code shares cookies, vault-login "success" state, or
   even a "which browser is this tenant logged into X on" flag between the
   two systems.

3. **Resume mechanics exist and are sound at the eve layer** — confirmed via
   `node_modules/eve/docs/subagents/index.mdx:176-183`: a subagent "parks
   after answering instead of terminating," and passing its `agentId` back
   to the same subagent tool with a new `message` continues that exact
   session; sessions default to a 30-day timeout
   (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:19-23`),
   so the *eve session* itself is not the bottleneck. **The Kernel browser
   is the bottleneck** — see Finding 2: default 15-minute floor, no
   post-creation extension possible via Kernel's API at all
   (`BrowserUpdateParams` has no timeout field), and nothing prompts the
   model to size `timeout_seconds` generously for an OTP-shaped errand. A
   `[event:mail]` OTP arriving 2 minutes later is fine if the browser was
   created with a floor timeout that hasn't lapsed yet; anything slower than
   that floor (a stuck human, an ambiguous pick needing a follow-up
   question, a slow bank) strands the resume.

4. **Yes, this is the most severe hole found.** `execute_playwright_code`
   has full `page`/`context`/`browser` access (confirmed from Kernel SDK's
   own `.d.ts` docstring) and is not wrapped by `withVaultScreenshotMask` (that
   helper only wraps `computer_action`'s screenshot capture). Chromium native
   autofill (`fillWithKernelNativeAutofill`,
   `agent/subagents/worker/lib/autofill/native.ts`) writes the real secret
   into the DOM and marks the element `data-vault-secret="true"` — a
   CSS-only signal, not a value scrub. A Playwright program can read
   `.value` off that exact element, or dump cookies, and return it as
   `result`, which is only length-truncated (12,000 chars), never redacted,
   before reaching the model. Enforcement today is 100% prompt-level ("never
   read those fields" in `instructions.md`/`SKILL.md`). See Finding 1 for
   the concrete fix.

5. **Real, but bounded rather than "stuck forever."** See Finding 7.
   `ensureTenantProfile`/`proxyIdPromise` module caches
   (`agent/subagents/worker/lib/kernel.ts:13-15`) are fine — they're a
   best-effort warm-instance cache with correct 404/409 fallback handling,
   not a source of staleness, and cold starts simply refetch. The real
   reliability gap is `registerBrowserSession`'s writer invariant: it is
   enforced only in Convex bookkeeping with a 20-minute TTL
   (`WRITER_TTL_MS`, `convex/browsers.ts:6`), so a crashed worker blocks new
   writer creation for at most ~20 minutes (self-healing), but the actual
   leaked Kernel browser is never deleted by any code path and keeps running
   (and, per the product's Kernel billing model, presumably billing) until
   its own `timeout_seconds` elapses — which could be far longer than 20
   minutes. No cron ever sweeps `browserSessions` rows or reconciles them
   against Kernel's live session list (`convex/crons.ts` has four jobs, none
   for this).

6. **Confirmed correct.** `startBrowserErrand`
   (`convex/tenants.ts:924-967`) is keyed by `workerSessionId` via the
   `browserCharges` table's `by_worker` index, and short-circuits to
   `{allowed:true}` without charging again if that worker session already
   has a charge row. So a worker that creates read-only → writable →
   read-only Kernel browsers in sequence (per `SKILL.md:11`) is billed
   exactly once, matching the doc comment at `convex/tenants.ts:934-937`
   ("One worker assignment costs one browser job, however many Kernel
   browsers it opens").

7. **Partially fine, one real gap.** `browser_task`'s Cloud path returns a
   first-class structured `liveUrl` field (`agent/tools/browser_task.ts:84-97`).
   `worker` does not: its `final_output` schema is only `{status, message}`
   (`agent.ts:5-8`), so any live-view URL worker needs to hand up only ever
   exists as free text inside `message` — see Finding 5. Root instructions
   do correctly distinguish the two live-views in the surrounding prose
   (Cloud's `liveUrl` at `instructions.md:61`/`88` vs. worker's own
   live-view only for its own challenges per `SKILL.md:10,19,23`) — the
   wording bug is specifically the "3-D Secure the cloud job cannot finish"
   phrase at line 66 (Finding 3), not a general confusion elsewhere in the
   file.

8. **Honest assessment.** `worker`'s real, non-duplicable value: (a)
   deterministic Playwright — inspect/verify page state precisely instead of
   a high-level agent loop guessing; (b) `computer_action` vision/coordinate
   control for sites the Cloud agent's DOM-based approach can't handle; (c)
   Kernel's managed stealth/CAPTCHA solver on a persistent, tenant-scoped
   profile that isn't the Cloud pool; (d) genuinely independent browser
   identity when the Cloud session itself is the thing that's broken/blocked.
   Costs of keeping both: two profile stores that never sync (Finding 4),
   two vault-injection mechanisms with different security postures (Cloud's
   `secretBindings` are typed server-side and structurally unreadable by the
   model at all — `agent/lib/browser-pay.ts:1-6` — vs. worker's
   `fill_from_vault`, which writes a real, model-readable DOM value that only
   prompt-level discipline protects, Finding 1), two live-view/OTP UX flows
   the root must keep straight (Finding 3, Finding 5), and roughly double
   the failure surface documented across this report. Recommendation: (a)
   a crisp routing table — `worker` only for (i) a site Cloud cannot log
   into/operate at all, or (ii) deterministic verification/extraction after
   a Cloud run finishes, never as a fallback for a Cloud run's own
   challenge; and (b) medium-term, port Cloud's server-side, model-unreadable
   `secretBindings` pattern (or an equivalent redaction layer) onto worker's
   `execute_playwright_code`/`fill_from_vault` path, since that is the
   biggest structural safety gap between the two browsers.

9. **No merchant/expiry-aware disambiguation** — see Finding 6:
   `pickOtp` (`agent/lib/otp-policy.ts:161-189`) ranks by source + confidence
   + a 15-minute freshness window (`OTP_WINDOW_MS`) only; it never checks
   the candidate's sender against the `hint` the caller supplied, so a
   same-window code for a different site can win outright rather than
   trigger `ambiguous`. "Expiry" is really just the 15-minute freshness
   cutoff — anything older is dropped as `missing`, with no per-merchant
   TTL. The code does reach the root's context in plain text (structured
   `code` field on `otp`/`otp_lookup`'s output,
   `agent/lib/otp-policy.ts:215-223`), and from there is passed to `worker`
   — this is by design and necessary (worker needs the digits to type them),
   and the guard against it leaking further is instruction-only: "В чат
   цифры не цитируй" (`agent/skills/otp/SKILL.md:13`,
   `agent/instructions.md:85`) and the memo rule "No passwords, cards,
   OTPs..." (`agent/instructions.md:39`). There is no code-level redaction
   preventing the root from pasting the code into `memo__remember` or a
   group chat if it ignored those instructions — consistent with this
   repo's broader "trust the model, guard via instructions" pattern, but
   worth a second look given OTPs are higher-stakes than an ordinary memo
   line.

## Open questions

- Does Kernel's platform itself enforce "only one `save_changes: true`
  browser per profile," or is that invariant purely Bro's own Convex
  bookkeeping? If Kernel does not enforce it, Finding 7's race (two
  concurrent writers after the 20-minute TTL lapses) is a real corruption
  risk rather than just a billing leak; if Kernel does enforce it
  server-side, the risk is bounded to billing/UX only. Not determinable from
  this repo (Kernel SDK types don't document it).
- Does Kernel actually keep billing an idle/orphaned browser session until
  its `timeout_seconds` elapses, or is there some other idle-detection
  cutoff on Kernel's side? Assumed "yes, bills until timeout" based on the
  product's own framing in `README.md:60` ("One `worker` assignment costs
  one browser job however many browsers it opens") but Kernel's own
  cost model isn't in this repo.
- Whether `memo__remember`/`recall__*` (framework/eve built-ins, not
  authored in this repo) apply any of their own content filtering before
  persisting — could not find their implementation under `agent/` to check
  for a code-level OTP/secret redaction independent of the prompt guard
  noted in Finding 9's discussion.
