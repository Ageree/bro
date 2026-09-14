# B2 — worker (Kernel) / otp hardening

Read first: `goal.md`, `audits/A4-worker-otp.md`, `agent/subagents/worker/**`,
`agent/subagents/otp/**`, `agent/lib/otp-policy.ts`, `agent/lib/otp-lookup.ts`,
`convex/browsers.ts`, `convex/crons.ts`, `scripts/worker-check.ts`, `scripts/otp-check.ts`.

Files you own: everything under `agent/subagents/worker/**` and `agent/subagents/otp/**`,
`agent/lib/otp-policy.ts`, `agent/lib/otp-lookup.ts`, `agent/tools/otp_lookup.ts`,
`convex/browsers.ts`, `convex/crons.ts` (one added cron only), `scripts/worker-check.ts`,
`scripts/otp-check.ts`. Do NOT edit `agent/instructions.md` (package A4 does; put the exact
lines you want there into your report).

## Changes

1. **Secret read-back guard for `execute_playwright_code`** (P0):
   - Pure `playwrightCodeRisk(code: string): string | null` in
     `agent/subagents/worker/lib/code-guard.ts`: flags `.value`, `inputValue(`, `context.cookies`,
     `document.cookie`, `vaultSecret`, `data-vault-secret`, `localStorage`, `sessionStorage`,
     `evaluate(` reading `value` of inputs. Return a Russian reason.
   - Track per worker session (module Map keyed by `ctx.session.id`, plus a persisted flag if easy)
     whether `fill_from_vault` ran; after that, code matching the guard is refused with a clear tool
     error («после ввода из сейфа значения полей читать нельзя»). Before any vault fill the guard only
     warns (return `{warning}` alongside the result).
   - Always redact the tool `result`/logs with a `redactSecretShapes(text)` pure function
     (PAN 13–19 digits, CVV `\b\d{3,4}\b` next to `cvc|cvv`, `password|пароль` values) before
     `boundedResult`. Reuse `convex/lib/secretScrub.ts` if package A1 has created it by the time you
     start (check `ls convex/lib/secretScrub.ts`); otherwise create it there with `scrubSecrets(text)`
     and A1 will reuse yours — coordinate via the file, do not duplicate.
2. **Kernel timeout**: `browserTimeoutFloorSeconds` stays 15 min for reads, but `manage_browsers create`
   defaults to **45 min** when `save_changes` is true OR the start_url host is a login/checkout/
   passport page OR the input has `long_lived: true` (new optional schema flag). Add a pure
   `defaultBrowserTimeoutSeconds({saveChanges, startUrl, longLived})` and test it. Tell the model in
   `instructions.md`/`SKILL.md` (worker's own files) to pass `long_lived: true` for login/OTP/checkout
   assignments.
3. **Worker output**: `taskCompletionSchema` += optional `liveViewUrl` (https URL) and
   `needs` (`none|otp|push|3ds|captcha|profile_sync|approval`). Update worker `instructions.md`
   and `skills/browser-execution/SKILL.md` to fill them (URL goes in the field, not only in `message`).
4. **OTP ranking with hint** (`agent/lib/otp-policy.ts pickOtp`/`findFreshOtp`): when `hint` is given,
   candidates whose `from`/`subject` match the hint (case-insensitive substring, or the site's
   `KNOWN_SENDERS` entry) get +3 rank; candidates clearly from a *different* known sender get −3; if the
   top candidate does not match the hint while another fresh one does → `ambiguous`. Add check cases
   (WB code vs bank code with hint "wildberries").
5. **GC of Kernel browsers**: Convex cron every 30 min `browsers.sweepStale` (internal): for
   `browserSessions` rows older than 3 h, drop the row; if `KERNEL_API_KEY` exists on the Convex
   deployment, also `DELETE` the Kernel browser (best effort, use fetch to Kernel REST
   `https://api.onkernel.com/browsers/{id}` with Bearer — verify the path in `@onkernel/sdk`
   `resources/browsers/browsers.d.ts` before using). Pure `isStaleBrowserSession(row, now)` + check.
6. **worker instructions line for 3DS/Cloud**: in worker `instructions.md` add: «You never finish a
   challenge that appeared in another browser (the root's Cloud tab); if the assignment describes
   a 3-D Secure/OTP page you did not open, return `failure` with `needs: approval` and say the root
   must use the Cloud live-view.» Report the matching root-instruction line for A4.

## Checks
`scripts/worker-check.ts`: guard table (risky vs safe code), redaction cases, timeout defaults,
schema has `liveViewUrl`/`needs`, stale predicate. `scripts/otp-check.ts`: hint ranking.
Run: `npm run -s worker:check && npm run -s otp:check && npm run types:check && npm run -s schema:check`
and `PATH=$SCRATCH/node24/bin:$PATH npx eve build`.
