# Bro 2.0 — проактивность + платная бета (дизайн)

Утверждено оператором 2026-08-27 (подход A). Полная формулировка цели и
критерии приёмки: `.harness/goals/bro-2-0/{goal.md,acceptance.md}`.

## Решение

Один примитив — **Convex wakeups** — питает все четыре проактивных сценария.

```
Convex cron (раз в минуту)
  └─ dispatchDue (internal action)
       ├─ claim созревших wakeups (атомарный status-переход scheduled→running)
       └─ POST {eve}/internal/wakeup  (secret-gated)
            └─ eve: фоновый агент-ход с auth тенанта (principalId=phoneE164)
                 └─ агент думает → sendBlueIMessage / молчит → complete/reschedule
```

### Данные

`wakeups`: tenantPhone, at (ms), kind (`reminder | browser_poll | brief | watcher`),
payload (строка задания/что проверять), status (`scheduled|running|done|cancelled`),
recur (для brief/watcher), lastSeen (для watcher-дельты).
Индексы: by_status_at, by_tenant.

`tenants` +: plan (`beta|paid`), paidUntil (ms), usage-счётчики
(msgsDay/msgsDayKey, browserJobsMonth/monthKey), tz (default Europe/Moscow).

### Сценарии поверх примитива

1. **Доводка** — browser_task при активном run ставит `browser_poll` (+2 мин);
   фоновый ход поллит, по завершении шлёт результат первым, wakeup завершает.
2. **Напоминания** — тулы `schedule_wakeup`/`cancel_wakeup` (время ISO/дельта,
   tenant только из ctx).
3. **Бриф** — recur-daily wakeup per tenant в его tz; молчит, если пусто.
4. **Сторожа** — recur wakeup c payload «что проверять» + lastSeen; пишет
   только при дельте, после срабатывания re-schedule.

Антиспам-инвариант: фоновый ход, которому нечего сказать, не отправляет ничего.

### Биллинг (ЮKassa)

Разовые платежи «месяц» (автосписания — после согласования с ЮKassa).
`convex/http.ts` POST /yookassa → верификация → `payment.succeeded` →
paidUntil += 30 дней. Лимиты проверяются в канале до хода агента; превышение →
один мягкий paywall-ответ со ссылкой на оплату. Пустые YOOKASSA_* env =
поведение как сейчас (free-бета). Кап identity поднимается до 100.

## Отвергнутые подходы

- Отдельный Node-воркер/демон — лишний рантайм, Convex уже durable-шедулер.
- Vercel Cron — нет durable per-task state, хватило бы только брифа.

## Риски

- **Inkbox outbound без свежего входящего** — спайк первым; если кап, деградация:
  накапливать «отложенные ответы» и слать при следующем входящем.
- Idle-таймауты Vercel на фоновом ходе — держать ход коротким (один wakeup =
  один ход), диспетчер шлёт по одному запросу на wakeup.

## Исполнение

Код пишут headless grok-сессии пакетами (P0 спайк → P1 wakeups core →
P2 доводка → P3 напоминания+инструкции → P4 бриф → P5 сторожа → P6 биллинг →
P7 лимиты+кап). Lead верифицирует каждый пакет (eve build, check-скрипты,
живой e2e) и коммитит. Изолированный аудит — каждые ~3 пакета.
