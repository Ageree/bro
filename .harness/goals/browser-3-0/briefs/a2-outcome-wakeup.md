# A2 — Structured outcome («НУЖНО» protocol) + wakeup carries the result + durable dedupe

Runs AFTER A1 and B1 are merged. Read first: `goal.md` §1–2, audits `A3-login-pay.md` (F1, F4),
`A2-inject.md` (Ideas 1–3), `A5-ux-prompts.md` (F7, Appendix B, Appendix E), `A7-checks-channels.md`
(B2, B3), `A1-lifecycle.md` (F3, F4). Then the code: `agent/lib/browseruse.ts` (scaffoldTask,
errandLoginBlock, errandFinishBlock), `agent/lib/browser-pay.ts` (payScaffold/loginScaffold),
`convex/browserFollow.ts`, `convex/lib/browserFollowPolicy.ts`, `convex/tenants.ts` (browser
mutations), `convex/schema.ts`, `convex/wakeups.ts`, `agent/lib/wakeup-dedupe.ts`,
`agent/channels/imessage.ts` (`/internal/wakeup`, `/internal/session-clear` as a template for a
secret-gated route), `agent/lib/silent-turn.ts`, `agent/lib/turn-delivery-events.ts`,
`agent/instructions/jobs.ts`, `agent/lib/convex.ts`, `convex/lib/browserInjectPolicy.ts`
(read-only: `resultWaitsForCode`, `need` attr added by B1), `agent/lib/order-policy.ts`.

Files you own: `convex/schema.ts`, `convex/tenants.ts`, `convex/browserFollow.ts`,
`convex/lib/browserFollowPolicy.ts`, NEW `convex/lib/browserOutcomePolicy.ts`, `convex/wakeups.ts`
(one new mutation), `agent/lib/browseruse.ts` (scaffold functions only), `agent/lib/browser-pay.ts`
(scaffold strings only), `agent/channels/imessage.ts` (`/internal/wakeup` + new `/internal/deliver`),
`agent/lib/wakeup-dedupe.ts`, `agent/lib/silent-turn.ts`, `agent/lib/turn-delivery-events.ts`
(only the wakeup fallback hook), `agent/instructions/jobs.ts` (browser_poll force-speak only),
`agent/lib/convex.ts` (new client wrappers), `agent/lib/order-policy.ts` (use the labelled parse
first), checks: `scripts/wakeups-check.ts`, `scripts/orders-check.ts`, NEW `scripts/browser-outcome-check.ts`.
Do NOT edit `agent/tools/browser_task.ts` / `profile_setup.ts` (package A3) or `agent/instructions.md` (A4).

## 1. Scaffold (agent/lib/browseruse.ts, agent/lib/browser-pay.ts)
Replace `scaffoldTask` body with the ≤25-line Russian scaffold from A5 Appendix B, adapted:
- keep the `[bro-errand]` mark and idempotency guard; keep `startPage` line; keep dry-run rule;
- login block: explicit if/else — «Если видишь «Войти» — войди сам (сейф / паспорт / телефон).
  Нет пароля и без него нельзя → НУЖНО: password. Код из SMS → НУЖНО: sms_code. Код на почту →
  НУЖНО: email_code. Подтверждение в приложении/пуш → НУЖНО: push.»;
- pay block (`payScaffold`): 3-D Secure → `НУЖНО: 3ds`; keep secrets wording;
- new lines: close cookie/promo banners; pick the city from the task; never add to cart twice;
  after checkout verify an order number is on screen; captcha with no way out → `НУЖНО: captcha`;
- mandatory final block, exactly:
  ```
  СДЕЛАНО: <одна фраза>
  ЗАКАЗ: <номер или нет>
  СУММА: <число ₽ или нет>
  КОГДА: <дата/время/ETA или нет>
  ВАРИАНТЫ: <до 5 «название — цена — ссылка», через ; или нет>
  НУЖНО: none|sms_code|email_code|push|3ds|captcha|password|address|payment|info
  ДЕТАЛИ: <что именно нужно от человека, одна строка, или нет>
  ```
  and the sentence «Никогда не пиши в итог пароль, номер карты или код.»
- The stale phrase «остановись и дай live-URL» is removed everywhere (the agent cannot know its
  live URL; Bro has it). `loginVaultTask`/`loginWaitTask` in `browserProfilePolicy.ts` are NOT yours;
  leave them.

## 2. `convex/lib/browserOutcomePolicy.ts` (pure)
```ts
export type CloudNeed = "none"|"sms_code"|"email_code"|"push"|"3ds"|"captcha"|"password"|"address"|"payment"|"info";
export type CloudOutcome = { done?: string; orderId?: string; amountRub?: number; when?: string;
  options?: string[]; needs: CloudNeed; detail?: string; labelled: boolean };
export function parseCloudOutcome(result: string | null | undefined, opts?: { status?: string }): CloudOutcome
```
Labelled lines first (case-insensitive, tolerate `NEEDS:` as alias of `НУЖНО:`, «нет»/«none»/«-»
= empty). If no `НУЖНО` label: `labelled:false` and a heuristic `needs` from
`resultWaitsForCode`-style regexes (sms/смс/код → sms_code; почт/email → email_code; пуш/push/
приложени → push; 3-d|3ds|3d secure → 3ds; капч|captcha → captcha; парол → password;
адрес → address). Also export `needsHuman(need)` (everything except none) and
`humanLineForNeed(need, opts: { site?: string; liveUrl?: string; detail?: string })` returning the
fluent Russian line Bro sends: sms_code → «Нужен код из SMS — пришли его сюда, введу сам.»;
email_code → «Код ушёл на почту, сейчас гляну.» (the model will try `otp_lookup` first);
push → «Подтверди вход в приложении банка/Яндекса и напиши «готово».»; 3ds → «Банк просит
подтвердить оплату — открой ссылку, подтверди и напиши «готово».\n\n<liveUrl>»; captcha →
«Сайт показал капчу — реши по ссылке и напиши «готово».\n\n<liveUrl>»; password → «Нужен вход —
открой ссылку и войди, пароль я не увижу.\n\n<liveUrl>» (or without link: «…добавь вход в сейф»);
address/payment/info → detail-driven one question. Never English. Also `doneLineHint(outcome)`
that turns СДЕЛАНО/ЗАКАЗ/СУММА/КОГДА into a 1–2 line Russian «готово» draft the model may reuse.

## 3. Tenant state (convex/schema.ts, convex/tenants.ts)
Add optional: `browserNeed: v.string()`, `browserNeedSince: v.number()`, `browserNeedDetail: v.string()`,
`browserPaying: v.boolean()`, `browserPayHosts: v.array(v.string())`, `browserNextTask: v.string()`,
`browserOutcome: v.string()` (last scrubbed result ≤ 2000 chars, for wakeup/resume), plus table
`wakeupDeliveries: { key: string, at: number }` with index `by_key`. Extend `setBrowser` args and
`patchBrowserInternal` to accept the new fields (same runId gate). `setBrowser` with a NEW runId
must clear `browserNeed*`, `browserOutcome`, and keep `browserNextTask`. A `clearBrowserNeed`
internal mutation is fine. Keep `doc(schema, …)` validators (npm run schema:check).

## 4. Follow-through (convex/browserFollow.ts, browserFollowPolicy.ts)
- `pollRun` on a terminal status: `parseCloudOutcome(run.result)` → patch `browserNeed`/`Since`/
  `Detail`/`browserOutcome`; return `need` + `outcome` fields.
- Workflow: phases `done | need | failed | giveup` (`WakeupPhase` union) — `need` when
  `needsHuman(need)`; `failed` when status `failed|cancelled`. `wakeupIdempotencyKey(runId, phase)` unchanged.
- `wakeupAgent` POST body adds `phase`, `need`, `needDetail`, `result` (scrubbed, ≤ 2000), `liveUrl`
  (fresh: prefer `GET /browsers` liveUrl for the session via `convex/lib/browseruse.ts`),
  `nextTask` (tenant.browserNextTask), `site` (host of errandStartUrl/stored task if any).
  After a successful `done`/`failed`/`giveup` wakeup with `need === "none"`: stop the Cloud
  browser (`stopBrowserForSession` from A1) — the errand is over. On `need` keep it.
- The login-link send inside `pollRun` must honor `lastChannel`: call eve `POST /internal/deliver`
  (`{secret, tenantPhone, text}`) when `EVE_URL` is set; fall back to `cabinet.sendText`.
- Waiting sweep: `internalAction browserFollow.sweepWaiting` on a 10-min cron (add to
  `convex/crons.ts` — B2 also adds one cron there; merge, don't overwrite): tenants with
  `browserNeed` set for > 40 min → stop browser, cancel run, set `browserStatus: "stalled"`, clear
  need, and send one line via `/internal/deliver`: «Не дождался <кода/подтверждения> — когда
  будешь готов, напиши, продолжу.» Needs an index `by_browserNeedSince` or a bounded scan of
  tenants with `browserNeed` (add `.index("by_browserNeed", ["browserNeed"])`).

## 5. eve wakeup route (agent/channels/imessage.ts) + durable dedupe
- Parse the new body fields. Before `from().send`, call Convex `wakeups.takeDelivery({secret, key})`
  (new mutation: insert into `wakeupDeliveries` if absent → `{taken:true}`, else `{taken:false}`);
  keep the in-memory map as a pre-check. Prune rows older than 2 days in the existing
  `pickup overdue wakeups` cron handler or a new small cron.
- Prompts per phase (Russian, precise, no tool call needed to report):
  - `done`: «[background wakeup] Поручение «<task>» завершено. Итог браузера:\n<result>\n
    Напиши человеку «готово»-сообщение: что сделано, номер заказа/записи, сумма, когда/куда —
    1–2 коротких пузыря, без канцелярита. Если в итоге есть ВАРИАНТЫ — одно сообщение «нашёл N
    вариантов: …» одной строкой на вариант с ценой, ссылки не вставляй, кроме случая когда просят.
    Не вызывай browser_task для проверки — результат уже здесь.» + if `nextTask`: «Затем сразу
    начни отложенное поручение «<nextTask>»: одна короткая строка человеку и browser_task с этим
    текстом.»
  - `need`: «[background wakeup] Браузер остановился: нужно <need> (<detail>). Отправь человеку
    ровно: «<humanLineForNeed(...)>». Не проси пароль. Ничего больше не делай.» For `email_code`:
    «Сначала вызови otp_lookup (hint: <site>). Если код найден — первая строка «код из почты,
    ввожу», затем browser_task с этим кодом. Если нет — отправь: «<line>».»
  - `failed`: «…не получилось: <short reason from result>. Скажи одной строкой и предложи
    попробовать ещё раз или сделать иначе; без слов «джоб», «reset», «Cloud».»
  - `giveup`: «…я остановил задачу, она зависла на <site>. Скажи это одной строкой и предложи
    начать заново.»
  - Stamp `wakeupPhase`, `wakeupFallback` (the exact canned line for need/failed/giveup, and for
    done a minimal «Готово: <СДЕЛАНО>» line) on the auth attributes.
- New route `POST /internal/deliver` (secret-gated): `{tenantPhone, text}` → look up tenant →
  `deliverHuman({tenant, conversationId: tenant.photonConversationId ?? tenant.inkboxConversationId, text})`
  (honors `lastChannel`). Return `{ok:true}`.

## 6. Never-silent wakeups
- `agent/lib/silent-turn.ts`: `fallbackForFailed` / the empty-or-[SILENT] fallback returns
  `attrs.wakeupFallback` when origin is `wakeup` and the attr is present (pure function
  `wakeupFallbackText(attrs)`); wire it where `[SILENT]`/empty completion is handled in
  `agent/lib/turn-delivery-events.ts` (read how `fallbackForFailed`/`takeFallbackSlot` are used;
  add the same for a completed-but-silent wakeup turn whose attrs carry `wakeupFallback`).
- `agent/instructions/jobs.ts`: when `attrs.wakeupKind === "browser_poll"` and `wakeupPhase` is
  done/need/failed/giveup → system steer «Do NOT answer [SILENT]; the human must get one message.»
  (pure `browserPollForceSpeak(attrs)` in `agent/lib/job-wake.ts` or `silent-turn.ts` + check).

## 7. Orders
`agent/lib/order-policy.ts parseOrderFromResult`: try `parseCloudOutcome` first (labelled →
orderId/amount/title from СДЕЛАНО or task); keep regex fallback. Existing `orders-check` stays green;
add labelled cases.

## Checks
NEW `scripts/browser-outcome-check.ts` (parser table: labelled, aliases, «нет», heuristic fallback,
`humanLineForNeed` never contains a password / never English words, done-line hints), extend
`scripts/wakeups-check.ts` (phase union, idempotency keys, takeDelivery semantics via a fake ctx if
feasible, `wakeupFallbackText`, `browserPollForceSpeak`), `scripts/orders-check.ts`.
Add the new script to `package.json` (`"outcome:check"`). Run all: `npm run -s outcome:check &&
npm run -s wakeups:check && npm run -s orders:check && npm run -s browser:check && npm run -s
queue:check && npm run -s inject:check && npm run -s jobs:check && npm run -s silent:check &&
npm run -s schema:check && npm run types:check` and `npx eve build` on Node 24.
