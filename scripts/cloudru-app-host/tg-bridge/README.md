# tg-bridge: Telegram без входящего вебхука

В РФ Telegram работает только через VPN: вебхук Telegram до VM Cloud.ru
доходит ненадёжно или не доходит вовсе. Поэтому на сервере Бро
(`scripts/cloudru-app-host/`) обновления забирает сам сервер: `tg_bridge.py`
делает long polling `getUpdates` и отдаёт каждое обновление в локальный eve
тем же запросом, каким его прислал бы вебхук.

```
api.telegram.org ◀─ getUpdates (HTTPS; /etc/hosts → tg-egress, или TG_BRIDGE_PROXY)
        │
   tg-bridge ── POST JSON + X-Telegram-Bot-Api-Secret-Token ──▶ eve 127.0.0.1:4274/eve/v1/telegram
        │
   /var/lib/bro/tg-bridge/state.json  (offset и доставленные id выше него)
```

Исходящие вызовы eve и Бро (`sendMessage`, `answerCallbackQuery`, файлы)
идут на `api.telegram.org` как раньше: их маршрут даёт форвардер
`scripts/cloudru-app-host/tg-egress/` (`/etc/hosts` + REDIRECT). Мост
пользуется тем же путём; `TG_BRIDGE_PROXY` (HTTP CONNECT) нужен, только если
форвардера на хосте нет.

| Файл                    | Что делает                                          |
| ----------------------- | --------------------------------------------------- |
| `tg_bridge.py`          | мост и команды переключения (справка — `-h`)        |
| `bro-tg-bridge.service` | systemd, пользователь `bro`, `Restart=always`       |
| `install.sh`            | кладёт мост в `/opt/bro/tg-bridge` и юнит в systemd |
| `test_tg_bridge.py`     | тесты на фейковых Telegram и eve (stdlib, CI)       |

## Что мост обещает

- **Не теряет то, что eve ещё не принял.** Обновление подтверждается Telegram
  (offset следующего `getUpdates`) и записывается в файл состояния только
  после ответа eve `2xx`. Исключение — «ядовитое» обновление, которое мост
  выбросил после `TG_BRIDGE_ATTEMPTS` собственных неудач (см. «Сбой eve
  пережидает»): его offset продвигается так же, а в `/health` растёт
  `dropped`. Offset — самый ранний недоставленный id; уже
  доставленные id выше него лежат в том же файле, поэтому рестарт моста их не
  повторяет. Файл пишется атомарно (`fsync` файла и каталога + `rename`).
  Неподтверждённое Telegram хранит 24 часа.
- **Принятое eve — на совести eve.** eve отвечает `200` до хода: скачивание
  фото, расшифровка голоса и разбор `/start link_…` идут уже после ответа.
  Обновление, принятое за секунды до остановки eve (выкатка, `restart`),
  может потеряться — с вебхуком было так же. Поэтому перед рестартом eve мост
  останавливают (см. «Что делает сервер»).
- **Не дублирует.** eve и Бро не проверяют `update_id` (дубль — второй ответ
  Бро и ложное «Ссылка не подходит» на `/start link_…`), поэтому дубли
  отсекает мост: в памяти — всё, что в работе, на диске — доставленное.
  Остаётся окно в миллисекунды между `200` от eve и записью файла: падение
  моста ровно в нём даст один дубль.
- **Очередь доставки в чате, а не порядок обработки.** Обновления одного
  чата уходят строго по очереди, разные чаты — параллельно (не больше
  `TG_BRIDGE_PARALLEL`), так что застрявший чат не держит остальных. Пауза
  `TG_BRIDGE_CHAT_GAP_MS` между обновлениями одного чата (от последней
  доставки, и между опросами тоже) — эвристика, а не гарантия: голосовое или
  фото eve разбирает секунды, и текст, пришедший сразу за ними, может их
  обогнать.
- **Сбой eve пережидает.** Отказ соединения, `5xx`, `404` и любой другой код
  повторяются с растущей паузой (до `TG_BRIDGE_RETRY_MAX_S`) сколько угодно
  долго. Обновление выбрасывается, только если `TG_BRIDGE_ATTEMPTS` неудач
  подряд — его собственные: eve ответил ошибкой, а health eve
  (`/eve/v1/health`) сразу после этого — `200`. Мигающий или стартующий eve
  поэтому ничего не выбрасывает. Сбой самой отправки (сеть, таймаут,
  оборванный или непонятный ответ) — тоже «eve не отвечает»: повтор без
  предела. Выбрасывается и обновление, которое мост не смог сериализовать
  (ошибка в самом мосте), — после `TG_BRIDGE_ATTEMPTS`, и мост из-за него не
  падает. В лог — только `update_id`, тип и статус; выброшенные видны в
  `/health` (`dropped`).
- **`401`/`403` от eve — это секрет**, а не обновление: мост ничего не
  выбрасывает, ждёт и показывает это в `/health` (`eveRefused`). Отказ по
  секрету прерывает и счёт «неудач подряд»: неудачи до него и после не
  складываются. Чинить — `TELEGRAM_WEBHOOK_SECRET_TOKEN` в `/etc/bro/env` и
  рестарт обоих сервисов.
- **Не спорит с вебхуком.** При старте и после `409` мост смотрит
  `getWebhookInfo`: пока вебхук стоит, `getUpdates` не зовётся, в лог — одна
  строка раз в `TG_BRIDGE_CONFLICT_PAUSE_S`. `409` от второго экземпляра —
  то же самое. Сам мост вебхук никогда не снимает.
- **Telegram недоступен — обычное состояние.** Пауза между попытками растёт
  до `TG_BRIDGE_RETRY_MAX_S`, в лог — первая ошибка подряд и дальше одна
  строка в минуту.
- **Файл состояния — этого бота.** В нём отпечаток id бота (хеш, не токен):
  после репетиции на тестовом боте или смены `TELEGRAM_BOT_TOKEN` чужой
  offset не используется — мост пишет строку в лог и начинает заново.
  Нечитаемый файл откладывается в `state.json.bad`, мост тоже начинает
  заново. «Заново» безопасно: Telegram отдаёт только неподтверждённое, в
  худшем случае повторится то, что мост принял, но ещё не подтвердил. Сбой
  записи файла (полный диск) мост переживает: опрос не останавливается, и
  offset всё равно уходит в Telegram — eve эти обновления приняла, а
  неподтверждённые Telegram прислал бы заново дублями после рестарта.
  Дубли держит память, в лог — строка раз в минуту, а `/health` отвечает
  `503` (`stateWriteFailing`, счётчик `stateWriteErrors`), пока запись не
  удалась: упавший в это время мост повторил бы доставленное, но не
  подтверждённое. Следующая удачная запись догоняет файл.
- **Без секретов в логе.** Ни токена (он в URL запросов — ошибки чистятся),
  ни секрета, ни текста сообщений, ни id чатов.

## Настройки

Мост читает `/etc/bro/env` (тот же файл, что eve: токен и секрет берутся
байт в байт оттуда) и необязательный `/etc/bro/tg-bridge.env` для своих
настроек: `deployd` переписывает `/etc/bro/env` целиком при каждом `PUT`.
Полный список с умолчаниями — в начале `tg_bridge.py`; главное:

| Переменная                      | По умолчанию                                                          |
| ------------------------------- | --------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | — (обязательна)                                                       |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | — (обязательна, `A-Za-z0-9_-`)                                        |
| `TG_BRIDGE_EVE_URL`             | `http://127.0.0.1:4274/eve/v1/telegram`                               |
| `TG_BRIDGE_PROXY`               | не задан (`http://<login>:<password>@<host>:<port>` или `h:port:u:p`) |
| `TG_BRIDGE_HEALTH`              | `127.0.0.1:7445`                                                      |
| `TG_BRIDGE_POLL_TIMEOUT`        | `50` с                                                                |

Мост бьёт прямо в eve, не в Next: `proxy.ts` отправляет `/eve/v1/telegram`
без cookie на `/sign-in`. Без токена, с секретом, который Telegram не
примет, с настройкой, которая не число или меньше допустимого
(`TG_BRIDGE_PARALLEL=abc` или `0`), и с адресом, который не `host:port` или не
`http://<хост>[:порт]/…`, сервис выходит с кодом 2 и не перезапускается.
`status` и `switch-to-webhook` этих настроек не читают: откат на них не
упирается.

Через резидентный прокси (`TG_BRIDGE_PROXY` или запасной путь tg-egress)
простаивающий long poll стоит трафика: ~1 запрос в 50 с, сотни байт.
Если прокси рвёт простаивающие соединения, уменьшите
`TG_BRIDGE_POLL_TIMEOUT` до 20–30.

## Здоровье

`GET http://127.0.0.1:7445/health` — JSON (`status`, `healthy`, `lastPollAgoS`,
`pending`, `oldestPendingAgeS`, `eveRefused`, `stateWriteFailing`, `offset`,
счётчики `delivered`, `dropped`, `duplicates`, `deliveryRetries`,
`pollErrors`, `stateWriteErrors`); `200`, когда мост опрашивает Telegram, eve
не отвечал отказом по секрету, запись файла состояния не падает и ни одно
обновление не ждёт доставки дольше `TG_BRIDGE_STUCK_S` (120 с: лежащий eve,
сломанный релиз), иначе `503`. Секрет `/health` не проверяет: `eveRefused`
ставит только `401`/`403` на доставку, поэтому до первой доставки `200` не
доказывает, что секрет верен. `status`: `starting`, `polling`, `webhook-set`,
`conflict`, `telegram-unreachable`, `telegram-error`.
`python3 /opt/bro/tg-bridge/tg_bridge.py check` — то же для человека и
watchdog (код 0 или 1).

## Что делает сервер

Сервер приложения (`scripts/cloudru-app-host/`: `host/` и `ops/`, раздел
«Telegram» его README) — не часть этого каталога, но без него мост включать
нельзя: SSH на VM нет, root — только у `deployd`, а упавший мост без сторожа
делает бота немым молча (у вебхука Telegram хотя бы виден `last_error`).

1. **Установка.** `boot.py` (`FILES`) кладёт в бандл хоста `tg_bridge.py`,
   `bro-tg-bridge.service`, `install.sh` и `ops/tg-bridge.sh`;
   `host/install-code.sh` (из `provision.sh` при первом старте и из
   `host.py update-host` на живой VM) зовёт `install.sh`. Юнит не
   включается: включает `switch-to-bridge`.
2. **deployd.** `bro-tg-bridge` — в `UNITS` (логи через `host.py logs`) и в
   `RESTARTABLE`. Мост читает токен и секрет один раз при старте, а
   `/etc/bro/env` пользователю `bro` не читаем, поэтому релиз, откат,
   `PUT /ops/v1/env` и любой рестарт eve при включённом юните
   (`systemctl is-enabled bro-tg-bridge`) идут так (`bridge_paused` в
   `deployd.py`): `stop bro-tg-bridge` → 15 с (`BRIDGE_DRAIN_S`: eve
   дорабатывает принятое в `waitUntil`) → `restart bro-eve` (и `bro-web`) →
   health eve → `start bro-tg-bridge` в любом исходе. Так выкатка не теряет
   обновление, принятое eve за миг до рестарта. Если мост не остановился,
   deployd запускает его снова и eve не перезапускает: задача падает, env
   остаётся прежним.
3. **Команды.** `ops/tg-bridge.sh {status|hold|switch-to-bridge|switch-to-webhook URL}`
   запускает `POST /ops/v1/ops` (`host.py ops NAME tg-bridge.sh …`): другого
   пути к root на VM нет. Ops-скрипты релиза deployd запускает от `bro`, а
   `systemctl` и `/etc/bro/env` требуют root, поэтому эту обёртку он берёт из
   бандла хоста и запускает от root (`ROOT_OPS`). Перед снятием вебхука она
   проверяет путь `tg_egress.py --check` и зовёт
   `python3 /opt/bro/tg-bridge/tg_bridge.py …`; `hold` — выключить мост, если он
   включён (`disable --now`), и снять вебхук (`switch-to-bridge --no-start`,
   тоже лишь при живом eve): в паузе обновления не берёт никто. Метка
   `/var/lib/bro/tg-hold` ставится, как только их никто не берёт.
4. **watchdog.** Проверка `tg-bridge` в `watchdog.py` — только когда
   `systemctl is-enabled bro-tg-bridge`: юнит не `active` либо
   `GET 127.0.0.1:7445/health` не `200` — по тем же правилам, что `web` и
   `eve` (5 минут до алерта, повтор раз в час, сообщение о восстановлении).
   Рядом — `tg-egress` (путь к Telegram) и `tg-hold` (hold дольше трёх часов
   без моста). Алерт в Telegram идёт тем же путём, что и мост, поэтому есть
   второй канал — `OPS_ALERT_WEBHOOK_URL` (README сервера, «Watchdog»).

## Переключение

Команды ниже — на VM от root (через обёртку deployd из п. 3: с рабочего
места `host.py ops NAME tg-bridge.sh switch-to-bridge`, так же `status` и
`switch-to-webhook URL`); они читают `/etc/bro/env` сами. Ставит мост
`install-code.sh` сервера.

```sh
bash scripts/cloudru-app-host/tg-bridge/install.sh     # из распакованного бандла; не включает мост
python3 /opt/bro/tg-bridge/tg_bridge.py status          # только getWebhookInfo: куда идут обновления
```

**На мост** (eve на VM уже работает, tg-egress включён):

```sh
python3 /opt/bro/tg-bridge/tg_bridge.py switch-to-bridge
```

Команда: `getWebhookInfo` → если вебхук стоит, health eve
(`/eve/v1/health` должен ответить `200`, иначе вебхук остаётся и команда
выходит с кодом 1: пока бот живёт на нём) → `deleteWebhook` с
`drop_pending_updates=false` (всё, что Telegram копил для вебхука, станет
первой пачкой моста) → проверка, что вебхука нет →
`systemctl enable --now bro-tg-bridge` → ждёт `/health` до 2 минут. Если проверка после
`deleteWebhook` не удалась (сеть), вебхук уже снят, поэтому мост всё равно
включается: он сам смотрит `getWebhookInfo` и при `409` ждёт. `--no-start` —
только снять вебхук (после неудавшейся проверки — код 1).

**Откат на вебхук** (Vercel или любой публичный адрес):

```sh
python3 /opt/bro/tg-bridge/tg_bridge.py switch-to-webhook https://bro-next.vercel.app/eve/v1/telegram
```

Команда: `systemctl disable --now bro-tg-bridge` → `getUpdates` с offset из
файла состояния (подтверждает Telegram то, что мост уже доставил, иначе
вебхук прислал бы это ещё раз) → `setWebhook` с
`secret_token=$TELEGRAM_WEBHOOK_SECRET_TOKEN`,
`allowed_updates=["message","callback_query"]`, `drop_pending_updates=false`
→ `getWebhookInfo` сверяет адрес. Если Telegram с VM недоступен, команда
включает мост обратно и выходит с кодом 1 — бот не остаётся ни с чем.
Секрет целевого eve должен совпадать с `/etc/bro/env` (на Vercel — тот же
`TELEGRAM_WEBHOOK_SECRET_TOKEN`). Обновления, доставленные мостом поверх ещё
не доставленного (`done` в файле), подтвердить нельзя: вебхук пришлёт их
повторно.

**Откат без VM** (VM или её выход к Telegram лежат — откат вероятнее всего
именно тогда). `setWebhook` можно вызвать с любой машины, которая достаёт
Telegram (в РФ — с VPN). Мост, увидев вебхук, сам перестаёт опрашивать
(`409` → пауза), так что порядок такой:

1. С машины с доступом к Telegram — секрет из файла, не в командной строке
   (не попадёт в историю и `ps`):

   ```sh
   # bot.txt — токен, secret.txt — TELEGRAM_WEBHOOK_SECRET_TOKEN, оба без перевода строки
   curl -sS "https://api.telegram.org/bot$(cat bot.txt)/setWebhook" \
     --data-urlencode "url=https://bro-next.vercel.app/eve/v1/telegram" \
     --data-urlencode "secret_token@secret.txt" \
     --data-urlencode 'allowed_updates=["message","callback_query"]' \
     -d drop_pending_updates=false
   ```

   (Токен в URL виден в `ps` этой машины; на общей машине — `curl -K` с
   конфигом из файла.)

2. Когда VM и её путь к Telegram снова работают — через deployd тот же
   адрес, что в п. 1:

   ```sh
   host.py ops bro-app-1 tg-bridge.sh switch-to-webhook https://bro-next.vercel.app/eve/v1/telegram
   ```

   Мост выключается (`disable --now`, после перезагрузки не включится),
   вебхук ставится повторно. Пока Telegram с VM недоступен, команда
   возвращает мост: вебхук он не снимает, а увидев его, не опрашивает.
   Обновления, которые мост успел доставить, но не подтвердить, вебхук
   пришлёт повторно.

## Проверка

```sh
cd scripts/cloudru-app-host/tg-bridge && python3 -m unittest
```

Фейковый Telegram (offset, long poll, вебхук, `drop_pending_updates`, `409`)
и фейковый eve (с health): порядок в чате и пауза между его сообщениями через
опросы, параллельность чатов, задержка следующего сообщения, дубли, offset
после сбоя и рестарта, чужой и нечитаемый файл состояния, сбой записи и
`/health`, `409`, вебхук, «ядовитые» обновления и мигающий eve, непарный
суррогат, неверный секрет, неверные настройки, застрявшее обновление в
`/health`, команды переключения (сбой проверки после `deleteWebhook`, лежащий
eve) и откат при недоступном Telegram.
Боевого бота тесты не трогают: на нём допустимы только `getWebhookInfo` и
`getMe`, пока он на вебхуке Vercel.
