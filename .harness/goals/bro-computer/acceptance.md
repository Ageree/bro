# Acceptance — Bro Computer (фаза 1)

Все команды из корня, node 24.

## A. Регресс

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| A1 | Типы чистые | `npm run -s types:check` | exit 0 |
| A2 | Существующие проверки зелёные | `npm run -s browser:check && npm run -s wakeups:check && npm run -s cabinet:check && npm run -s worker:check && npm run -s imessage:check && npm run -s access:check` | все `* ok` |

## B. Клиент и политика (P1)

| # | Критерий | Проверка | Ожидание |
|---|---|---|---|
| B1 | Флаг бэкенда | `computerBackend(undefined) === "off"`, `("maritime") === "maritime"`, мусор → `off` | `npm run -s computer:check` |
| B2 | Телефон не утекает | `computerExternalId("+7900…")` не содержит цифр номера, стабилен, различается между тенантами; то же для `computerAgentName` | computer:check |
| B3 | Клиент без токена падает громко | `maritimeEnabled()===false`, `provisionAgent` кидает `MARITIME_TOKEN` | computer:check |
| B4 | 402 desktop → понятная ошибка | `setDesktop` маппит 402/`seat_limit` в `{ok:false, reason:"paid_plan_required"}` (через инжект `fetch`) | computer:check |
| B5 | Live smoke (Lead) | `MARITIME_LIVE=1 npm run -s computer:check` | plan-usage + templates прочитаны, live-view существующего агента отдаёт `{liveViewUrl, reason}` |

## C. Convex + кабинет (P2)

| # | Критерий | Проверка | Ожидание |
|---|---|---|---|
| C1 | Поля тенанта | `convex/schema.ts`, `tenantDoc` в `convex/tenants.ts` | `computerAgentId/Provider/Status/LiveUrl/LiveAt/Task/ConversationId/ProvisionedAt` optional |
| C2 | `setComputer` | `convex/tenants.ts` + `agent/lib/convex.ts` | secret-gated mutation, patch только переданных полей |
| C3 | Wakeup kind | `convex/schema.ts`, `convex/wakeups.ts`, `agent/lib/convex.ts`, `agent/tools/cancel_wakeup.ts` | `computer_poll` везде, где есть `job_check`; singleton per tenant как `browser_poll` |
| C4 | Кабинет | `convex/cabinet.ts` snapshot + `cabinet.html`/`assets/auth.js` | блок `computer` (status, task, liveViewUrl, updatedAt); кнопка «Вмешаться» только при `liveViewUrl` |
| C5 | Оффлайн | `npm run -s cabinet:check && npm run -s wakeups:check` | ok |

## D. Тул и промпт (P3)

| # | Критерий | Проверка | Ожидание |
|---|---|---|---|
| D1 | Флаг выключен | `computer_task` при `off` → `{status:"off", hint}` без сетевых вызовов | чтение кода |
| D2 | Лимит | перед первым запуском `countBrowserJobStart`; `limit` → тот же hint, что у `browser_task` | чтение кода |
| D3 | Lazy provision | нет `computerAgentId` → `provisionAgent` по хэшу → `setComputer` | чтение кода |
| D4 | Follow-through | ответ `working`/таймаут → `scheduleWakeup(kind:"computer_poll", recurMinutes:2)`; `done`/`blocked` → `cancelWakeup(kind:"computer_poll")` | чтение кода |
| D5 | Промпт | `agent/channels/imessage.ts` ветка `computer_poll` | вызывает `computer_task` с payload; `[SILENT]` если работает |
| D6 | Инструкции | `agent/instructions.md` | когда `computer_task`, когда `browser_task`, когда `worker`; live view только для takeover |

## E. Гигиена

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| E1 | Нет секретов | `git diff main..HEAD \| grep -aiE 'mk_[A-Za-z0-9]{8}'` | пусто |
| E2 | README/.env.example | чтение | `MARITIME_TOKEN`, `MARITIME_API_URL`, `BRO_COMPUTER_BACKEND`, `BRO_COMPUTER_TEMPLATE`, `BRO_COMPUTER_DESKTOP`, `npm run computer:check` |
