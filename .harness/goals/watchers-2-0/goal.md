# Goal: Сторожа 2.0 — push вместо поллинга

Сейчас watcher — периодический wakeup, который тратит ход агента на «проверь
и сравни с lastSeen». Composio Platform (REST v3.1) даёт триггеры вебхуками:
Gmail/Calendar события прилетают готовым JSON прямо в `convex/http.ts`.
Сторожа становятся мгновенными, бесплатными по токенам на пустых тиках и не
зависят от качества суждения маленькой модели «есть ли новое».

Wakeup-поллинг (`schedule_wakeup kind="watcher"`) остаётся только для того,
у чего нет вебхуков (цены на товары, слоты на сайтах).

Дизайн: `docs/superpowers/specs/2026-09-01-bro-watchers-push-design.md`.
Контракт для пакетов: `briefs/contract.md`.

## Ограничения

- Ponytail: минимум кода, без новых зависимостей. `@composio/core` уже есть
  (eve-сторона); в Convex-рантайм SDK не тащим — подпись на Web Crypto.
- Не трогать `convex/_generated/`, формат iMessage-текста, существующие
  wakeup-сторожа (они остаются для поллинга).
- Tenant только из `ctx`, никогда из модели. Чужой `user_id` — дроп.
- Секреты в env: `COMPOSIO_WEBHOOK_SECRET` на Convex-деплое.
- КОД ПИШУТ grok-субагенты пакетами P1/P2/P3, Lead верифицирует и коммитит.

## Приёмка

- `npm run types:check`, `npx eve build` (errors == 0), все `*:check` зелёные,
  новый `npm run watchers:check`.
- Локальный e2e: подписанный вебхук → Convex `/composio` → `/internal/wakeup`
  на mock-eve с `kind="event"`; неверная подпись → 401; повтор → duplicate.
- Live: `triggers.getType` для обоих слагов отвечает (read-only).
