# A3 — browser_task / profile_setup wiring: busy queue, pay persistence, login, hints

Runs AFTER A1, B1, A2 are merged. Read first: `goal.md` §3–5, audits `A3-login-pay.md`
(F2, F4–F7, F9, F11), `A5-ux-prompts.md` (F1, F3, F11), `A7-checks-channels.md` (B1, B4),
`A1-lifecycle.md` (F1, F6, F10), `A2-inject.md` (F2). Code: `agent/tools/browser_task.ts`,
`agent/tools/profile_setup.ts`, `agent/lib/vault-login.ts`, `agent/lib/browser-policy.ts`
(A1's `busy`), `convex/lib/browserInjectPolicy.ts` (B1's `confirm`, `need`, `browserProbed`),
`convex/lib/browserOutcomePolicy.ts` (A2), `convex/tenants.ts` (A2's fields), `agent/lib/early-deliver.ts`
(`turnSpoke`/`markTurnSpoke`), `agent/lib/fast-ack.ts` (`fastAckOf`), `convex/lib/billingPolicy.ts`.

Files you own: `agent/tools/browser_task.ts`, `agent/tools/profile_setup.ts`, `agent/lib/vault-login.ts`,
`convex/lib/browserProfilePolicy.ts` (texts + one helper), `convex/lib/billingPolicy.ts` +
`convex/tenants.ts` (`countBrowserJobStart` only, for the charge key), `agent/lib/convex.ts`
(wrappers you need), checks `scripts/profile-sync-check.ts`, `scripts/browser-pay-check.ts`,
`scripts/purchase-check.ts`, `scripts/vault-check.ts`, NEW `scripts/browser-task-check.ts`.

## browser_task.ts
1. **Busy → queue.** `nextBrowserAction === "busy"` → persist `browserNextTask = task` (replace any
   previous), return `{status:"busy", activeTask: tenant.browserTask, queuedTask: task,
   hint:"скажи одной строкой: сначала закончу <activeTask>, потом сделаю <task>. Не вызывай
   profile_setup."}`. If the human says «отмени/брось/забудь» → that is `reset` territory
   (instructions, A4). When a run starts (any `start`) and `tenant.browserNextTask ===
   normalizeTask(task)`, clear `browserNextTask`.
2. **Pay persistence.** On a paid start persist `browserPaying:true, browserPayHosts`; on any other
   start persist `browserPaying:false, browserPayHosts:[]`. `maybeRecordOrder` uses
   `extra.paying ?? tenant.browserPaying` and hosts from `tenant.browserPayHosts`; also gate on
   `parseCloudOutcome(run.result).needs === "none"` (no order row for a stopped-at-3DS run).
3. **Vault login for keyword errands**: compute `startPage = errandStartUrl(task)` BEFORE
   `loginPages` and include it. Also include `tenant.browserNextTask`? No.
4. **`needsProfileSync` suppressed** when `vaultLogin` was bound to this run, or when
   `parseCloudOutcome` of the last result says need ≠ password. `profileExtra(resolved, startPage,
   { vaultLogin: Boolean(vaultLogin) })`.
5. **Inject wiring**: pass `need: tenant.browserNeed`, `browserProbed: true/false` (true when
   `findBrowserForSession` resolved without throwing) into `decideCloudInject` / `cloudSessionLooksLive`
   attrs; `confirm` kind: no CDP typing, queue only, interrupt false; after a successful queue for
   any kind clear `browserNeed*` (`setBrowser` / a `clearBrowserNeed` wrapper from A2). When
   `queueMessage` fails: `hint` must say the code did NOT reach the page:
   «не удалось передать <код/подтверждение> в открытую страницу — скажи, что страница уже закрылась,
   и предложи начать заново» and `entered:false`; `status:"no_wait"` if the browser is gone.
6. **One «ищу» bubble**: the tool's own notify is skipped when `fastAckOf(attrsFromSession(ctx.session))`
   is set OR `turnSpoke(turnId)`; when sent, call `markTurnSpoke(turnId, now)` and use the short
   text «ищу, сам напишу как будет готово» (≤ 6 words). Same in `profile_setup`.
7. **Reuse after done + short ack**: when action is `reuse` and `!looksLikeNewJob(task)` and the
   text is ≤ 3 words with no question mark → return `{status: run.status, reused:true, ack:true,
   hint:"это подтверждение, не пересылай результат заново; одна короткая строка или реакция"}`.
8. **Jargon**: replace every human-facing/hint string per A5 Appendix F (no «джоб», «reset»,
   «Cloud», «browser_task» inside hints that the model may relay; hints may still name the tool
   the model must call, phrased as an instruction, e.g. «вызови browser_task ещё раз» is fine, but
   never as text to relay).
9. **Stalled**: a `poll` on status `stalled` is impossible after A1 (it is done); make sure a new
   errand after stall starts fresh and `reset` cancels + stops (A1 did the calls; verify).
10. **Billing**: charge once per errand: `countBrowserJobStart(phone, { chargeKey })` where
    `chargeKey` = `tenant.browserSessionId` when continuing the same errand (pay-forced restart,
    login → errand within 30 min) else a fresh key; implement the dedupe in `convex/tenants.ts`
    via the existing `browserCharges` table pattern (`by_worker` index → add a generic key column
    or reuse `workerSessionId` with a `cloud:` prefix). `profile_setup` never charges.
    Refund is unnecessary once the charge is keyed (a failed start re-uses the key).

## profile_setup.ts
11. **Reuse guard**: if `tenant.browserRunId` is active AND `isLoginWaitTask(tenant.browserTask)`
    AND `loginPageFromTask(tenant.browserTask)` shares host with `page` AND started < 15 min ago →
    do not start a new run: hydrate, and if `landed && liveUrl && !browserLoginLinkSentAt` send the
    link (claim via `setBrowser` with `browserLoginLinkSentAt`), else return `pending` with
    `alreadyNotified`. Cap: `pending` hint tells the model to call again at most once.
12. **`errand` param** (optional string ≤ 4000): the original errand to resume after login →
    persist `browserNextTask`. A2's wakeup `done` prompt then starts it (the login run's result
    «вошёл» is `done` with `need none`).
13. **No charge** (remove `countBrowserJobStart` here).
14. **Cookie cache invalidation**: helper `cookieCacheStale(tenant, now)` → refetch `getProfile`
    when `browserProfileSyncedAt` older than 24 h or `tenant.browserNeed === "password"`; on
    `need === "password"` clear `browserCookieDomains`.
15. Texts: `alreadyLoggedChatText` etc. stay; add `loginPayChatText` not needed (A2 handles 3ds).

## Checks
NEW `scripts/browser-task-check.ts`: source-level assertions (the tool calls `markTurnSpoke`,
imports `fastAckOf`, uses `browserPaying`, passes `need`, no jargon strings — grep list) plus pure
helpers you extract (e.g. `loginPagesFor(task, payHosts, startPage)`, `profileExtra` made pure,
`isAckLike(text)`, `chargeKeyFor(tenant, action, now)`). Extend `profile-sync-check.ts` (reuse
guard decision as a pure `nextLoginAction(...)`), `browser-pay-check.ts`, `purchase-check.ts`,
`vault-check.ts` (vault login bound for «вызови такси домой» given an origin
`https://taxi.yandex.ru` login — mock `listVaultItems`/`readVaultSecret` via a deps parameter on
`vaultPasswordLogin`). Add `"browser-task:check"` to package.json. Run all browser checks +
`types:check` + `eve build` on Node 24.

## Addendum (from B3's glue check)
16. `convex/lib/browserStartPolicy.ts` (you may edit this file): the WB branch `\bвб\b` never matches
    Cyrillic (ASCII `\b`). Use `(?:^|[^\p{L}])(?:wb|вб)(?:[^\p{L}]|$)` with the `u` flag (as
    `agent/lib/order-policy.ts merchantFromTask` does). Flip the `// KNOWN GAP` assertions in
    `scripts/browser-glue-check.ts` to the correct expectation («вб» → WB page). Same `\bвб\b`
    pattern exists in `convex/lib/browserInjectPolicy.ts correctionFitsTask` — leave it (B1's file),
    mention it in your report.
17. `partial: true` from `cdpTypeIntoPage` (B1): when set, treat as NOT typed for the
    `alreadyTyped` flag of `injectQueueText` (the queued Cloud message must carry the full code).
