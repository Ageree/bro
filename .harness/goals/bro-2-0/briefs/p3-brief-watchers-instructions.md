# P3 — Утренний бриф, сторожа, инструкции агента

Контекст: примитив wakeups уже есть (convex/wakeups.ts, /internal/wakeup,
тулы schedule_wakeup/cancel_wakeup, browser_poll follow-through). Прочитай:
agent/channels/imessage.ts, agent/tools/schedule_wakeup.ts,
convex/lib/wakeupPolicy.ts, agent/instructions.md. Стиль репо, минимум кода,
без новых зависимостей. Не трогай vendor/, convex/_generated/.

## 1. Утренний бриф (kind="brief")

- Человек говорит «присылай утренний бриф в 8» → агент вызывает
  schedule_wakeup с kind="brief", dailyHour=8 (recurDailyHour в Convex),
  payload="утренний бриф". Это уже должно работать через существующий тул —
  проверь и почини, если dailyHour не прокидывается в recurDailyHour.
- Промпт фонового хода для kind==="brief" в /internal/wakeup:
  «[background wakeup] Утренний бриф. Собери коротко: (1) память об этом
  человеке — незакрытые дела/напоминания на сегодня; (2) если подключён
  Gmail/Calendar через Composio — новые важные письма и встречи сегодня;
  (3) статус браузер-джоба, если был. Если по ВСЕМ пунктам пусто — ответь
  [SILENT]. Одно короткое сообщение, без воды.»

## 2. Сторожа (kind="watcher")

- schedule_wakeup: kind="watcher" + everyMinutes (например 30) + payload
  «что проверять» («важные письма от банка», «цена товара X на Ozon»).
- Промпт для kind==="watcher": «[background wakeup] Сторож: ${payload}.
  Прошлое состояние: ${lastSeen ?? "ничего"}. Проверь текущее состояние
  (Composio-тулы или browser_task — что уместно). Если НИЧЕГО нового
  относительно прошлого состояния — ответь ровно [SILENT]. Если есть новое —
  одно короткое сообщение человеку. В КОНЦЕ ответа добавь строку
  `[SEEN] <краткое текущее состояние в одну строку>` — она не уйдёт человеку.»
- В agent/channels/imessage.ts message.completed: перед отправкой вырежи из
  текста строку, начинающуюся с `[SEEN]` (сохрани остальное). Верни её
  значение в Convex: вызови новую обёртку setWakeupLastSeen (agent/lib/convex.ts →
  anyApi.wakeups.setLastSeen — сделай setLastSeen public+secret-gated mutation
  в convex/wakeups.ts, args {secret, tenantPhone, kind:"watcher", lastSeen}
  — обнови lastSeen у running/scheduled watcher'а этого тенанта; если
  watcher-ов несколько, обнови тот, чей id пришёл… УПРОЩЕНИЕ v1: один watcher
  на человека — в schedule дедупь kind="watcher" как brief/browser_poll, с
  ponytail-комментом «один сторож на человека; если попросят второго —
  массив»).
- [SILENT]-ответ ТОЖЕ может содержать [SEEN] — обработай оба порядка.

## 3. agent/instructions.md — новая секция «Проактивность» (по-русски, в стиле файла)

- Bro умеет писать первым: напоминания, утренний бриф, сторожа, доводка
  browser-задач. Для «напомни…», «следи за…», «присылай бриф…» — вызывай
  schedule_wakeup (kind reminder/watcher/brief). Отмена — cancel_wakeup.
- В фоновом ходе ([background wakeup]) правило: нечего сказать — ровно
  [SILENT]. Никогда не выдумывай «новости», чтобы что-то написать.
- Не обещай «спроси меня позже» про браузер-задачи: Bro сам напишет.
- Напоминание в конкретный момент: atIso/inMinutes; повторяющееся — everyMinutes/dailyHour.

## 4. Проверки

- В scripts/wakeups-check.ts добавь asserts: (а) извлечение [SEEN] из текста
  (вынеси парсер в чистую функцию, например в agent/lib/imessage-text.ts или
  отдельный agent/lib/wakeup-text.ts: `splitSeen(text) -> {message, seen?}` —
  работает при [SEEN] в конце, при [SILENT][SEEN], при отсутствии); (б) дедуп-
  правила если они в чистом коде.
- `npx eve build` (errors==0) + все существующие *:check зелёные.

НЕ запускай convex-команды. НЕ коммить. В конце — файлы + результаты проверок.
