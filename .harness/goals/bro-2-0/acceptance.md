# Acceptance — Bro 2.0

Все команды из корня worktree, node 24 (`source ~/.nvm/nvm.sh && nvm use 24`).

## A. Сборка и существующие проверки (регресс)

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| A1 | eve build чистый | `npx eve build` + чтение `.eve/agent-summary.json` | exit 0, diagnostics.errors == 0 |
| A2 | Существующие проверки зелёные | `npm run -s access:check && npm run -s browser:check && npm run -s connect-link:check && npm run -s imessage:check && npm run -s optmem:check` | все `* ok` |

## B. Wakeups core

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| B1 | Схема: таблица `wakeups` с индексом по времени | чтение `convex/schema.ts` | таблица + index по `at` (и tenant) |
| B2 | Convex-функции wakeups: schedule/cancel/due/claim | чтение `convex/wakeups.ts` | internal+secret-gated функции, claim атомарен (status-переход), повторный claim того же wakeup невозможен |
| B3 | Cron-диспетчер зарегистрирован | чтение `convex/crons.ts` | interval ≤ 60s → internal action, который POST-ит в eve background-роут |
| B4 | Eve background-роут защищён секретом | чтение канала | POST без `BRO_INTERNAL_SECRET` → 401; с секретом → агент-ход с auth именно этого tenant (principalId = phoneE164) |
| B5 | Тулы schedule_wakeup / cancel_wakeup | чтение `agent/tools/` | zod-схемы; время — ISO или delta; tenant из ctx, не из модели |
| B6 | Оффлайн-проверка логики wakeups | `npm run -s wakeups:check` | `wakeups-check ok` (чистые функции: due-выборка, парсинг времени, дедуп/claim-переходы) |

## C. Четыре сценария

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| C1 | Browser follow-through | чтение `agent/tools/browser_task.ts` + `npm run -s browser:check` | при активном run создаётся wakeup poll; по завершении — проактивная отправка результата и wakeup не пересоздаётся |
| C2 | Утренний бриф | чтение кода + `npm run -s wakeups:check` | daily wakeup per tenant с tz (default Europe/Moscow); бриф молчит, если нечего сказать |
| C3 | Сторожа | чтение кода | watcher-wakeup хранит «что проверять» + last-seen state; отправка только при дельте; re-schedule после срабатывания |
| C4 | Инструкции агента обновлены | чтение `agent/instructions.md` | описаны напоминания/бриф/сторожа/доводка; запрет спама («молчи, если нет нового») |

## D. Биллинг и лимиты (за env-гейтом, живой платёж — после ключей)

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| D1 | ЮKassa webhook | чтение `convex/http.ts`(+модуль) | POST /yookassa: проверка подлинности (Basic/IP или idempotent re-fetch платежа по API), `payment.succeeded` → paidUntil += 30d |
| D2 | Тенант: план/paidUntil/счётчики | чтение `convex/schema.ts`, `convex/tenants.ts` | поля plan/paidUntil + usage-счётчики (msgs/day, browser-jobs/mo) |
| D3 | Enforcement в канале | чтение `agent/channels/imessage.ts` | превышение → один мягкий paywall-ответ со ссылкой на оплату, не молчание и не спам |
| D4 | Оффлайн-проверка биллинг-логики | `npm run -s billing:check` | `billing-check ok` (чистые функции: продление paidUntil, окна счётчиков, paywall-решение) |
| D5 | Без ключей ничего не падает | `npx eve build` + A2 | при пустых YOOKASSA_* всё работает как раньше (free-режим/бета) |

## E. Спайк и live-verify

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| E1 | Спайк outbound-без-входящего выполнен | `.harness/goals/bro-2-0/events.jsonl` | событие spike_outbound с результатом (delivered/capped) и выводом для дизайна |
| E2 | Live e2e wakeup (если Convex-деплой доступен) | events.jsonl | запись о живом прогоне: scheduled → dispatched → iMessage доставлен; либо явная причина, почему выполнено только структурно |

## F. Гигиена

| # | Критерий | Команда | Ожидание |
|---|---|---|---|
| F1 | Нет секретов в диффе | `git log -p origin/Ageree/plaice..HEAD \| grep -aiE 'live_[A-Za-z0-9]{8}\|sk-or-\|ak_[A-Za-z0-9]{8}'` | пусто (имена env-переменных — ок) |
| F2 | README/env.example обновлены | чтение | новые env (YOOKASSA_*, BRO_PLAN_*) и команды описаны |
