# A7 — offline check coverage + channel plumbing audit

## Summary

Part A: the browser-related check scripts are wired correctly (no dead
imports — every re-exported symbol resolves; two apparent "missing export"
hits were `export { x } from ...` re-exports, false positives of a naive
scan). Coverage is strong for the *decision* functions that gate start/poll
vs. reuse and chat-injection, but weak or absent for (1) `agent/lib/vault-login.ts`
(the vault-login-to-secretBindings glue — zero function-level tests, only a
string grep on the caller), (2) `liveUrlFromRunPayloads` (the actual v4
live-URL extraction entrypoint used in production, four call sites, zero
tests), and (3) most of `browserCdp.ts`/`browserLivePolicy.ts`'s lower-level
helpers, exercised only indirectly through one or two composed call paths.

Part B: the three worst holes, all reachable in the owner's own stated
"no dead ends" scenarios:
1. **The tool-sent «Ищу, это может занять пару минут…» line is invisible to
   the model's own reply dedupe** — `browser_task.ts` never calls
   `markTurnSpoke` after its own canned send (unlike `profile_setup.ts`,
   which does), and even where it is called, `turnSpoke` is a completely
   separate mechanism from the `earlySent`/`nextBubble` dedupe that guards
   the model's streamed/completed text. Two different visible bubbles for
   the same "I'm looking" moment is a real, code-confirmed possibility —
   exactly the "duplicate «ищу» bubbles" pain point named in CONTEXT.md.
2. **`/internal/wakeup`'s only duplicate-delivery defense is a per-process
   `Map`** (`agent/lib/wakeup-dedupe.ts`). The Convex-side claim
   (`claimBrowserWakeup`) only prevents two *concurrent Convex retries* from
   racing; it does nothing once the POST to eve has actually landed but the
   HTTP response is lost (timeout, cold-start churn) — the Convex workflow
   retries, a *different* Vercel instance (empty in-memory map) accepts the
   retry, and the human gets the browser-done result twice.
3. **Fast-ack has no code-level exclusion for OTP-code-shaped or
   "подожди"-shaped text.** `shouldFastAck` reuses none of
   `convex/lib/browserInjectPolicy.ts`'s `isChatCodeMessage`/`isWaitInject`
   classifiers, so a bare 6-digit SMS code or a "подожди" during a live
   Cloud session both qualify for the fast-ack lane's own independent
   OpenRouter call and first bubble — a bubble that has no idea a code/pause
   is in flight and is not deduped against the real turn's «ввожу код» /
   «подожду» acknowledgement (which comes from a different code path with
   different dedupe).

---

## Part A — offline check coverage

### A.1 Coverage matrix (exported function → check → cases)

Legend: **direct** = a check script imports and calls the function itself.
**indirect** = only exercised as a sub-step of another tested function.
**none** = no test, direct or indirect.

#### `convex/lib/browserFollowPolicy.ts`
| export | check | coverage |
|---|---|---|
| `followSleepMs`, `isFollowTerminal`, `pollGiveUp`, `nextFollowDecision`, `maxPollRounds`, `shouldStartFollowThrough` | browser-policy-check.ts, jobs-check.ts | direct, several cases (running/completed/failed/give-up boundary) |
| `sameBrowserRun` | browser-policy-check.ts, jobs-check.ts | direct |
| `wakeupIdempotencyKey` | browser-policy-check.ts | direct |
| `decideWakeupClaim`, `browserWakeupClaimKey` | browser-policy-check.ts, jobs-check.ts | direct — pending/expired/sent/stale_run/legacy cases |
| `parseWakeupClaim`, `claimMatchesRunPhase` | — | **none** (only reached through `decideWakeupClaim`'s string literals in the test, not through parsing malformed/legacy claim strings directly) |
| `wakeupCarriesRunId` | browser-policy-check.ts, jobs-check.ts | direct |
| `wakeupRetryWaitBeforeLastMs`, `wakeupStepRetry`, `WAKEUP_CLAIM_LEASE_MS` | browser-policy-check.ts | direct (`wakeupStepRetry` object itself never asserted on) |
| `followStartRetry`, `FOLLOW_RETRY_HINT` | browser-policy-check.ts, jobs-check.ts | direct |
| `decideExistingWorkflow` | browser-policy-check.ts, jobs-check.ts | direct — reuse/cancel_then_start/retry_later/start |

#### `convex/lib/browserInjectPolicy.ts`
| export | check | coverage |
|---|---|---|
| `extractChatCode`, `isChatCodeMessage`, `isWaitInject`, `looksLikeCorrectionText`, `looksLikePasswordDump`, `pageWaitsForCode`, `resultWaitsForCode`, `decideCloudInject`, `cloudSessionLooksLive`, `injectAckText`, `injectCandidate`, `cloudInjectAttribute`, `cloudInjectKindFromAttrs`, `cloudInjectInstruction`, `injectQueueText`, `injectQueueInterrupt`, `injectFollowTask` | browser-inject-check.ts | direct, large scenario matrix (code/wait/correction × live/dead session × taxi/shop/login task) |
| `correctionFitsTask`, `isBroCloudTask`, `looksLikeFreshErrand`, `isActiveCloudStatus`, `isDoneCloudStatus`, `isInjectTask` | browser-inject-check.ts | **indirect only** — never imported/called directly; reached only via the `decideCloudInject`/`looksLikeCorrectionText` scenarios above |
| `INJECT_NO_PASSWORD_HINT` | — | **none** (constant, not asserted anywhere, not even via `src()` grep) |

#### `convex/lib/browserLivePolicy.ts`
| export | check | coverage |
|---|---|---|
| `liveUrlFromEvents`, `pageUrlFromEvents`, `loginHostsMatch`, `loginLandingReady`, `shouldSendLoginLink`, `hasNavigateActivity` | profile-sync-check.ts | direct, several cases |
| `pickLiveUrl`, `isLiveViewUrl` | profile-sync-check.ts | **indirect only** (through `liveUrlFromEvents`) — never called with a bare `run`/`session` object shape (only inside `{events:[...]}`) |
| `pageUrlsFromEvents` | profile-sync-check.ts | **indirect only** (through `pageUrlFromEvents`) |
| `liveUrlFromRunPayloads` | — | **none**, despite being the actual production entrypoint (`agent/lib/browseruse.ts:431,483,494,545`, `convex/lib/browseruse.ts:102`) that resolves live URL from `{run, session, events}` — precedence order (run > session > events) is asserted nowhere |
| `runEventsPath` | — | **none** |
| `BROWSER_READY_TYPES`, `LOGIN_LIVE_WAIT_MS`, `LOGIN_LANDING_WAIT_MS` | — | **none** |

#### `convex/lib/browserProfilePolicy.ts`
| export | check | coverage |
|---|---|---|
| `isLoginWaitTask`, `isLoginVaultTask`, `loginVaultTask`, `loginVaultChatText`, `loginPageFromTask`, `isBrowserProfileId`, `normalizeBrowserProfileId`, `loginPageUrl`, `loginWaitTask`, `loginOpeningText`, `loginChatText`, `alreadyLoggedChatText`, `cookieDomainsCoverPage`, `profileSyncStatus`, `pickCookieDomains` | profile-sync-check.ts | direct |
| `siteFromLoginTask` | — | **none** (used at `convex/tenants.ts:465-466` for cabinet display copy) |

#### `convex/lib/browserStartPolicy.ts`
| export | check | coverage |
|---|---|---|
| `errandStartUrl` | profile-sync-check.ts | direct — taxi/explicit-url cases only; no Ozon/WB wording case in this check (covered implicitly by `agent/instructions.md` assertions elsewhere, not by calling `errandStartUrl` with "озон"/"вб" text) |
| `ERRAND_LANDING_WAIT_MS` | — | **none** |

#### `convex/lib/browserJobPolicy.ts`
| export | check | coverage |
|---|---|---|
| `browserJobForSnapshot` | **scripts/cabinet-check.ts** (outside the file list this audit was given, but exists in repo) | direct — not one of the 16 "browser-related" checks named in the task, worth noting so it isn't miscounted as an orphan |

#### `convex/lib/browserCdp.ts`
| export | check | coverage |
|---|---|---|
| `asCdpTargets`, `cdpCurrentUrl`, `browserFromList` | profile-sync-check.ts | direct |
| `pickCdpPage` | profile-sync-check.ts | **indirect only** (via `cdpCurrentUrl`) |
| `cdpHttpBase`, `listCdpTargets`, `cdpPageUrl` | — | **none** (network wrappers — `cdpHttpBase`'s ws→http scheme rewrite is pure and cheap to test directly, currently untested) |

#### `agent/lib/browser-policy.ts`
| export | check | coverage |
|---|---|---|
| `normalizeTask`, `nextBrowserAction`, `pollTimedOut`, `BROWSER_WAIT_MS` | browser-policy-check.ts | direct, many scenarios |
| `isActiveStatus`, `isDoneStatus`, `looksLikeNewJob` | browser-policy-check.ts | **indirect only** (via `nextBrowserAction`) |

#### `agent/lib/order-policy.ts`
| export | check | coverage |
|---|---|---|
| `merchantFromHost`, `merchantFromTask`, `resolveMerchant`, `pendingOrderId`, `parseOrderFromResult` | orders-check.ts | direct, good coverage incl. PAN-safety, cancel/fail, pending-hash stability |

#### `agent/lib/purchase-policy.ts`
| export | check | coverage |
|---|---|---|
| `purchaseStance`, `budgetRub`, `watcherBuys`, `watcherShouldPay`, `watcherWakeupPrompt` | purchase-check.ts | direct |
| `parseAmount` | purchase-check.ts, orders-check.ts | **indirect only** (via `budgetRub`/order price parsing) — its own guard rails (`n <= 0` → undefined, `rub > 10_000_000` → undefined) are never hit directly |

#### `agent/lib/browser-pay.ts`
| export | check | coverage |
|---|---|---|
| all (`normalizePayHost(s)`, `loginBindings`, `loginScaffold`, `cardBindings`, `payScaffold`) | browser-pay-check.ts | direct, thorough (SSRF-ish host rejection, dedupe/cap, expiry padding, subdomain wording) |

#### `agent/lib/vault-login.ts`
| export | check | coverage |
|---|---|---|
| `vaultPasswordLogin`, `vaultPasswordLoginForPages` | — | **none.** `profile-sync-check.ts:259` only asserts `tool.includes("vaultPasswordLogin")` (a string search over `agent/tools/profile_setup.ts` source), never imports or calls the real function. The composition it performs — `listVaultItems` → `pickVaultLogin` (host match) → `readVaultSecret` → `parseLoginPayload` → authentication-type gate → `normalizePayHosts([page, payload.origin])` → `loginBindings` — is entirely untested end-to-end. This is the exact glue the owner calls out as a pain point ("Browser Use Cloud sessions and everything else").

### A.2 Exported functions with NO check (direct or indirect)

- `agent/lib/vault-login.ts`: `vaultPasswordLogin`, `vaultPasswordLoginForPages`
- `convex/lib/browserLivePolicy.ts`: `liveUrlFromRunPayloads`, `runEventsPath`, `BROWSER_READY_TYPES`, `LOGIN_LIVE_WAIT_MS`, `LOGIN_LANDING_WAIT_MS`
- `convex/lib/browserProfilePolicy.ts`: `siteFromLoginTask`
- `convex/lib/browserStartPolicy.ts`: `ERRAND_LANDING_WAIT_MS`
- `convex/lib/browserCdp.ts`: `cdpHttpBase`, `listCdpTargets`, `cdpPageUrl`
- `convex/lib/browserInjectPolicy.ts`: `INJECT_NO_PASSWORD_HINT`
- `convex/lib/browserFollowPolicy.ts`: `parseWakeupClaim`, `claimMatchesRunPhase` (as standalone parse/compare functions, not through the composed `decideWakeupClaim` cases)

### A.3 Checks that assert trivial things

- `browser-policy-check.ts:393-397` — `DEFAULT_BROWSER_MODEL === "gpt-5.6-luna"` and the `resolveBrowserModel` fallbacks are simple string-default checks; fine as regression pins but add no real behavioral coverage.
- `vault-check.ts` and `browser-pay-check.ts`'s `src(...).includes(...)` assertions on `convex/vault.ts`/`convex/vaultSecrets.ts`/`assets/vault.js` (e.g. `vaultSrc.includes("export const listForAgent")`) are presence checks, not behavior checks — they catch a rename/deletion but not a logic change.
- `otp-check.ts` and `browser-inject-check.ts` both end with a long tail of `src(...).includes(...)` assertions against `agent/instructions.md` (e.g. `instructions.includes("ввожу код")`). These are useful trip-wires against instruction-text rot but are trivially gamed (any occurrence of the substring anywhere in the 1000+ line instructions file passes, regardless of context/negation nearby).
- `wakeups-check.ts:224-231` — two bare `src(...).includes(...)` checks (`idempotencyKey:` in `convex/wakeups.ts`, `payloadContains: opts.payloadContains` in `agent/lib/convex.ts`) assert wiring exists, not that it behaves correctly.

### A.4 Dead imports

Scanned every `import { ... } from "../relative/path"` in all 15 check
scripts against the target file's actual exports. Two hits, both **false
positives** — the target file re-exports the name from elsewhere:
- `browser-policy-check.ts` imports `nextFollowDecision`/`shouldStartFollowThrough`
  from `agent/lib/browser-policy.ts`, which does
  `export { nextFollowDecision, shouldStartFollowThrough } from "../../convex/lib/browserFollowPolicy.ts"` (browser-policy.ts:69-72). Valid.
- `worker-check.ts` imports `originAllows` from
  `agent/subagents/worker/lib/autofill/claims.ts`, which re-exports it
  (`claims.ts:7,17`) from elsewhere. Valid.

**No real dead imports found** — every check that appears to test a
function is actually calling live code, not a renamed/removed stub. The
gaps above are *missing* tests, not *broken* ones.

### A.5 ~15 proposed new assertions

1. **`liveUrlFromRunPayloads`, precedence order** — `agent/lib/vault-login.ts`
   has no test at all, but this is even higher-value: build a realistic v4
   `hydrate()` response shape with a live URL nested under `session.live_view_url`
   AND a *different* one under `run.liveUrl`; assert `run` wins (matches the
   `??` chain order in the source). Regression: a future refactor that
   flips the `??` order silently starts showing stale/wrong live-view links.
2. `liveUrlFromRunPayloads({ events: [...] })` with a realistic multi-event
   v4 payload (`run.created` → `browser.ready` → `tool.navigate`) where only
   the LAST event carries `live_view_url` under `data.browser.live_view_url`
   (nested one level deeper than the flat shape every current test uses) —
   assert it still finds it. Regression: `pickLiveUrl`'s `depth > 4` cutoff
   or the `["data","browser","session","payload"]` nest-key allowlist
   silently stops matching a real API response shape.
3. `vaultPasswordLogin(phone, pageUrl)` with a mocked `listVaultItems`
   returning two logins (one for `ozon.ru`, one for `www.wildberries.ru`)
   and `pageUrl = "https://www.ozon.ru/login"` — assert it picks the Ozon
   login, not the first item in the list. Regression: `pickVaultLogin`
   host-matching regressing to "first item wins" would silently type the
   wrong site's password.
4. `vaultPasswordLogin` where the matched vault item's `authentication.type`
   is `"sms_otp"` (no password) — assert it returns `undefined`, not a
   `loginBindings` throw bubbling up uncaught (the source already guards
   this at line 40, but nothing calls the function to prove it in the
   error path, not just the happy path).
5. `vaultPasswordLoginForPages(phone, pages)` with three page URLs where the
   first two are duplicates after `loginPageUrl` normalization (e.g.
   `"https://ozon.ru/login"` and `"https://ozon.ru/login?x=1"` both
   normalizing to the same origin) — assert `listVaultItems`/`readVaultSecret`
   is only attempted once for that origin, not twice. Regression: burning
   two Convex round-trips (and, per Q6 below, potentially two "vault read"
   audit log entries) per errand instead of one.
6. `nextBrowserAction` with `status: "queued"` **and** `incomingTask` that
   `looksLikeNewJob` (long/new-shop wording) while a *different* prior task
   is still queued — assert `"poll"` still wins over "looks like a new job"
   (today's tests only exercise this combination for `"completed"`/`"running"`,
   never `"queued"` explicitly with a fresh-job-shaped incoming text).
7. `decideCloudInject` where `incoming` is a 6-digit code **and**
   `cloudSessionLooksLive` is true **and** `pageUrl` is on a checkout/payment
   page (not a code page) **and** `storedTask` is a plain `[bro-errand]` (not
   login) — today's "bare code on taxi form is not relevant" case is the
   closest analog; add the payment-page variant explicitly, since OTP during
   3-D Secure is one of the owner's named pain points and is currently only
   covered for the *taxi order form*, not a *payment* form.
8. `parseOrderFromResult` with a WB-style result where the price appears
   **before** the order id in the text and both a discounted price and a
   "was" price are present (`"Было 6990 ₽, сейчас 4990 ₽. Заказ №123456"`)
   — assert the *last* marked price wins (matches the current "last match"
   loop in `extractPrice`) and pin that behavior with a real-shaped string,
   not just the clean single-price fixtures already tested.
9. `errandStartUrl` called with `"озон"` / `"вб"` bare Cyrillic wording
   (no "ozon"/"wb" Latin) directly — today only `errandStartUrl("вызови такси...")`
   and an explicit-URL case are tested; the Ozon/WB branches
   (`browserStartPolicy.ts:30-31`) have zero direct calls, only indirect
   trust via `agent/instructions.md` prose checks.
10. `cloudSessionLooksLive` with `sessionId` set, `startedAt` exactly at the
    `SESSION_LIVE_MS` (20 min) boundary — assert the `<` boundary behavior
    explicitly (off-by-one regressions here silently reclassify a session
    as dead one tick too early, right when a slow OTP arrives).
11. `injectQueueText({ kind: "code", ... , alreadyTyped: true, dryRun: true })`
    combined (both flags true) — today `alreadyTyped` and `dryRun` are only
    tested individually; assert the combined text has neither the digits
    nor an order-confirm instruction (a plausible real path: CDP typed the
    code AND the errand is a declared dry run).
12. `cardBindings`/`loginBindings` called with hosts that include a bare IP
    or `localhost` already filtered by `normalizePayHost` upstream — assert
    `cardBindings`/`loginBindings` themselves don't silently accept such a
    host if called directly (defense in depth: today the IP/localhost
    rejection is only proven at the `normalizePayHost` layer, not at the
    binding layer that actually emits `allowedDomains` to the Cloud API).
13. `takeWakeupDelivery` / `decideWakeupClaim` combined into one scenario:
    simulate two "processes" (two separate `Map`s) both claiming
    `runId:done` — Convex-side `decideWakeupClaim` says "ok" for the first,
    then (after the Convex claim is marked "sent") a stale retry POST hits a
    *second* `Map` for `takeWakeupDelivery` and returns `true` again. Pin
    that this two-layer setup is exactly non-idempotent across processes
    (turns the current implicit assumption into an explicit, failing-until-fixed
    assertion — see Part B finding 2).
14. `browserGateFromResult`/`countBrowserJobStart` interaction: simulate one
    tenant doing (a) `profile_setup` login start, (b) `browser_task` start
    for the errand, (c) `browser_task` with `pay` on a `"reuse"`-eligible run
    — assert how many times the billing counter would be charged (today:
    3, for what the product treats as one errand). Turn this into an
    explicit assertion of the *current* (arguably wrong) behavior so a fix
    has a red test to turn green (see Part B finding 6).
15. `shouldFastAck` with a bare 6-digit string (`"482911"`) and with
    `"подожди"` — assert **false** for both (this is a proposed *new*
    behavior/assertion, since today's real behavior is `true`; see Part B
    finding 3). Add `isChatCodeMessage`/`isWaitInject` imports from
    `convex/lib/browserInjectPolicy.ts` into `fast-ack.ts` to back it.

---

## Part B — channel plumbing findings

### Finding B1 — P1: tool-sent canned bubble and the model's own reply can both go out

`file:line`: `agent/tools/browser_task.ts:610-620` (no `markTurnSpoke` after
the canned send), vs. `agent/tools/profile_setup.ts:255-261` (does call it);
`agent/lib/early-deliver.ts:635-650` (`recordSent`/`markTurnSpoke` are two
independent maps — `spokeTurns` is never read by `alreadySentFor`/`nextBubble`
in `agent/lib/turn-delivery-events.ts:178-197`).

What happens: the model calls `browser_task` directly (finishReason
`tool-calls`, no preceding streamed text). `browser_task.ts:611` checks
`turnSpoke(turnId)` — false, so it fires
`deliverHumanRouted({..., text: "Ищу, это может занять пару минут. Сам напишу, когда будет готово."})`
via `deliverHuman` → `claimChatBubble` (exact-text dedupe only,
`agent/lib/bubble-dedupe.ts:27-52`). It never calls `markTurnSpoke`. The
tool then returns to the model, which (per its own instructions) may still
produce a closing sentence for this turn, e.g. "Ищу на Wildberries, дай
пару минут" — different text from the canned line. `message.completed`'s
handler (`turn-delivery-events.ts:313-390`) computes `alreadySentFor` from
`earlySent` only (never touched by the tool's send) and `planTurnDelivery`
sees no prior bubble for this turn, so it delivers this second line too.
Both bubbles reach the human in one turn.

Why: two separate, unconnected dedupe systems — `turnSpoke`/`markTurnSpoke`
(consulted only by the tools, to gate whether the tool sends its OWN
canned line) and `earlySent`/`nextBubble` (consulted only by the
streaming/completion event handlers, to gate the MODEL's own text). Neither
records into the other. `profile_setup.ts` calls `markTurnSpoke` after its
own send (so a *second tool call in the same turn* would correctly skip),
but that still doesn't stop the model's own natural-language close from
going out separately, because `planTurnDelivery` never consults `spokeTurns`.

Proposed fix (minimal, in repo style): either (a) have
`deliverHumanRouted`'s tool-side call also `recordSent(earlySent, turnId, text, now)`
into the same map `turn-delivery-events.ts` uses — requires exporting
`earlySent` or exposing a shared setter — or (b) simpler: after any
tool-triggered canned send, call both `markTurnSpoke` (existing) so a repeat
tool call skips, *and* stamp an instruction akin to the existing
`fastAckInstruction`/`cloudInjectInstruction` pattern so the model is told
"you already said X, do not add a status line" for the rest of that turn —
mirroring how `fastAckInstruction` already solves the identical class of
problem for the fast-ack lane (`agent/lib/fast-ack.ts:201-203`).

Which check should cover it: `early-deliver-check.ts` (add a scenario:
`browser_task`-shaped tool call records a canned bubble; then a subsequent
`message.completed` for the same turnId with a *different* short "looking"
sentence must be suppressed) or a new assertion in
`browser-policy-check.ts` asserting `browserTool` calls `markTurnSpoke`
after its canned send, matching the existing `profile_setup.ts` pattern
already pinned in that check family.

---

### Finding B2 — P0: `/internal/wakeup` duplicate delivery across serverless instances

`file:line`: `agent/lib/wakeup-dedupe.ts:1-27` (module-scope
`Map`, comment says "not shared across instances" — this is `imessage.ts:84`'s
`wakeupDelivered` map); `convex/browserFollow.ts:344-395` (`wakeupAgent`
claims via `claimBrowserWakeup`, POSTs to eve, releases the claim on any
throw so the Convex workpool retries per `wakeupStepRetry`:
`convex/lib/browserFollowPolicy.ts:82-97`, 9 attempts, worst-case wait
before the last attempt ≈63.75s).

What happens, step by step:
1. Browser job completes. `browserFollow.ts`'s workflow calls `wakeupAgent`.
2. `claimBrowserWakeup` claims `runId:done` as `pending` (Convex mutation —
   atomic at the document level).
3. `wakeupAgent` POSTs to `${eveUrl}/internal/wakeup` with
   `idempotencyKey: "browser_poll:<runId>:done"`.
4. eve's route (`imessage.ts:660-751`) checks `takeWakeupDelivery(wakeupDelivered, idempotencyKey, now)`
   against its own process-local `Map`. First time: true. It then
   `await from(conversationId).send(prompt, {...})` — this delivers the
   real "your errand is done" turn to the human.
5. Suppose the HTTP response back to Convex is lost (connection reset,
   function cold-shutdown mid-response, or `send()` itself is slow enough
   that Convex's own network layer times out) — Convex's `fetch` throws.
6. `wakeupAgent`'s catch releases the Convex-side claim
   (`releaseBrowserWakeup`) and rethrows, so `confirmBrowserWakeup` (which
   would have flipped the claim to `"sent"`) never runs.
7. The Convex workpool retries `wakeupAgent` (up to 9 attempts). The claim
   is `pending` but its lease (`WAKEUP_CLAIM_LEASE_MS = 60_000`) may already
   be expired by the time of a later attempt, or the release in step 6 made
   it immediately reclaimable — either way, `claimBrowserWakeup` says "ok"
   again and the wakeup POSTs a second time.
8. This second POST can land on a **different Vercel instance** (Vercel
   routes to whichever instance is warm/available) whose `wakeupDelivered`
   `Map` is empty — `takeWakeupDelivery` returns `true` again, and
   `from(conversationId).send(prompt, ...)` fires a second real turn.

Why: the durable, cross-process defense (Convex's claim) only prevents
*concurrent* claims of the same `runId:phase`; it explicitly treats "POST
failed" as "not yet delivered" and re-arms for retry (correct, since a
POST really can fail before delivery). The *only* thing standing between
"POST succeeded but the ack was lost" and a duplicate human-visible message
is eve's in-memory map, which is explicitly documented (in the same file)
as not surviving restarts or being shared across instances.

Proposed fix: make the eve-side dedupe durable — e.g., a `wakeupDeliveries`
Convex table (or reuse the existing `tenants.browserWakeupClaim` string,
already durable) checked/set from *inside* the `/internal/wakeup` handler
itself (a cheap `internalMutation` keyed by `idempotencyKey`, called before
`from().send()`), rather than only trusting the caller's own claim. This
turns the in-memory `Map` into a pure fast-path optimization instead of the
sole correctness backstop.

Which check should cover it: `wakeups-check.ts` currently only unit-tests
`takeWakeupDelivery` against a *single* `Map` instance
(`wakeups-check.ts:129-140`). Add a scenario using *two* separate `Map`
instances to model two serverless instances and assert the *system*
(not just the one function) is non-idempotent today — see proposed
assertion A.5 #13 above.

---

### Finding B3 — P0: a browser_poll wakeup can end in silence with no fallback

`file:line`: `agent/lib/silent-turn.ts:34-36` (`fallbackForFailed` returns
`null` for any non-`"human"` origin, so `"wakeup"` never gets
`TURN_FAILED_REPLY`); `agent/channels/imessage.ts:702` (the entire
"don't stay silent on done/failed" contract is one line of free-text prose
in the wakeup user-turn prompt, not a `turn.started` system-level steer);
compare `agent/instructions/jobs.ts` (job_check wakeups **do** get a
system-role forced-non-silent steer via `isJobCheckWakeup`/`jobNudgeInstruction`
returning `"Do NOT answer [SILENT]"`, `jobs-check.ts:387`) — there is no
equivalent for `wakeupKind === "browser_poll"` anywhere in
`agent/instructions/jobs.ts` (confirmed: `grep wakeupKind` in that file
only matches the `job_check` handling).

What happens: a `browser_poll` wakeup turn asks the model, in a plain user
message, to call `browser_task`, then "if completed, send the results; if
failed/stuck, say so; only [SILENT] if still running and nothing to
inject." This is *prose the model can misjudge* — e.g. if `browser_task`'s
returned payload is ambiguous (a transient Cloud API hiccup makes
`hydrate()` return a thin/empty-looking result, or the model treats
`"hint"` text as "nothing new happened yet"), the model can legally answer
`[SILENT]`, and `isSilentReply`/`fallbackForFailed(undefined)` (this is a
wakeup, not a failed turn — `turn.failed` never even fires) means **no
fallback ever exists for "the model chose the wrong branch of its own
prose instructions."** The `TURN_FAILED_REPLY` safety net only fires on an
actual `turn.failed` event or a truly empty completed message — not on a
deliberate-but-wrong `[SILENT]`. The human never learns the errand
finished (or crashed) at all — a true dead end matching the owner's
explicit "no dead ends... no stuck jobs... no silence."

Why: unlike `job_check` (which has a pure, testable
`shouldSpeakNotSilent`/`jobNudgeInstruction` in `convex/lib/jobNudgePolicy.ts`
+ `agent/lib/job-wake.ts`, enforced as a `role: "system"` turn.started
instruction — i.e., code decides, not the model), `browser_poll` done/giveup
has no equivalent pure decision function or system-level steer. The
entire non-silence guarantee for the highest-stakes wakeup kind (the one
that reports whether Bro actually bought something) rests on one paragraph
of natural-language prompt text.

Proposed fix: add a `browserPollForceSpeak(kind: "browser_poll", phase: "done"|"giveup")`
pure function (mirroring `shouldSpeakNotSilent`) and a `turn.started` steer
in `agent/instructions/jobs.ts` (alongside the existing `isJobCheckWakeup`
branch) that forces `Do NOT answer [SILENT]` whenever `wakeupKind === "browser_poll"`
— done/giveup wakeups should never be silent by construction, only "still
running" wakeups should be able to opt into `[SILENT]` (and even that path
is dubious, since `browser_poll` isn't sent at all unless the workflow
already decided `decision !== "sleep"` server-side — i.e., **every**
`browser_poll` HTTP wakeup that actually reaches eve is already
done/failed/timed-out; the "still running, nothing to inject" branch in
the prompt text looks unreachable given `nextFollowDecision`'s contract,
which makes the existing `[SILENT]` escape hatch in the prompt itself
suspect and worth removing).

Which check should cover it: new assertions in `jobs-check.ts` (or a new
`browser-wakeup-silence-check.ts`) parallel to the existing
`isJobCheckWakeup`/`jobNudgeInstruction` assertions, plus an
`imessage.ts`/`jobs.ts` source assertion that the browser_poll prompt no
longer contains a reachable `[SILENT]` branch.

---

### Finding B4 — P1: billing gate can charge 2-3 "jobs" for one real errand

`file:line`: `convex/lib/billingPolicy.ts:8` (`BROWSER_JOBS_UNLIMITED = true`
— "closed beta: no monthly cap. Flip off to restore 5/60" — so this is
**dormant, not dead**, code); `agent/tools/browser_task.ts:462-471,530-543`
(billing gate hit on `"start"`, and `pay && rawAction === "reuse"` is
**forced** to `"start"`); `agent/tools/profile_setup.ts:186-201` (separate
`countBrowserJobStart` call for the login run); `convex/tenants.ts:924-932`
(`countBrowserJobStart` — no dedup key at all, unlike `startBrowserErrand`
at `convex/tenants.ts:941-969`, which explicitly dedupes by
`workerSessionId` so "however many Kernel browsers a worker assignment
opens, it's one charge" — a design the main Cloud-v4 path does not share).

Enumeration for one real errand needing login + OTP + payment (e.g. "купи
кроссовки на wildberries, размер 42" when Bro isn't logged in yet):
1. Cookies don't cover the page → `profile_setup` starts a vault-login run
   → **charge 1** (`profile_setup.ts:189`).
2. Login completes ("вошёл"). Model calls `browser_task` for the actual
   shopping errand — `tenant.browserTask` is still the login task, so
   `nextBrowserAction` sees no matching run → `"start"` → **charge 2**
   (`browser_task.ts:532`).
3. Mid-run OTP/SMS or address correction — no charge (queued via
   `maybeInjectChat`/`queueMessage`, not a new "start"). Good.
4. Item found; model calls `browser_task` again with `pay: {...}` to
   finalize — even though `nextBrowserAction` would say `"reuse"` (same
   task, run completed), `browser_task.ts:471` **forces** `action = "start"`
   whenever `pay` is set and the raw action was reuse (secretBindings are
   run-scoped) → **charge 3**.
5. If the follow-through workflow times out (`giveup`, 20 min) and the
   model/human retries with a fresh `browser_task` call for the same
   errand → **charge 4**.

So a single errand the product wants to count as "one job" can legitimately
burn 3 (typical) to 4 (with one timeout) rate-limiter increments, while
`BROWSER_JOBS_UNLIMITED = true` is masking this today. The moment that
flag flips (which its own comment says is the intended end state), a
free-tier user (5/month) could exhaust their entire month's allowance in
under two real errands that happen to need a login.

Proposed "what should count as one job": key `countBrowserJobStart` the
same way `startBrowserErrand` already does — by a per-errand session token
(e.g. `tenant.browserSessionId` once one exists, or a short-lived
"active errand" id minted at the first `profile_setup`/`browser_task` start
and reused by every subsequent start within some window, e.g. 30 minutes or
until the run reaches a terminal "no further immediate follow-up" state).
Concretely: add a `errandChargeId` argument to `countBrowserJobStart`
mirroring `startBrowserErrand`'s `workerSessionId`+`browserCharges` table,
so `profile_setup`'s login start and the errand's own start (and a
pay-forced restart within the same session) share one charge.

Which check should cover it: a new `billing-browser-check.ts` (or an
addition to an existing billing check not in this audit's file list) with
proposed assertion A.5 #14 above, plus a `browserGateFromResult`/
`chargeBrowserJob` Convex-side test that asserts *one* charge across
profile_setup → browser_task(start) → browser_task(pay, forced-start)
within one errand window.

---

### Finding B5 — P2: fast-ack has no code-level exclusion for OTP codes / "подожди"

`file:line`: `agent/lib/fast-ack.ts:59-75` (`shouldFastAck`) vs.
`convex/lib/browserInjectPolicy.ts:130-141,115-128` (`isWaitInject`,
`isChatCodeMessage` already exist and are not imported by `fast-ack.ts`).

What happens: `shouldFastAck("482911")` → true (not empty, no `[`-prefix,
not in the `SHORT_ACK` set, not a help/telegram ask, length < 600). Same
for `shouldFastAck("подожди")`. Both channels (`imessage.ts:305`,
`telegram.ts:283`) call `startFastAck(inbound.text)` unconditionally
whenever `shouldFastAck` is true, firing an independent OpenRouter call and
a first bubble that has **no awareness** of a live Cloud session, an
in-flight OTP wait, or the `cloudInject` classification computed
separately a few lines later (`cloudInjectAttribute(inbound.text)`,
stamped on the *same* inbound turn). The tiny model's few-shot prompt
(`FAST_ACK_SYSTEM`) has no example for a bare digit string or "подожди",
so its output for these inputs is unconstrained — it may emit `NONE`
(safe) or some invented status line (e.g. "проверяю") that is neither
deduped against nor consistent with the real turn's subsequent
«ввожу код» / «подожду» acknowledgement (a different bubble, from a
different code path — `browser_task.ts:169-176`/`254`, via
`deliverHumanRouted`, not through `peelFastAck`).

Why: `shouldFastAck` was written purely around "is this an errand vs. small
talk," not "is this mid-flow chat that a live browser job is waiting on" —
the two concerns (fast-ack gating, cloud-inject gating) live in different
files and were never reconciled, even though both run on the exact same
inbound text in the exact same request handler, one line apart
(`imessage.ts:508`/`telegram.ts:82`, `cloudInjectAttribute`).

Proposed fix: in `shouldFastAck`, also return `false` when
`isChatCodeMessage(text) || isWaitInject(text)` (import from
`convex/lib/browserInjectPolicy.ts`) — cheap, no new dependency direction
issue since `agent/lib/fast-ack.ts` already sits above `convex/lib/*` in
the existing import graph (other agent/lib files already import from
`convex/lib`).

Which check should cover it: `fast-ack-check.ts` — add
`assert(!shouldFastAck("482911"))` and `assert(!shouldFastAck("подожди"))`
(proposed assertion A.5 #15).

---

### Finding B6 — confirmed non-issue: `browser_poll` wakeup routing to Telegram

`file:line`: `agent/lib/turn-routing.ts:20-52` (`routingFromAuth` returns
`channel: undefined, canDeliver: false` for `origin: "wakeup"` with no
telegram stamp) → `agent/lib/turn-delivery-events.ts:124-146`
(`deliverTurnBubble` falls back to `await replyTenant(opts.conversationId)`
when `!routing.canDeliver`, then calls `deliverHuman({..., channel: routing.channel})`
where `deliverHuman` (`agent/lib/deliver-human.ts:60`) itself falls back to
`lastChannelOf(tenant.lastChannel)` using the **looked-up** tenant, not the
turn attrs) — so a `browser_poll` wakeup for a Telegram-preferred tenant
does correctly resolve to Telegram, both for the tool's own canned notify
(`browser_task.ts` passes the freshly-fetched `tenant` object, which
carries `lastChannel`, into `deliverHumanRouted`) and for the model's final
reply (`deliverTurnBubble`'s own `replyTenant` lookup). This holds even
though `imessageOwnsTurn(attrs)` is `true` for such a turn (no telegram
stamp on wakeup attrs) and `telegramOwnsTurn` is `false` — i.e. only the
**imessage channel's own** `imessageDeliveryEvents` accept the turn, not
the Telegram hook, but `deliverHuman` inside that handler still calls
Telegram's send API directly once it resolves `lastChannel === "telegram"`
from Convex. Verified this is intentional and not a copy-paste bug: the
architecture is "one event-owner decides IF to act, then `deliverHuman` is
channel-agnostic about WHERE." No fix proposed here — flagging only so a
future refactor doesn't "fix" `imessageOwnsTurn`/`telegramOwnsTurn` under
the mistaken assumption that channel ownership and delivery channel must
match.

### Finding B7 — confirmed non-issue: wakeups never target a group conversationId

`file:line`: `agent/lib/group-guard.ts:44-47` (`groupPersonalBlock` refuses
`browser_task`/`profile_setup` inside any group turn, at
`browser_task.ts:448-449`); `convex/tenants.ts` `claimBrowserWakeup` returns
`conversationId: existing.inkboxConversationId` — the tenant's personal
1:1 conversation id, never a group's; `agent/channels/telegram.ts:218`
(`if (!msg || !isPrivateChat(msg)) return 204`) and
`agent/channels/imessage.ts:539-541` (`if (msg.is_group) return 204`) both
mean group inbound never reaches tenant-binding in the first place for
either channel. Since a browser errand can never be *started* from a group
turn, and the follow-through wakeup always targets the tenant's own
`inkboxConversationId`/`lastChannel`, there is no path for a `browser_poll`
wakeup to land in a group chat. No fix needed; noted per the audit's
explicit question.

---

## Ideas (beyond bugs)

1. **Unify the two same-turn dedupe systems** (`spokeTurns` in
   `early-deliver.ts` and `earlySent` in `turn-delivery-events.ts`) into one
   shared map keyed by turnId, so any bubble sent through *either*
   `deliverHumanRouted` (tools) or `deliverTurnBubble` (streaming/completion)
   is visible to the other. Size: M. Files: `agent/lib/early-deliver.ts`,
   `agent/lib/turn-delivery-events.ts`, `agent/lib/deliver-routed.ts`,
   `agent/tools/browser_task.ts`, `agent/tools/profile_setup.ts`.
2. **Durable wakeup-delivery ledger** replacing/backstopping the in-memory
   `wakeupDelivered` map, reusing the existing `tenants.browserWakeupClaim`
   pattern or a small `wakeupDeliveries` table keyed by `idempotencyKey`,
   checked inside the `/internal/wakeup` HTTP handler itself before
   `from().send()`. Size: M. Files: `convex/tenants.ts` (or a new table +
   mutation), `agent/channels/imessage.ts`.
3. **One "errand session" charge id** for billing, shared across
   `profile_setup` → `browser_task` → pay-forced-restart, mirroring
   `startBrowserErrand`'s `workerSessionId` dedup. Size: M. Files:
   `convex/tenants.ts`, `agent/tools/browser_task.ts`,
   `agent/tools/profile_setup.ts`, `agent/lib/convex.ts`.
4. **Remove the unreachable `[SILENT]` branch from the `browser_poll` wakeup
   prompt** (`imessage.ts:702`) given `nextFollowDecision` never sends this
   wakeup while `status` is still "running" — every `browser_poll` HTTP
   call that reaches eve already represents `done` or `giveup`. Simplify the
   prompt to always require a visible reply, backed by a `turn.started`
   system steer like `job_check`'s. Size: S. Files: `agent/channels/imessage.ts`,
   `agent/instructions/jobs.ts`, a small new pure policy function.

## Open questions

- Whether `from(conversationId).send()` inside `/internal/wakeup` can
  itself dedupe by some session/turn-level idempotency token on the
  eve/Photon SDK side (outside this repo) — if the underlying `send()` API
  already offers an idempotency key parameter, finding B2's fix might be a
  one-line addition instead of a new Convex table. Could not determine from
  this repo alone (the SDK internals are outside `agent/`/`convex/`).
- Whether Convex workflow `step.runAction` retries for `wakeupAgent` can
  themselves overlap in wall-clock time (true concurrency, not just
  sequential retries) — if the workpool never runs two attempts of the same
  step concurrently, finding B2's "different Vercel instance" scenario
  still applies to *sequential* retries after a lost response, but the
  "two Convex-side claims racing" sub-case may be less likely than the text
  above implies. Not fully verifiable from the policy/workflow code alone
  without the `@convex-dev/workflow`/workpool package internals.
- Whether `agent/tools/browser_task.ts`'s billing-gate-forced restart on
  `pay` (finding B4, step 4) is deliberate product intent ("payment is
  always worth a fresh charge because it's genuinely a new run with new
  secrets") rather than an oversight — the code comment
  ("secretBindings are run-scoped, so a paid errand can never just
  'reuse'...") explains the *technical* necessity of a fresh run, but does
  not address whether that fresh run should be billed as a *second job*.
  This is a product decision this audit surfaces but cannot resolve alone.
