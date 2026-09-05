# Goal: агент молчит — root cause и защита для будущих пользователей

2026-09-05 13:57 MSK: человек прислал фото книги + «Найди мне эту книгу на
озоне». Четыре минуты — ни одного пузыря от Bro.

## Что было (по логам Vercel bro-agent, dpl_8EZJHM31nqzQaHzeq9GpDH83LUd9)

1. 10:57:41Z `POST /webhooks/imessage` → `tenant upsert failed:
   ReturnsValidationError: Object contains extra field archiveSyncedAt`.
   Ошибка проглочена, сообщение ушло модели.
2. 10:57:49Z модель дважды вызвала `browser_task` → тот же
   `ReturnsValidationError` из `tenants.setBrowser`/`getByPhone`.
3. Модель закончила ход без текста. Канал шлёт только непустые сообщения —
   человек не получил ничего.
4. 11:01:25Z модель попробовала `worker` → `KERNEL_API_KEY missing` на
   Vercel (отдельная конфигурационная проблема).

## Root cause

`tenantDoc` в `convex/tenants.ts` — рукописная копия полей таблицы. В #15
в схему добавили `archiveSyncedAt`; копию не обновили. Первый часовой
`memory-sync` записал колонку → с этого момента КАЖДЫЙ query/mutation,
возвращающий tenant, падал для этого человека. То же ждало любого
пользователя после первого archive sync.

## Исправление

- `tenantDoc`, `jobDoc`, `wakeupDoc`, `watcherDoc`, `orders` →
  `doc(schema, "<table>")` из convex-helpers: схема — единственный источник.
- `npm run schema:check`: падает на любом рукописном
  `v.object({ _id: v.id(…) })` в `convex/`.
- Второй слой: `origin: human|wakeup` на каждом `from().send`;
  `turn.failed` и пустой `message.completed` человеческого хода →
  один короткий пузырь «что-то сломалось». `npm run silent:check`.

## Приёмка

`npm run types:check`, `schema:check`, `silent:check`, `jobs:check`,
`wakeups:check`, `watchers:check`, `billing:check` зелёные; `npx eve build`
без ошибок; `npx convex deploy` + `eve deploy` — вручную владельцем.
