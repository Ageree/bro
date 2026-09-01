# Сторожа 2.0 — push вместо поллинга (дизайн)

Контекст: `.harness/goals/watchers-2-0/goal.md`. Предыдущий дизайн сторожей —
`2026-08-27-bro-2-0-proactive-paid-beta-design.md`, сценарий 4.

## Проблема

Сторож 1.0 — это периодический wakeup (`kind="watcher"`, `everyMinutes`).
Каждый тик тратит ход агента: Composio-вызов, сравнение с `lastSeen`,
суждение маленькой модели «есть ли новое». Пустые тики — самые частые и
самые дорогие в сумме. Задержка равна периоду поллинга.

## Решение

Composio Platform (REST v3.1) отдаёт триггеры вебхуками. Gmail и Google
Calendar события прилетают готовым JSON в Convex HTTP-роут, который
проверяет подпись и будит агента ровно один раз на событие.

```
Composio trigger (ti_*) ── webhook POST ──▶ Convex /composio  (convex/http.ts)
                                              ├─ HMAC-SHA256 подпись (COMPOSIO_WEBHOOK_SECRET), 300 с окно
                                              ├─ parse V3/V2/V1 → {eventId, triggerId, slug, userId, data}
                                              ├─ formatEvent(slug, data) → русский текст-событие
                                              └─ watchers.ingest (mutation)
                                                    ├─ triggerId → сторож (индекс by_trigger)
                                                    ├─ владелец: watcher.tenantPhone == metadata.user_id
                                                    ├─ дедуп по eventId (composioEvents, TTL 24 ч)
                                                    └─ scheduler → watchers.deliverEvent (action)
                                                          └─ POST {EVE_URL}/internal/wakeup kind="event"
                                                                └─ один ход агента: релевантно → сообщение, нет → [SILENT]
```

### Данные

`watchers`: tenantPhone, source (`gmail | calendar`), triggerId (`ti_*`),
triggerSlug, about («за чем следить» словами человека), filter (Gmail query,
опц.), status (`active | stopped`), createdAt, lastEventAt, events.
Индексы: by_tenant, by_tenant_status, by_trigger.

`composioEvents`: eventId, receivedAt. Индексы: by_event, by_receivedAt.
Крон раз в сутки чистит старше 24 ч.

Несколько push-сторожей на человека — норма (почта от банка + календарь).
Wakeup-сторож (`kind="watcher"`) остаётся синглтоном, как был.

### Тулы агента

`watch_app` — один тул, `action: start | stop | list`.

- `start`: `source` + `about` (+ `gmailQuery`). Проверка подключения
  (`connectedAccounts.list` по toolkit), `triggers.create(phone, slug,
  {triggerConfig})`, запись в Convex. Не подключено → просит вызвать
  `COMPOSIO_MANAGE_CONNECTIONS` и повторить.
- `stop`: по `id` или все. Сначала Convex помечает `stopped` (вебхуки сразу
  игнорируются), затем `triggers.delete` в Composio (ошибка не фатальна).
- `list`: активные сторожа этого человека.

Tenant всегда из `ctx` (`tenantId`), Composio user id = E.164 — тот же, что у
сессий и архива. Chужой `user_id` в событии отбрасывается (`foreign_user`).

### Что остаётся поллингом

`schedule_wakeup kind="watcher"` — для всего, где нет вебхука: цена товара на
Ozon/WB, наличие слота, статус на сайте. Инструкции агента разводят два пути.

### Триггеры

| source | slug | config |
|---|---|---|
| gmail | `GMAIL_NEW_GMAIL_MESSAGE` | `interval: 1`, `userId: "me"`, `query` (если задан) иначе `labelIds: "INBOX"` |
| calendar | `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER` | `calendarId: "primary"`, `interval: 1`, `showDeleted: true` |

Оба у Composio — poll-триггеры (Composio сам опрашивает Google, ~1–15 мин на
managed auth). Для Bro это всё равно push: ход агента только на событие.

### Подпись

Тот же алгоритм, что `@composio/core` `triggers.verifyWebhook`: заголовки
`webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, через
пробел может быть несколько), HMAC-SHA256 над `${id}.${timestamp}.${body}`,
сравнение constant-time, окно 300 с. Реализовано на Web Crypto в
`convex/lib/watcherPolicy.ts` — SDK в Convex-рантайм не тащим.

### Регистрация вебхука

Один раз на проект: `npm run composio:webhook` →
`triggers.setWebhookSubscription({ webhookUrl: "https://<deployment>.convex.site/composio" })`,
секрет подписки — в `COMPOSIO_WEBHOOK_SECRET` на Convex-деплое
(`npx convex env set`). Без секрета роут отвечает 500 и ничего не будит.

## Отвергнутые подходы

- Вебхук в eve/Vercel напрямую — Convex уже держит tenants/wakeups и
  секрет-гейт, а Vercel-инстанс не имеет durable-дедупа между изолятами.
- `triggers.subscribe()` (Pusher/WebSocket) — только для локальной отладки,
  не для прода.
- Обработка события без хода агента (шаблонное сообщение) — теряем «решает,
  важно ли». Ход остаётся, но один и без тулов; следующий шаг — правила
  на Convex для тривиальных случаев.

## Риски

- Composio ретраит вебхуки при не-2xx: роут отвечает 200 после проверки
  подписи всегда, доставка в eve — асинхронно с бэкоффом (3 попытки).
- Событие может прийти раньше, чем `watchers.create` записал строку
  (гонка на первом poll) → `unknown_trigger`, событие потеряно. Приемлемо:
  первое событие после подключения обычно не «новое».
- Отзыв подключения: Composio присылает не-trigger события на тот же URL —
  игнорируются (`type !== composio.trigger.message`).

## Исполнение

Код пишут grok-субагенты пакетами P1 (Convex) / P2 (eve) / P3 (проверки)
параллельно по общему контракту `.harness/goals/watchers-2-0/briefs/contract.md`.
Lead верифицирует: `tsc`, `eve build`, все `*:check`, локальный e2e
(подписанный вебхук → Convex → mock eve), затем PR.
