# A1 — Cloud client + run/session lifecycle

Read first: `goal.md` (this folder), `agent/lib/browseruse.ts`, `convex/lib/browseruse.ts`,
`agent/lib/browser-policy.ts`, `convex/lib/browserFollowPolicy.ts`, `convex/browserFollow.ts`,
`agent/tools/browser_task.ts`, `scripts/browser-policy-check.ts`, `scripts/browser-queue-check.ts`.
Vendor facts (verified against docs.browser-use.com/cloud/api-v4/**, openapi at
docs.browser-use.com/openapi/v4.json — fetch them yourself before coding):
`POST /runs/{id}/cancel` (idempotent), `PATCH /browsers/{id}` `{"action":"stop"}`,
`GET /browsers` items `{id, status, liveUrl, cdpUrl, agentSessionId, …}`,
run/session status enum is exactly `queued|dispatching|running|completed|failed|cancelled`,
no webhooks, browsers live until stopped or the 4 h hard cap.

Files you own in this package (do not touch others): `agent/lib/browseruse.ts`,
`convex/lib/browseruse.ts`, `agent/lib/browser-policy.ts`, `convex/lib/browserFollowPolicy.ts`,
`convex/browserFollow.ts`, `scripts/browser-policy-check.ts`, `scripts/browser-queue-check.ts`,
plus the reset/start branch of `agent/tools/browser_task.ts` only where listed below.

## Changes

1. **`cancelRun(runId)`** in `agent/lib/browseruse.ts` and `convex/lib/browseruse.ts`
   (`POST /runs/{id}/cancel`, swallow 404/409, never throw to callers — return boolean).
   **`stopBrowserForSession(sessionId)`**: `GET /browsers` → `browserFromList` → `PATCH /browsers/{id}`
   `{action:"stop"}`; best effort, boolean.
2. **Status enum**: `isTerminal` / `DONE` / `ACTIVE` sets = the documented six + our own
   sentinel `stalled` (terminal). Remove `stopped|error|canceled|started|in_progress|working|processing`
   only if no check depends on them; otherwise keep as harmless superset but document.
   Add `export const STALLED_STATUS = "stalled"` in `convex/lib/browserFollowPolicy.ts`.
3. **Session per errand**: in `browser_task.ts` start branch, do NOT pass
   `tenant.browserSessionId` to `startRun` (fresh session). Before starting, if
   `tenant.browserRunId` is active → `cancelRun`; if `tenant.browserSessionId` → `stopBrowserForSession`
   (fire-and-forget with `.catch(console.error)`, but `await` them — Vercel may kill
   unawaited promises). Same on `reset`.
4. **Give-up stops the run**: in `followThrough` giveup branch (and the cap fallthrough)
   call a new `internalAction browserFollow.cancelRunAction({runId, sessionId})` before `wakeupAgent`,
   and patch the tenant `browserStatus: "stalled"` via `patchBrowserInternal` (same runId gate).
5. **`nextBrowserAction`**: new outcome `"busy"` when status is active AND
   `looksLikeNewJob(incoming)` AND `normalizeTask(incoming) !== normalizeTask(stored)`.
   Short pings («ну что», «как там», ≤ 3 words without errand keywords) stay `"poll"`.
   Treat `stalled` as done (so a new errand → `"start"`).
   Improve `looksLikeNewJob`: length ≥ 48 alone is not enough — require an errand keyword OR
   (length ≥ 48 AND no shared keyword with stored task). Keep the existing check table green;
   add cases: busy, stalled→start, long follow-up about the same errand → not start.
6. **Poll cadence**: `followSleepMs(i)` = 10 s, 15 s, 20 s, 30 s, 45 s, 60 s, then 90 s; `maxPollRounds()`
   recomputed so the total still ≈ `POLL_GIVE_UP_MS` (20 min). Export a pure
   `followSchedule()` for the check.
7. **`hydrate` primary fetch guarded**: `GET /runs/{id}` failure → return last-known
   `{runId, sessionId, status: "unknown"}` instead of throwing; `waitForRun` must never throw.
8. **`startFollowThrough`**: when `workflow.cancel` throws, still `workflow.start` for the new run
   (the old workflow is guarded by `sameBrowserRun`). Log, don't return `retry_later`.
9. **Result scrub**: `scrubCloudResult(text)` pure function (PAN 13–19 digits with spaces/dashes,
   `password|пароль\s*[:=]\s*\S+`, CVV-like `cvc|cvv\s*[:=]?\s*\d{3,4}`) applied in both `hydrate`s
   before the result is stored/returned. Reuse/move `stripSecrets` from `agent/lib/order-policy.ts`
   into a shared pure module `convex/lib/secretScrub.ts` and import it from both places
   (order-policy.ts may import it — that one-line import change is allowed).
10. **Profile identity**: `createProfile(phone)` must send a hashed name
    (`bro-<sha256(“browseruse-profile\0”+phone).slice(0,40)>`) as both `name` and `userId`.
    `envSyncedProfileId()` applies only when `process.env.BROWSER_USE_PROFILE_PHONE` equals the
    tenant phone (new optional env; document in `.env.example`); otherwise a per-tenant profile
    is created. Signature: `envSyncedProfileId(phone, raw?, ownerPhone?)`; update the two call sites
    (`browser_task.ts resolveSyncedProfile`, `profile_setup.ts` — that one-line call-site change is allowed).
11. Delete dead `POLL_GIVE_UP_MS`/`pollTimedOut` in `agent/lib/browser-policy.ts` and their check lines.
12. **Password-shaped task guard**: at the top of `browser_task.execute`, if
    `looksLikePasswordDump(task)` → `{status:"invalid", hint:"это похоже на пароль сайта, не поручение — пароль в чат не нужен"}`.

## Checks
- Extend `scripts/browser-policy-check.ts` (busy / stalled / follow-up / schedule) and
  `scripts/browser-queue-check.ts` (fetch-mock: reset issues cancel + stop before the new
  `POST /runs`; giveup path calls cancel; `hydrate` survives a 500 on `/runs/{id}`; scrub cases).
- `npm run -s browser:check && npm run -s queue:check && npm run -s orders:check && npm run types:check`
  and `PATH=$SCRATCH/node24/bin:$PATH npx eve build` (errors == 0).

## Out of scope here
Structured outcome parsing, wakeup payload, tenant schema fields, instructions — those are
packages A2/A3/A4. Do not edit `agent/channels/*`, `convex/schema.ts`, `convex/tenants.ts`.
If you need a tenant field, note it in your report; A2 adds schema.
