# Bro Computer — per-tenant компьютер на Maritime (дизайн, фаза 1)

Черновик lead-сессии 2026-09-01. Цель и критерии приёмки:
`.harness/goals/bro-computer/{goal.md,acceptance.md}`.

## Что показал живой спайк (аккаунт `cursor`, free plan, 2026-09-01)

Проверено ключом `MARITIME_TOKEN` (scopes provision/deploy/secrets/manage)
против `https://api.maritime.sh` (OpenAPI 0.1.0, FastAPI).

| Факт | Значение |
|---|---|
| Деплой агента из шаблона | ~20 с до `active`, Firecracker microVM, root, `/data` персистентный |
| `browser` capability | это **Browserbase**: в VM лежат `BROWSERBASE_API_KEY/CONTEXT_ID/PROJECT_ID`; браузер живёт вне VM, per-agent context = сохранённые логины |
| `GET /browser/live-view` | `{liveViewUrl, sessionId, startedAt, reason}`; без активной сессии — `no_active_session`. URL появляется только пока агент реально держит браузерную сессию |
| Browserbase-сессии | списываются с wallet: `ratePerHourCents: 30` |
| `desktop` (свой Linux-десктоп, watch/takeover) | **только платный план**: `402 seat_limit` и на create, и на `PATCH /desktop-config` (Starter $20/мес) |
| `identity` capability (Inkbox через Maritime) | `503`: Inkbox-организация *Maritime* упёрлась в лимит номеров. Для Bro неактуально — у нас своя Inkbox-орг |
| `POST /chat` | синхронный, окно ~30 с; на free `openclaw_browser` вернул `[blocked]` за 31.9 с (approval-стена OpenClaw, Browserbase-сессия не стартовала) |
| `POST /exec` | работает (60 с, max 120), `GET/PUT files/*` работает, `/data` = `.openclaw/ inbox/ outbox/` |
| LLM | `OPENAI_BASE_URL=https://api.maritime.sh/api/llm/v1`, welcome-кредит $5 |
| Внутри VM | `MARITIME_AGENT_ID`, `MARITIME_BACKEND_URL`, `MARITIME_INTERNAL_TOKEN` → агент может звать `/api/agents/internal/*` (request-login, schedules) |

Вывод: Maritime — это **runtime «руки»** (персистентный компьютер на человека),
а не замена мозга или control plane. «Видеть, чем занят, и вмешаться» у Bro уже
есть через Kernel (`browser_live_view_url` + profile `save_changes`). Maritime
даёт две вариации: Browserbase live view (тот же класс, что Kernel) и платный
Desktop (настоящий персистентный десктоп с takeover из их дашборда — новая
ценность, но за $20/мес и требует проверки на платном плане).

## Решение фазы 1: «руки на Maritime», мозг и касса остаются

```
iMessage ──Inkbox──▶ eve (Vercel, мозг, рендер iMessage)
                       │  computer_task (флаг BRO_COMPUTER_BACKEND=maritime)
                       ▼
                 Maritime agent per tenant  ◀── provision(externalId = hash(E.164))
                 (openclaw_browser | desktop*, /data, Browserbase context)
                       │  reply ≤30s | working → wakeup computer_poll
                       ▼
Convex: tenants.computer*, jobs, wakeups, billing (ЮKassa), cabinet, vault
```

Не трогаем: Convex как control plane, ЮKassa, кабинет и его логин, vault
(AES-GCM + CDP-инъекция), `worker`/Kernel (остаётся путь для логина и оплаты),
формат iMessage (`imessage-text.ts`), Inkbox (своя орг).

### Компоненты

1. **`agent/lib/computer-policy.ts`** — чистые функции: флаг бэкенда,
   `externalId`/имя агента из E.164 (sha256, телефон не утекает — как у Kernel
   profile), шаблон/desktop из env, персона компьютера (RU, тот же секрет-барьер,
   что у `worker`), маппинг статусов, решение по live view, классификация
   ответа `/chat`.
2. **`agent/lib/maritime.ts`** — REST-клиент на `fetch` без новых зависимостей:
   list/create/get/provision (идемпотентно по `externalId`), chat, live-view,
   exec, files, env, start/sleep/delete, desktop-config (402 → понятная ошибка),
   plan-usage. Ошибки — `MaritimeError {status, code}`.
3. **Convex** — `tenants.computer*` поля + `setComputer`; wakeup kind
   `computer_poll`; `cabinet` snapshot получает блок `computer` (статус, что
   делает, live view для «Вмешаться»).
4. **`agent/tools/computer_task.ts`** — root-тул за флагом: лимит браузер-задач
   (тот же `countBrowserJobStart`), lazy-provision компьютера, `/chat` с
   `conversation_id`, live view после ответа, follow-through через
   `computer_poll` (максимум как у `browser_task`: 30 мин, потом честно
   сдаётся).
5. **Промпт `/internal/wakeup`** — ветка `computer_poll`.
6. **`scripts/computer-check.ts`** — оффлайн asserts + опциональный live smoke
   (`MARITIME_LIVE=1`): plan-usage, templates, live-view существующего агента.

### Границы безопасности

- Телефон никогда не уходит в Maritime: `externalId`/`name` — хэш.
- В VM не кладём секреты Bro (INKBOX, YOOKASSA, vault master, Convex secret).
  Компьютер получает только задание текстом; логины остаются в Kernel-пути
  через vault, пока не проверен платный Desktop.
- Live view отдаём человеку только для CAPTCHA/3DS/takeover, никогда «введи
  пароль в браузере» (правило из `worker`).
- Флаг выключен по умолчанию: без `MARITIME_TOKEN` и
  `BRO_COMPUTER_BACKEND=maritime` тул отвечает `status: "off"`, ничего не падает.

### Что откладываем (фаза 2, после решения оператора)

- Desktop-режим: `BRO_COMPUTER_DESKTOP=1` + Starter-план; проверить, отдаёт ли
  `desktop/takeover` URL, который можно встроить в кабинет без логина в Maritime.
- Перенос мозга (eve как custom image с `/health` + `/chat`): 30-секундное окно
  ответа и `eve deploy` под Vercel делают это отдельным проектом.
- Webhook `message.reply`/`agent.*` → Convex http (сейчас достаточно
  `computer_poll`).
- Startup program Maritime ($1k кредитов + FDE) — заявка руками оператора.

## Отвергнутые подходы

- Заменить Kernel в `worker` на Maritime-браузер: у Maritime нет удалённого
  Playwright/computer API, браузером управляет OpenClaw внутри VM. Резать надо
  по «делегируй задание компьютеру», не по «подмени браузер».
- Inkbox identity через Maritime: их орг-лимит, и это дублирует нашу Inkbox-орг.
- Front door `projects/{id}/messages` с `externalUserId`: у нас уже один агент
  на человека по `externalId`, второй слой маршрутизации не нужен.
