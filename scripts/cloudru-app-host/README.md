# Свой сервер Бро на Cloud.ru

Этап 4 переезда (`docs/cloudru-migration.md`): Бро целиком на одной VM
Cloud.ru. Одна и та же VM сначала служит репетиционным стендом
(`cloud.brobro.tech`, расписания выключены, ключей отправки людям нет), потом
становится продом (`brobro.tech`). Прод на Vercel остаётся путём отката.

```
Caddy :443 ─ /eve/* ───────────────▶ bro-eve  node .output/server/index.mjs  127.0.0.1:4274
          ├─ /.well-known/workflow/*, /api/health → 404 (только по loopback)
          ├─ /ops/v1/* (только ops-хост) ▶ deployd  127.0.0.1:8095
          └─ остальное ────────────────▶ bro-web  node server.js (Next standalone)  127.0.0.1:3000
bro-eve ── мир @workflow/world-postgres (graphile-worker в процессе) ──▶ PostgreSQL Cloud.ru
```

| Файл                    | Что делает                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `host.py`               | команды из сессии (справка — `-h`)                                                   |
| `host/boot.py`          | `vendor`, бандл хоста и cloud-init                                                   |
| `host/provision.sh`     | установка VM из cloud-init (стадии — `/var/lib/bro/stage`)                           |
| `host/deployd.py`       | релизы, env, сайты, логи, ops-скрипты (Python stdlib, root)                          |
| `host/watchdog.py`      | раз в минуту: здоровье Next, eve, Caddy, свежесть бэкапа; Telegram владельцу         |
| `host/*.service, timer` | `bro-web`, `bro-eve`, `deployd`, `caddy`, `bro-watchdog`, `bro-egress`, `bro-backup` |
| `host/egress.sh`        | iptables: `bro` и `caddy` без metadata `169.254/16`, `bro` и без порта deployd       |
| `host/vendor.json`      | пины sha256: Caddy, Node 24 linux-x64, клиент PostgreSQL 18 (PGDG jammy)             |
| `ops/migrate.ts`        | миграции Бро (`db/migrations`) и схема мира + очереди; в релизе — `migrate.mjs`      |
| `ops/db-*.sh`           | бэкап, восстановление, проверка восстановления, перенос с Neon (раздел «База»)       |
| `ops/store.py`          | Object Storage и манифесты бэкапов (подпись — `s3.py` стенда, едет в релиз)          |

Нужны `CLOUDRU_KEY_ID`, `CLOUDRU_KEY_SECRET`, `CLOUDRU_S3_TENANT_ID`; Compute
API, serial-консоль и подпись S3 — из стенда `scripts/cloudru-sandbox-probe/`,
кэши — в `~/.bro-app-host`. Скрипт трогает только VM `bro-app-…`. Здесь и ниже
`host.py` — это `python scripts/cloudru-app-host/host.py` из корня репозитория.

## Ключ и артефакты

`host.py key` один раз создаёт `DEPLOY_SIGNING_KEY` (32 байта hex) в
`~/.bro-app-host/env/new-secrets.json` (`0600`, чужие ключи файла не трогает).
Ключ VM — `HMAC-SHA256(DEPLOY_SIGNING_KEY, "bro-app-host:" + имя)`, его кладёт
cloud-init в `/etc/bro/deployd.json`; сам `DEPLOY_SIGNING_KEY` на VM не едет.
Токен — формат `sandboxd`/`hostd`: `v1.<payload>.<sig>`, payload
`{"env": <имя VM>, "exp": …}`, не дальше 15 минут.

`host.py vendor` качает по пинам `vendor.json` Caddy (GitHub), Node
(nodejs.org) и пакеты `libpq5`, `postgresql-client-common`,
`postgresql-client-18` для jammy (apt.postgresql.org; sha256 взяты из
подписанного ключом PGDG `InRelease`) и кладёт Node и пакеты в Object Storage;
Caddy едет в бандле хоста.

| Ключ в `bucket-ac164a`                | Что                                                     |
| ------------------------------------- | ------------------------------------------------------- |
| `app/vendor/<файл>`                   | Node `tar.xz` и три `.deb` клиента PostgreSQL           |
| `app/host/app-host-<sha256[:16]>.tgz` | бандл: `host/*` и Caddy; ключ — первые 16 знаков sha256 |
| `app/releases/<версия>.tar.zst`       | релиз и рядом `.sha256`                                 |
| `backups/postgres/…`                  | зашифрованные бэкапы прода и манифесты (14 дней)        |
| `backups/stand/postgres/…`            | то же для стенда                                        |

## VM

```sh
host.py create bro-app-1          # gen-2-8, SSD 40 ГБ, публичный IP, ~10 минут до health
host.py status bro-app-1 --stage  # стадия установки через serial-консоль
```

`create` подписывает ссылки на 12 часов, ждёт `running`, затем
`https://<ip с дефисами>.sslip.io/ops/v1/health` (сеть в `ru.AZ-1` появляется
минуты через три). Пароль root для serial-консоли — в
`~/.bro-app-host/bro-app-1.password` (в user data — только его хэш; SSH нет).
Ключ VM для deployd и ссылки S3 на 12 часов лежат в user data открыто: их
видно в консоли Cloud.ru и любому процессу VM через metadata
`169.254.169.254`. Поэтому процессам `bro` (приложение, инструменты модели,
ops-скрипты) `bro-egress.service` (`host/egress.sh`, iptables по
`--uid-owner bro`) закрывает `169.254.0.0/16` и порт deployd `8095`, а Caddy,
который смотрит в интернет, — `169.254.0.0/16` (к deployd он ходит: проксирует
`/ops/v1/*`); без этих правил `caddy`, `bro-web` и `bro-eve` не стартуют.
Первая загрузка иногда встаёт в `(initramfs)` — `host.py reboot bro-app-1`.

`provision.sh`: apt только с `mirror.yandex.ru`, Node в `/opt/node-v<версия>`,
клиент PostgreSQL 18 (`apt-mark hold`), пользователь `bro` (дом —
`/var/lib/bro-home`), `/srv/bro/releases/<версия>` и симлинк
`/srv/bro/current` (`/srv/bro`, `releases/`, `downloads/`, история и
`current` — root: там работает root-deployd; `bro` владеет лишь распакованными
релизами), `/etc/bro/env`
(`0600`, пустой до первого `host.py env`), журнал не больше 1 ГБ, Caddy с
ops-хостом `<ip>.sslip.io`, `deployd`, таймер watchdog. `bro-web` и `bro-eve`
включены, но стартуют только когда есть `current`.

## Выкладка

```sh
host.py env bro-app-1 --profile stand --dry-run   # какие имена откуда, без значений
host.py env bro-app-1 --profile stand
host.py deploy bro-app-1                          # build + release; или --version <версия>
host.py sites bro-app-1 --add cloud.brobro.tech   # после A-записи на IP VM
host.py rollback bro-app-1                         # ещё раз — на релиз раньше
```

Задачу deployd (релиз, откат, env, ops, restart, stop) `host.py` не
повторяет: если ответ потерялся, он спрашивает `status` и следит за идущей
задачей. Повторяются только чтения и `PUT sites`.

`host.py build` требует чистое дерево (`--allow-dirty` — для пробы) и
отказывает, пока в корне есть `.env`, `.env.local`, `.env.production*`: Next
и Nitro eve читают их при сборке в обход чистого env.
`pnpm install --frozen-lockfile`, `pnpm build:eve` с `WORKFLOW_WORLD=postgres`,
`next build` с `NEXT_OUTPUT=standalone` (напрямую, не через turbo — кэш turbo
мог бы подставить сборку для Vercel), esbuild `ops/migrate.ts`. Всё — в
чистом env с заглушками `DATABASE_URL`/`BETTER_AUTH_*` (в вывод они не
попадают). Версия — `<UTC-время>-<коммит>`.

Релиз (`POST /ops/v1/release`, задача deployd): скачать по presigned-ссылке
только с `s3.cloud.ru`, сверить sha256, распаковать в
`releases/<версия>`, `node ops/migrate.mjs app world` от `bro` с env сервисов
(миграции должны быть совместимы с работающим релизом — `db/README.md`),
переключить `current`, перезапустить `bro-eve` и `bro-web`, ждать до 120 с
`/api/health` и `/eve/v1/health`; не дождался — `current` назад и перезапуск.
Откат без `--version` идёт на релиз, вышедший до текущего, и обрезает
историю после него: второй откат идёт дальше назад, а не обратно.
Хранятся текущий и пять последних релизов. eve на SIGTERM выходит сразу:
шаги, что шли, мир повторит (оплаченный шаг модели — повторно), поэтому
выкладывать в тихое время.

## Env

`host.py env NAME --profile stand|prod` собирает весь `/etc/bro/env` и
отправляет его целиком (`PUT /ops/v1/env`); печатает только имена по
источникам. Порядок (позднее перекрывает раннее):

1. `vercel-production.json` — только имена схемы `shared/environment/env.ts`,
   без `VERCEL_*`, Neon и `DATABASE_URL*`;
2. `installation-secrets.json` — `BETTER_AUTH_SECRET`, `SECRET_ENCRYPTION_KEY`
   (не менять никогда);
3. env сессии — имена схемы, которых ещё нет (чувствительные ключи Vercel не
   отдаёт: Telegram, RouterAI, Composio…);
4. `WORKFLOW_POSTGRES_WORKER_CONCURRENCY=20`, `…_MAX_POOL_SIZE=24`,
   `WORKFLOW_WORLD=postgres`; профиль: стенд — `BETTER_AUTH_URL=https://cloud.brobro.tech`,
   `EVE_SCHEDULES=off` (тики расписаний ничего не делают; не `TEST=1`: его читает
   и Better Auth и выключает проверку Origin); прод — `https://brobro.tech`,
   `EVE_SCHEDULES=on`;
5. стенд работает на копии данных прода и открыт в интернет, поэтому
   теряет ключи, которые пишут людям, в хранилища и аккаунты прода или
   тратят деньги без планировщика: `TELEGRAM_*`, `IMESSAGE_*`, `YOOKASSA_*`,
   `BLOB_*`, `EVE_MEMORY_BLOB_*` (те же пути, что у прода),
   `SUPERMEMORY_API_KEY`, `COMPOSIO_API_KEY` (подключённые аккаунты из копии
   прода), `BROWSER_USE_*`, `BROWSER_HOST_*`, `BROWSER_VM_TWOCAPTCHA_API_KEY`,
   пилоты `BROWSER_POOL_WORKSPACES`, `BROWSER_VM_WORKSPACES`,
   `SANDBOX_WORKSPACES`. Остаются модель (RouterAI/OpenRouter), Cloud.ru, ключи
   подписи песочниц и браузерных VM, `BROWSER_STATE_KEY`. Вернуть ключ можно
   в `stand.json`; `host.py env` тогда печатает предупреждение для каждого
   ключа хранилища прода;
6. `new-secrets.json` после `host.py pg users`: `DATABASE_URL`,
   `WORKFLOW_POSTGRES_URL`, `BACKUP_CHECK_DATABASE_URL` (пользователь
   `bro_app`, базы профиля — раздел «База»), `BACKUP_ENCRYPTION_KEY` и
   `BACKUPS=on`; профиль добавляет `BACKUP_PREFIX` и `HOST_PROFILE`. Без ключа
   прод `host.py env` не примет (выключить бэкапы — только `BACKUPS=off` в
   `prod.json`), стенд получит `BACKUPS=off`. `--with-neon` кладёт
   `NEON_DATABASE_URL` (прямой адрес владельца Neon из
   `vercel-production.json`) не в `/etc/bro/env`, а в `/etc/bro/ops-env`
   deployd: его получают только ops-скрипты, приложение и инструменты модели —
   нет; `host.py env` без флага его убирает;
7. `~/.bro-app-host/env/<профиль>.json` (`0600`, ведёт оператор):
   `OPS_ALERT_CHAT_ID` и всё, что надо перекрыть (и базы, если они другие);
   `null` удаляет имя.

Значения чистятся от переводов строк, пробелов и кавычек по краям. Значение с
переводом строки deployd не примет. Если после нового env сервисы не поднялись
за 120 с, deployd возвращает прежний файл.

## Сайты, логи, ops

- `host.py sites NAME --set a,b | --add D | --remove D` — сайты приложения в
  Caddy (сертификат Let's Encrypt выпускается при первом запросе, A-запись —
  заранее). `/ops/v1/*` есть только на ops-хосте `sslip.io`.
- `host.py logs NAME bro-eve --lines 500` — хвост journald.
- `host.py restart NAME [bro-web bro-eve caddy]`, `host.py stop NAME bro-eve bro-web`.
- `host.py ops NAME <скрипт> [аргументы]` — `ops/<скрипт>` текущего релиза
  от `bro` с env сервисов (базы — раздел «База»); аргумент `s3get:`/`s3put:`
  превращается в presigned-ссылку.

## База

Managed PostgreSQL Cloud.ru 18, кластер `bro-pg` в подсети VM
(`Default_ru.AZ-1`): у него только внутренний адрес, базу видят лишь VM этой
подсети, поэтому всё, что ходит в базу, — ops-скрипты на VM.

```sh
host.py pg create      # кластер, если его нет (Standard 1 vCPU/2 ГБ, SSD 20 ГБ, свои бэкапы в 03:00, 14 дней)
host.py pg users       # bro_app; пароль и BACKUP_ENCRYPTION_KEY — в new-secrets.json
host.py pg databases   # bro, bro_workflow, bro_stand, bro_stand_workflow, bro_restore_check (C.UTF-8)
host.py pg status      # кластер, диск, базы, пользователи, бэкапы провайдера
```

Все четыре повторяемы: что есть, остаётся, чего нет — создаётся. Адрес
кластера (`PG_HOST`, `PG_PORT`, `PG_CLUSTER_ID`) тоже в `new-secrets.json`.
Локаль баз — libc `C.UTF-8`: порядок строк как у `builtin C.UTF-8` Neon, а
регистр по Unicode (у `C` `ILIKE` не видит регистра кириллицы, а память ищет
так). Пароль `bro_app` сменить: `pg users --reset-password`, затем
`host.py env` каждой VM.

Скрипты (`host.py ops NAME <скрипт> …`; базы — по именам: `app`, `check`,
`neon`, `db:<имя>` — только `bro_stand` и `bro_restore_check`; пароль в
командную строку не попадает, только в env команды):

| Скрипт                                                         | Что делает                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-backup.sh`                                                 | `pg_dump -Fc` базы `app` → `openssl` AES-256 (`BACKUP_ENCRYPTION_KEY`) → `<BACKUP_PREFIX>/<UTC>.dump.enc` и манифест `.json`; старше 14 дней — удалить, три новых остаются |
| `db-restore.sh KEY\|latest app\|check\|db:<имя> [--replace]`   | сверить с манифестом, расшифровать, в одной транзакции снести свои таблицы цели и восстановить, сверить число строк каждой таблицы                                         |
| `db-restore-check.sh [KEY\|latest]`                            | восстановить в `bro_restore_check`, сверить с дампом (строго) и с живой базой (печатает разницу), очистить                                                                 |
| `db-copy.sh FROM TO [--replace] [--dump-only] [--live-source]` | перенос базы целиком с проверкой: `neon app` — переезд, `app neon` — откат (`docs/cloudru-migration.md`, этап 5)                                                           |

- Дамп лежит только во временном каталоге `0700` в `/var/backups/bro` и
  удаляется по выходу (каталог убитого запуска убирает следующий); с VM
  уходит лишь зашифрованным. В манифесте — sha256 шифровки и дампа, размер,
  число строк по таблицам и пропущенные чужие таблицы, данных нет. Манифест
  кладётся после дампа: дамп без манифеста `latest` пропускает.
- Таблица чужой роли (её дамп пропустил бы, а сверка строк не заметила бы)
  валит бэкап и перенос, если её нет в `ALLOW_FOREIGN_TABLES` (`схема.таблица`
  или `схема.*` через пробел).
- Цель с таблицами — только с `--replace`; любая цель, кроме `check`, — только
  без соединений Бро (`host.py stop NAME bro-eve bro-web`; скрипт смотрит
  соединения до загрузки и ещё раз перед самой транзакцией); базу мира
  скрипты не трогают. `neon` как цель — только на проде (`HOST_PROFILE=prod`)
  и пока Neon стоит только на чтение (окно отката): до окна это живой прод.
  Перед очисткой то, что лежит в цели, уходит зашифрованным в
  `<BACKUP_PREFIX>/<время>-pre<цель>.dump.enc`. Восстановление — одна
  транзакция: сбой оставляет цель как была. Ошибка psql в логе — лишь первая
  строка `ERROR:` без `DETAIL`/`CONTEXT` (там была бы строка таблицы).
- `db-copy.sh` требует замороженный источник: только чтение для приложения
  или никого больше, и ни одной чужой открытой транзакции; число строк и
  счётчики записи (`n_tup_ins+upd+del`) до и после дампа не должны сдвинуться
  (UPDATE число строк не меняет). Схема Neon `neon_auth` не копируется,
  `drizzle` (журнал миграций, с шестью «сиротами» Neon) — да. Копия источника
  шифруется в `<BACKUP_PREFIX>/<время>-<FROM>.dump.enc`; ни она, ни `-pre…`
  сами не удаляются. `--dump-only` — репетиция: доступен ли источник, сколько
  идёт дамп; `--live-source` — копия живой базы в стенд (снимок дампа, без
  проверки заморозки), не для переезда.
- Ключ `BACKUP_ENCRYPTION_KEY` есть только в `new-secrets.json` (и `.bak`) и
  `/etc/bro/env`, deployd его не отдаёт: копию владелец держит в менеджере
  паролей, иначе с потерей сессии бэкапы не прочитать. `pg users` не сделает
  новый ключ, если бэкапы уже есть (только с `--new-backup-key`). Шифр —
  `openssl enc -aes-256-cbc -pbkdf2` без MAC, поэтому манифест подписан
  HMAC-SHA256 ключом из того же `BACKUP_ENCRYPTION_KEY` и называет свой
  объект: ключ S3 лежит в env приложения (а значит, у инструментов модели), и
  подложенный в бакет дамп или старый дамп под новым именем отвергается до
  расшифровки. Удалить бэкапы этот ключ S3 всё равно может.

`bro-backup.timer` — каждую ночь в 04:10–04:20 по Москве (`Persistent`:
пропущенный запуск догоняется): `db-backup.sh`, затем
`db-restore-check.sh latest`. Сбой любого — сразу сообщение владельцу
(`bro-backup-alert.service`, `watchdog.py alert backup`), а watchdog
повторяет его раз в час, пока последний запуск упал, нет ключа или удачного
бэкапа нет больше суток (`/var/backups/bro/last-backup.json`; если не было ни
одного — сутки с того, как watchdog его ждёт). Сбой удаления старых бэкапов
бэкап не валит. Выключить бэкапы и проверку можно только явно —
`BACKUPS=off`; без ключа или `BACKUP_CHECK_DATABASE_URL` они падают. Логи —
`host.py logs NAME bro-backup`.
База мира (`bro_workflow`) не бэкапится: в ней только идущие ходы.

## Watchdog

`bro-watchdog.timer` раз в минуту: `GET 127.0.0.1:3000/api/health`,
`127.0.0.1:4274/eve/v1/health` (пока нет релиза — только Caddy), Caddy —
`systemctl is-active` и порт 443. Лежит дольше 5 минут — сообщение владельцу,
повтор не чаще раза в час, и сообщение о восстановлении. Бот и чат —
`OPS_ALERT_BOT_TOKEN`/`OPS_ALERT_CHAT_ID` из `/etc/bro/env`, иначе
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_OWNER_CHAT_ID` приложения. Состояние —
`/var/lib/bro/watchdog.json`; несданное сообщение (и о восстановлении)
уходит на следующем тике.

Watchdog живёт на той же VM: падение VM, сети, DNS, истёкший сертификат он
не заметит. Внешней проверки `https://<домен>/eve/v1/health` пока нет — её
нужно завести до переключения прода (мониторинг Cloud.ru или внешний пинг).
`/api/health` снаружи закрыт Caddy (404), его спрашивают только по loopback.
