# Audit 1 — Bro 2.0 (изолированный Auditor, 2026-08-27)

Всё перепроверено с нуля в worktree `/Users/saveliy/orca/workspaces/bro/plaice`
(HEAD `7b7991a`, ветка чистая, HEAD == origin/Ageree/plaice). Node 24, все
команды запускались заново; прошлым отчётам не доверял.

| Критерий | Verdict | Evidence |
|---|---|---|
| A1 eve build чистый | PASS | `npx eve build` exit 0; `.eve/agent-summary.json` → `{"errors":0,"warnings":0}`; все 12 кастомных тулов в списке (incl. schedule_wakeup, cancel_wakeup, browser_task) |
| A2 существующие проверки | PASS | перезапущены с настоящими exit-кодами: access / browser / connect-link / imessage / optmem — все `* ok`, exit 0 (плюс jobs:check ok) |
| B1 схема wakeups | PASS | `convex/schema.ts:68-92` — таблица `wakeups` (tenantPhone, at, kind, payload, status, recur*, tz, lastSeen, attempts), индексы `by_status_at ["status","at"]` + `by_tenant` |
| B2 функции schedule/cancel/due/claim | PASS | `convex/wakeups.ts`: `schedule`/`cancel`/`listForTenant`/`setLastSeen` — public, но все за `assertSecret` (`convex/secret.ts` fail-closed при пустом BRO_INTERNAL_SECRET); `claimDue`/`finish`/`dispatchDue` — internal. Claim атомарен: одна Convex-мутация (транзакция) выбирает только `status=="scheduled"` по индексу и патчит в `running` → повторный claim того же ряда невозможен. finish: retry с backoff (`backoffAt`, giveUp после 4), recur через `nextAfterRun` |
| B3 cron-диспетчер | PASS | `convex/crons.ts` — `crons.interval("dispatch wakeups", {seconds:60}, internal.wakeups.dispatchDue)`; dispatchDue POST-ит `${EVE_URL}/internal/wakeup` c timeout 60s, no-op без EVE_URL |
| B4 background-роут защищён | PASS | `agent/channels/imessage.ts:223-280` — POST `/internal/wakeup`: нет/неверный `BRO_INTERNAL_SECRET` → 401 (fail-closed и при пустом env); agent-ход через `from(conversationId).send(..., {auth: {principalId: tenantPhone}})` — tenant из тела запроса Convex, не из модели |
| B5 тулы schedule/cancel_wakeup | PASS | `agent/tools/schedule_wakeup.ts` / `cancel_wakeup.ts`: zod-схемы; время atIso / inMinutes / dailyHour / everyMinutes; tenant = `tenantId(ctx)` из `session.auth.principalId` (`agent/lib/tenant.ts` — «Never from the model») |
| B6 wakeups:check | PASS | `npm run -s wakeups:check` → `wakeups-check ok`, exit 0 (35 assert/throw: parseWhen прошлое/мусор, nextDailyAt tz, backoff, singleton/liveOfKind, splitSeen) |
| C1 browser follow-through | PASS | `agent/tools/browser_task.ts` `settle()`: не-терминальный run → `scheduleWakeup(kind:"browser_poll", recurMinutes:2)` (singleton — `SINGLETON_KINDS` в wakeupPolicy, дедуп в `schedule`); терминальный → `cancelWakeup(browser_poll)` — не пересоздаётся; poll-timeout → cancel + hint reset. Проактивная отправка: wakeup → `/internal/wakeup` kind browser_poll → prompt «если completed — отправь результаты» → `message.completed` шлёт bubbles. `browser:check` ok |
| C2 утренний бриф | PASS | `schedule_wakeup` dailyHour → `nextDailyAt(hour, "Europe/Moscow")` (tz-aware, wakeups-check проверяет час в tz); recur через `recurDailyHour` + `nextAfterRun` (default tz Europe/Moscow); brief-prompt в imessage.ts:258-260: «Если по ВСЕМ пунктам пусто — ответь [SILENT]»; `[SILENT]`-ответ не отправляется (message.completed:294) |
| C3 сторожа | PASS | watcher-wakeup хранит `payload` (что проверять) + `lastSeen`; prompt передаёт прошлое состояние, требует `[SILENT]` без дельты и `[SEEN] <state>` в конце; `splitSeen` отрезает [SEEN] (не уходит человеку) → `setWakeupLastSeen` (liveOfKind ловит running-ряд); re-schedule через recurMinutes → `finish` → `nextAfterRun` |
| C4 инструкции | PASS | `agent/instructions.md:58-…` — секция «Проактивность»: напоминания/бриф/сторожа/доводка, «нечего сказать — ровно [SILENT]. Никогда не выдумывай „новости“», «Не обещай „спроси меня позже“ про браузер-задачи» |
| D1 ЮKassa webhook | PASS | `convex/http.ts` POST `/yookassa` → `billing.verifyAndApply`: подлинность = idempotent re-fetch платежа по API (Basic shopId:secret), только `status==="succeeded"` + tenantId из metadata → `applyPayment` → `extendPaidUntil` = `max(now, paidUntil)+30d` (`billingPolicy.ts:39-44`). Плюс GET `/pay?tid=` → redirect на confirmation_url |
| D2 тенант: paidUntil/счётчики | PASS | `convex/schema.ts:20-25` — paidUntil, msgsDayKey/Count, browserMonthKey/Count, paywallSentDayKey; «plan» выводится из `isPaid(paidUntil)` (free/paid allowances) — отдельного поля plan нет, семантика покрыта |
| D3 enforcement в канале | PASS | `agent/channels/imessage.ts:139-165` — `countInboundMessage` → allow/paywall/drop; paywall = ОДИН мягкий ответ с pay-ссылкой (990 ₽/мес), `paywallSentDayKey` гарантирует один раз в день, дальше drop (не спам); billing-ошибка ≠ падение чата (fail-open allow). Browser-лимит: `countBrowserJobStart` в browser_task → status "limit" + hint про оплату |
| D4 billing:check | PASS | `npm run -s billing:check` → `billing-check ok`, exit 0 (31 assert: продление, окна dayKey/monthKey, paywallDecision boundary) |
| D5 без ключей не падает | PASS | `.env.local` не содержит YOOKASSA_* (проверены только имена ключей) — A1+A2+все check'и прогнаны именно без ключей, всё зелёное; `/pay` без ключей → 503 «оплата скоро»; `shopCreds()` кидает «billing disabled» только внутри billing-функций |
| E1 спайк outbound | PASS | `events.jsonl:1` — `spike_outbound` PASS: msg bce96f6c delivered, wasDowngraded=null, «approach A holds» (live-verified by lead) |
| E2 live e2e wakeup | PASS | `events.jsonl:9` — E2 FULL LOOP PASS: Convex cron → tunnel → eve /internal/wakeup → agent turn → iMessage «Convex-крон разбудил Bro! ✅» доставлен (live-verified by lead); фикс undefined inkboxHandle зафиксирован строкой 8 и в коде (imessage.ts:273-276) |
| F1 нет секретов в диффе | PASS | `origin/Ageree/plaice..HEAD` пуст (всё запушено); дополнительно прогнан grep по `origin/main..HEAD` (2952 строк diff) — единственное совпадение = сама строка паттерна в acceptance.md, реальных значений `live_*`/`sk-or-`/`ak_*` нет. Флаг из events:6 (temp DBG console.log) снят: `grep -rn DBG agent scripts convex` — пусто |
| F2 README/env.example | PASS | `.env.example:39-45` — YOOKASSA_SHOP_ID/SECRET_KEY, BRO_PRICE_RUB, BRO_PAY_BASE/RETURN_URL, BRO_FREE_/BRO_PAID_-лимиты; README:37 — биллинг, webhook URL, free-режим. Примечание: в acceptance упомянуты «BRO_PLAN_*» — фактические имена BRO_FREE_*/BRO_PAID_* (задокументированы), расхождение только в имени из acceptance |

## Замечания (не блокирующие)

- Поля `plan` как такового нет — план выводится из `paidUntil` (isPaid). Для
  одноуровневой платной беты этого достаточно; если появятся тарифы, добавить поле.
- Env-имена лимитов — `BRO_FREE_*`/`BRO_PAID_*`, а не `BRO_PLAN_*` из acceptance
  (документированы в .env.example/README — считаю выполненным по сути).
- `wakeups.schedule`/`cancel` — public mutations за shared-секретом (`assertSecret`),
  не `internalMutation`; секрет fail-closed, вызовы только из agent lib — приемлемо
  для текущей архитектуры (агент вне Convex), но это сознательный трейдофф.
- `anyApi` вместо typed api в billing/http/wakeups — помечено `ponytail:` комментами
  «до codegen», вернуть typed api после deploy.

AUDIT_VERDICT=PASS
