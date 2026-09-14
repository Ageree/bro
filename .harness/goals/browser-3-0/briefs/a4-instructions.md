# A4 — Root instructions, texts, README/env

Runs LAST (after A1–A3, B1–B2). Read first: `goal.md` §7, audit `A5-ux-prompts.md` (F5, F9, F10,
F11, F13, F14, Appendix C/D/E/F), `A4-worker-otp.md` (F3, F4), `A1-lifecycle.md` (F4),
B2's report lines for worker routing, then `agent/instructions.md`, `agent/instructions/jobs.ts`,
`agent/tools/browser_task.ts` (its `description` + hints as they are NOW), `agent/tools/profile_setup.ts`
(description), `agent/tools/job_wait.ts`, `README.md`, `.env.example`, and every check that greps
`agent/instructions.md` (`grep -l "instructions.md" scripts/*.ts`).

Files you own: `agent/instructions.md`, `agent/tools/browser_task.ts` (description string only),
`agent/tools/profile_setup.ts` (description string only), `agent/tools/job_wait.ts` (description
only), `README.md`, `.env.example`, and the instruction-grep assertions inside existing checks
(`scripts/otp-check.ts`, `scripts/browser-inject-check.ts`, `scripts/profile-sync-check.ts`,
`scripts/jobs-check.ts`, others found by grep).

## Rewrite (agent/instructions.md)
Replace sections **Browser**, **Login / vault**, **OTP**, **Purchase / orders** and the browser
bullets of **Проактивность** with A5 Appendix C, adapted to the shipped protocol:
- one cloud job per person; `busy` → «сначала закончу X, потом Y» (queued automatically, never
  `profile_setup`, never a second job); «отмени/забудь/начни заново» → `browser_task` with
  `reset:true` and the new task;
- `[background wakeup]` phases: done → готово-message from the result already in the prompt (no
  tool call); need → send the given line exactly; email_code → `otp_lookup` first; failed/giveup
  → one line + offer; never `[SILENT]` on these;
- inject table: code → «ввожу код»; «подожди» → «подожду»; correction → «ввожу»; confirm
  («подтвердил/готово/вошёл/оплатил») → «проверяю»; each followed by `browser_task` with the exact
  human line; no password ever;
- `profile_setup` only when NO job is running, with `errand` = the original ask; cookies ≠ login;
- `worker` routing (from B2's report): worker is a second independent browser for one-screen
  Playwright work on its own site; **never** to finish 3-D Secure / OTP / captcha that appeared in
  the Cloud tab (that is the Cloud live-view link); pass `long_lived: true` guidance implicitly via
  worker's own instructions (root only needs the routing rule);
- jobs: do not `job_open`/`job_wait` for a plain browser errand (browser_task follows through
  itself); use jobs only for human/email waits after the browser step;
- canonical tool-result → reply table (A5 Appendix C) extended with `busy`, `ack`, `invalid`,
  `no_wait`, `needs_vault`, `limit`, `followUp:"retry"`, `landed:false`, `liveUrl`;
- reply formats (A5 Appendix D): options found (one bubble, «нашёл N вариантов: …»), ordered
  (≤ 2 bubbles), needs X (one question or link on its own line);
- static Voice rule carve-out for fast-ack (A5 F13);
- remove duplicated OTP/Browser bullets (A5 F14); remove «Cloud» as a stand-alone word — say
  «браузер»/«открытая страница».
Keep the file about the same length or shorter. Keep every rule that other sections rely on
(Trust, Memory, Telegram) untouched.

## Tool descriptions
`browser_task` description: rewrite to ≤ 900 chars matching the new behaviour (busy, confirm,
need, pay, reset, no password). `profile_setup`: add `errand`. `job_wait`: note browser errands
do not need it.

## README / env
README: update the «Site logins», «browser_task», «doводка»/latency paragraphs with the new
protocol (НУЖНО, busy queue, cancel on reset/give-up, session per errand, hashed profile name,
`BROWSER_USE_PROFILE_PHONE`, wakeup carries result, durable wakeup dedupe, waiting sweep 40 min,
worker `long_lived`, Kernel GC), and list the new checks (`outcome:check`, `browser-task:check`,
`glue:check` if present). `.env.example`: `BROWSER_USE_PROFILE_PHONE`, remove nothing.

## Checks
Update instruction-grep assertions so `npm run -s otp:check inject:check profile:check jobs:check
browser:check worker:check` all pass with the new text (never delete a check that guards a safety
rule — reword its expected substring). Add a small `scripts/instructions-check.ts` (`instructions:check`):
asserts the file contains the canonical table header, contains no «джоб»/«reset»/«3-D Secure the
cloud job», contains «проверяю» / «ввожу код» / «подожду» / «сначала закончу». Run `types:check`
and `eve build` on Node 24.
