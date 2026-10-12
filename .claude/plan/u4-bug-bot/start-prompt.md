# U4. Бот для баг-репортов на OpsAlertBot и метки сообщений владельцу

Ты делаешь только этот юнит. Сначала — `.claude/plan/PROTOCOL.md`.

## Зачем
Бета примерно на 10 человек. Пользователи пишут о багах служебному боту
владельца (`OPS_ALERT_BOT_TOKEN`). Сейчас бот только шлёт тревоги
(`agent/lib/owner-alert.ts`, `scripts/cloudru-app-host/host/watchdog.py`) в
`OPS_ALERT_CHAT_ID`. Решение владельца: баги и тревоги идут в тот же чат, но
каждое сообщение помечено по виду — `🐞 #bug`, `🚨 #alert` (и, например,
`📊 #digest` для сводки U3a). Так их можно отфильтровать поиском по тегу.

## Дизайн (из разведки, проверь в коде)
- Опрос — тик расписания eve (`agent/schedules/bug-bot.ts`, cron раз в минуту,
  уважает `EVE_SCHEDULES=off` через `agent/lib/schedules/enabled.ts`). Внутри
  тика — long polling `getUpdates` (timeout ~25 с) в пределах ~55 с. Ожидания
  ограничь (`agent/lib/browser-use/deadline.ts`). Offset — в БД.
- Включать бота только при явном `OPS_ALERT_BOT_TOKEN`, который не равен
  `TELEGRAM_BOT_TOKEN`. `host.py` на профиле stand кладёт в него токен Бро, и
  тогда опрос отнял бы обновления у `tg-bridge` (409). Нужен регрессионный тест.
  Флаг `BUG_BOT=on|off`, по умолчанию off.
- Таблицы: `bug_reports` (unique `update_id`, telegram user id, chat id,
  username, workspace id — через `findChannelIdentity("telegram", …)` из
  `db/services/channel-identities.ts`, может быть null; текст, `file_id` фото,
  статус, `forward_message_id`) и ответы владельца. Сервис — в
  `db/services/bug-reports.ts`, логика бота — в `agent/lib/bug-bot/`.
- Пользователю: на `/start` — короткое «опишите, что сломалось, можно со
  скриншотом»; на отчёт — «принято, №N». Только личные чаты, не больше ~5
  отчётов в час на человека, текст до 3500 знаков.
- Владельцу: пересылка в `OPS_ALERT_CHAT_ID` с шапкой
  `🐞 #bug №N · имя @username · workspace · время`, фото — `sendPhoto` по
  `file_id`. Реплай владельца на это сообщение (только из настроенного чата)
  уходит человеку от имени бота, статус — answered.
- Метки: `alertOwner` ставит `🚨 #alert` в начало каждого сообщения (с учётом
  шапки `viaBroHeader`); `watchdog.py` делает то же со своими тревогами
  (тест `scripts/cloudru-app-host/host/test_host.py`). Дай `alertOwner`
  параметр вида сообщения (alert по умолчанию), чтобы U3a мог слать
  `#digest`.
- Подсказка в чате Бро: `/bug` в Telegram (`agent/channels/telegram.ts`)
  перехватывается до модели и отвечает «напишите @<бот>». Имя бота — env
  `BUG_BOT_USERNAME`; без него `/bug` уходит модели как раньше. Промпты не
  трогай: хэши закреплены тестами.

## Ловушки
- Миграцию генерируй поверх свежего `bro-next`: U3a тоже добавляет таблицу.
- Ответы Bot API разбирай через zod. oxlint `anti-slop` запрещает `typeof` и
  `unknown`.
- Тик Nitro отдаёт следующему тику тот же промис (`docs/dev-notes.md`,
  «Vercel»): зависший вызов хоронит все тики, поэтому каждое ожидание
  ограничено.

## Параллельно идут
U3a (хуки `agent/hooks/*`, новая таблица ходов, только зовёт `alertOwner`) и
U6a (`agent/tools/web_fetch.ts`, `db/services/auth/`).

## Проверка
Тесты: токен равен токену Бро или не задан → выключено; идемпотентность по
`update_id`; реплай уходит нужному человеку; лимит частоты; привязанный и
непривязанный пользователь; 409 → пауза без падения тика; метки в
`alertOwner` и `watchdog.py`. Плюс `pnpm check`, `pnpm build`,
`pnpm build:eve`. В `docs/dev-notes.md` — запись о ловушке с токеном и об
опросе.

## Результат
PR в `bro-next`. В описании — шаги для владельца: у @BotFather выставить
описание и команды бота, `BUG_BOT=on`, `BUG_BOT_USERNAME`.
