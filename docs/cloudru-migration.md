# Переезд с Vercel на Cloud.ru — по пути к устройству Instinct

План от 1 октября 2026 (решение владельца: уходим с Vercel). Переносим не
«как есть»: каждый этап заодно меняет ту часть Бро, которую Instinct устроил
лучше (`docs/instinct.md`). Браузер уже на Cloud.ru (пул песочниц, пилот
владельца с 01.10, `docs/browser-pool.md`).

## Куда идём

| Слой        | Сейчас (Vercel)                                       | Цель (Cloud.ru, как у Instinct)                                                              |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Цикл агента | eve на Vercel Workflow, один агент в четырёх режимах  | `eve start` на VM, состояние ходов в Postgres; главный агент и task-агенты (субагенты eve)   |
| Код и файлы | нет (песочница eve — только вложения, Vercel Sandbox) | своя песочница: gVisor на хосте Cloud.ru, Go `sandboxd`, Rust CLI `tools`, файлы в S3        |
| Инструменты | 59 схем в каждом шаге                                 | узкое ядро в главном агенте; остальное — CLI `tools` в песочнице через GraphQL-маршрутизатор |
| Модели      | OpenRouter (из РФ — 403), Gateway                     | RouterAI (OpenAI-совместимый, работает из РФ); OpenRouter — пока бэкенд вне РФ               |
| Хранилище   | Vercel Blob, Neon                                     | Object Storage Cloud.ru (`bucket-ac164a`), Managed PostgreSQL Cloud.ru                       |
| Расписания  | Vercel Cron из Build Output                           | планировщик Nitro в процессе eve на VM (один на всю базу)                                    |

## Этапы

Промпт сессии, которая проходит оставшиеся этапы целиком и автономно, —
`docs/cloudru-full-migration-prompt.md`.

Каждый этап — отдельный PR со своим «готово»; прод переключается флагом или
переменной окружения, откат — снять флаг. Исключение — база (этап 5): после
переключения новые записи живут только в Cloud.ru, и откат — не переменная
(как его делать — в этапе 5).

### 1. Песочница и task-агент — сделано в этом PR

`sandbox/` (Go `sandboxd`, Rust `tools`, образ, хост), `agent/lib/sandbox/`
(бэкенд песочницы eve, маршрутизатор `/eve/v1/sandbox-tools`, ссылки на файлы
`/eve/v1/sandbox-files/…`), субагент `agent/subagents/task`. Включается
`SANDBOX_HOST_ID`, `SANDBOX_HOST_ORIGIN`, `SANDBOX_SIGNING_KEY` и пилотом
`SANDBOX_WORKSPACES`; модель task-агента идёт через прямого провайдера, так
что нужен ключ RouterAI или OpenRouter (этап 3). На Cloud.ru живёт только хост
песочниц: цикл task-агента, маршрутизатор `/eve/v1/sandbox-tools` и ссылки на
файлы пока работают в Бро на Vercel и строятся от `applicationOrigin()` — они
переедут с этапом 4, и для песочницы при этом меняется только адрес
маршрутизатора.

Готово: в аккаунте владельца Бро по просьбе «сделай презентацию…» отдаёт
задачу субагенту и присылает .pptx; файлы песочницы переживают её остановку.
Выполнено в проде 01.10 (PR 257): .pptx на 5 слайдов пришёл вложением через
≈ 1 мин, ссылка ведёт на подписанный адрес Object Storage.

### 2. Хранилище: Blob → Object Storage — код готов

Сделано (PR «Хранилище: файлы Бро в Object Storage Cloud.ru»):

- Картинки, снимки экрана, фото-референсы, вложения Gmail и файлы Диска
  пишутся и читаются в бакете пула (`BROWSER_STATE_BUCKET`, ключи
  `CLOUDRU_*`) под ключом `artifacts/<прежний storage_pathname>`
  (`shared/object-storage/artifacts.ts`); строки БД не менялись. Маршрут
  `/artifacts/<id>` по-прежнему проверяет сессию и владельца и отдаёт байты
  сам (серверный GET по подписанной ссылке, ETag/304, те же заголовки).
  Подпись SigV4 — `shared/object-storage/` (нужна и `agent`, и `app`).
- Что Бро говорит людям о хранении (`agent/lib/privacy/facts.ts`, инструкции
  `role/interactive.md`, текст отключения Google): файлы — в Object Storage
  Cloud.ru, Cloud.ru — в списке обработчиков; приложение и база — пока Vercel
  и Neon, менять с переключением.
- Ключи `BETTER_AUTH_SECRET` и `SECRET_ENCRYPTION_KEY`: как раньше — из env,
  а без них из Blob (`db/services/installation-secrets.ts`, `@vercel/blob`
  остаётся ради этого до конца недели отката). В env `bro-next` их нет, и
  Vercel-прод продолжает брать их из Blob. 02.10 сверено по sha256 (значения
  не печатались): `~/.bro-app-host/env/installation-secrets.json` совпадает с
  объектом Blob прода (`openinstinct/system/<sha256(id bro-next)[:32]>/…`).
  На VM задать оба из этого файла; убрать чтение Blob — в PR переключения.
- Файловая память eve — таблица `memory_documents` (версия для CAS) вместо
  `vercelBlob`; в Blob документов памяти не было, переносить нечего.
- Копия Blob → S3: `scripts/cloudru-app-host/blob-to-s3.ts` (идемпотентно,
  сверка размера и типа; sha256 байтов с именем — только у
  `browser-images/`, `generated-images/` и `reference-photos/`, вложения
  Gmail и файлы Диска — лишь размер и тип; `openinstinct/system/*` не
  копируется). 02.10
  скопированы все 146 объектов (≈ 36 МиБ), повторный прогон ничего не копирует.
  После слияния прогнать ещё раз: картинки, записанные в Blob между копией и
  деплоем, доедут.
- Песочница главного агента (вложения человека, `eve-sandbox:`):
  `agent/sandbox.ts`, переменная `AGENT_SANDBOX` — `default` (ровно
  `defineSandbox({})`, как встроенная песочница eve) или `bro-cloudru` (хост
  песочниц, 1 ГиБ на сессию, простой 20 мин → снимок `/workspace` в S3). Ключ
  песочницы сессии без `bootstrap` и файлов workspace — имя бэкенда, проект,
  сессия и узел, без хэша файла (`eve/dist/src/runtime/sandbox/keys.js`;
  план шаблона `none` проверен на скомпилированных манифестах до и после),
  так что на Vercel живые сессии остаются в своих песочницах. Новую
  песочницу заводит только смена `AGENT_SANDBOX` (меняется имя бэкенда):
  вложения старых сессий на VM не переедут. Переменную модуль читает при
  загрузке — задавать и для `eve build`, и при запуске.
- PR слит в `bro-next` (02.10): сборка Vercel с ним пишет и читает S3, как
  VM, поэтому откат прода с VM на такую сборку вложения не теряет. Теряет
  только откат на сборку до PR: она читает лишь Blob, и картинки и вложения,
  записанные после деплоя PR, пропадут — перед таким откатом скопировать
  `artifacts/` из S3 обратно в Blob или принять потерю. Какая сборка в проде
  Vercel — сверить перед окном (коммит текущего прод-деплоя `bro-next` не
  старше слияния PR). `BLOB_READ_WRITE_TOKEN` и сам
  Blob не трогать до конца недели отката.
- Перед переключением: `blob-to-s3.ts` (копия; повтор берёт и объекты с
  неверным типом), затем `blob-to-s3.ts --verify` с `DATABASE_URL` прода
  (только чтение) — каждая строка артефакта есть в S3 с её размером и типом;
  печатает только счётчики. 02.10 копия с проверкой типа (`--dry-run`): все
  146 объектов на месте с тем же типом, что в Blob. `--verify` не гонялся: чтение продовой
  базы из облачной сессии требует разрешения владельца.

Осталось: живой ход с фото, голосовым и PDF на `AGENT_SANDBOX=bro-cloudru`
против нового хоста `sbx-code-2`; на VM Бро задать `AGENT_SANDBOX=bro-cloudru`.

### 3. Модели: RouterAI — код готов, прод не переключён

С VM Cloud.ru openrouter.ai, OpenAI и Anthropic отвечают 403
(`docs/browser-infra-notes.md`). RouterAI (`routerai.ru/api/v1`) работает и
уже ведёт модель браузера.

Сделано: `MODEL_PROVIDER=routerai` (с `ROUTERAI_API_KEY`) переводит на RouterAI
главного агента и субагентов (`agent/lib/model/direct.ts`, адрес и ключ —
`agent/lib/model/endpoint.ts`), распознавание речи, картинки, поиск (`web`
plugin на Exa), алерт о балансе и учёт цены (`usage.cost` в рублях). Без
`MODEL_PROVIDER` всё идёт как раньше: OpenRouter при его ключе, иначе Gateway.
Особенности RouterAI — в `docs/dev-notes.md`, раздел «OpenRouter и RouterAI».

Эвалы на RouterAI 01.10 (DeepInfra первым): `reply` 6 из 6, `schedules` 7 из 7,
`scheduled-lifecycle` 2 из 3 — в упавшем воркер отказался повторить
непроверенную «цену» из промпта эвала. 66 шагов — 9,63 ₽ по `usage_costs`,
баланс RouterAI упал на 9,62 ₽; кэш — 84% входа. Прогнать рядом OpenRouter
нельзя: он не пополняется.

Осталось:

- превью с `MODEL_PROVIDER=routerai`: ответ, голосовое, картинка, поиск,
  расписание, отказ на карточке, затем строки `usage_costs` с ценой;
- переключение прода: ключ и `MODEL_PROVIDER=routerai` в env `bro-next`, новый
  деплой; воркспейсам с id, которого нет в `/models` RouterAI, сбросить
  `settings.gateway_model`. Откат — снять `MODEL_PROVIDER`, пока у OpenRouter
  есть деньги, дальше — другой `ROUTERAI_PROVIDER_ORDER` или модель;
- через неделю стабильной работы — убрать ветку и переменные OpenRouter.

Заодно — навыки по нужде и узкое ядро инструкций (роадмап 24–25): на RouterAI
кэш DeepSeek дешевле в 8 раз только при стабильном префиксе.

Готово: эвалы `reply` и `schedules` на RouterAI не хуже OpenRouter; шаг
дешевле при той же доле кэша.

### 4. Цикл агента: свой сервер на Cloud.ru — инструменты готовы, VM не создана

Сделано (`scripts/cloudru-app-host/README.md`): инструментарий разворачивает
одну VM `bro-app-1` (gen-2-8, SSD 40 ГБ, `ru.AZ-1`, группа `bro-browser-az1`) с
Caddy, Next (standalone,
`127.0.0.1:3000`) и eve (`node .output/server/index.mjs`, `127.0.0.1:4274`,
`TZ=UTC`) под systemd. Сборка — в сессии (`host.py build`): мир
`@workflow/world-postgres@5.0.0-beta.44` и `output: "standalone"` включаются
только переменными сборки `WORKFLOW_WORLD=postgres` и `NEXT_OUTPUT=standalone`,
без них сборка Vercel прежняя. Релиз — один `tar.zst` в Object Storage;
`deployd` на VM скачивает, сверяет sha256, применяет миграции Бро и схему мира
(`ops/migrate.mjs`, без pnpm и drizzle-kit), переключает `current` и за
120 с ждёт `/api/health` (Next + `select 1`) и `/eve/v1/health`, иначе
возвращает прошлый релиз. Расписания выключает `EVE_SCHEDULES=off` (стенд);
watchdog раз в минуту пишет владельцу в Telegram, если сервис лежит дольше
5 минут. Стенд работает на копии данных прода и открыт в интернет, поэтому
без ключей, которые пишут людям, в Blob, Supermemory и Composio прода или
тратят деньги на Browser Use; ни процессы `bro`, ни Caddy не видят metadata VM
(в user data — ключ deployd).

- Caddy: `/eve/*` — прямо в eve (`flush_interval -1`: прокси Next рвёт
  потоки через 30 с), остальное — в Next. `/.well-known/workflow/*` наружу
  **не** публикуется (404): вход очереди мира без авторизации, мир ходит в него
  по loopback.
- База мира — отдельная (`bro_workflow`, на стенде `bro_stand_workflow`): мир
  на старте перезапускает все незаконченные прогоны своей базы, две среды на
  одной базе исполняли бы чужие ходы.
- Планировщик Nitro запускает расписания сам: на время переключения
  расписания Vercel выключить, двух планировщиков на одной базе не держать.
- Состояние на инстанс (`pg.Pool`, троттлинг Telegram, ограничитель
  Nominatim) остаётся корректным на одной VM; на нескольких — вынести в
  Postgres.
- Старые сессии Vercel Workflow не переносятся: новые ходы идут в новый мир,
  старые доживают на Vercel до отключения.

Осталось: создать `bro-app-1`, env стенда
(`host.py env --profile stand`), сайт `cloud.brobro.tech` и прогнать стенд;
проверить ход через мир Postgres, переживание `systemctl restart bro-eve`,
поток SSE через Caddy и доступность `api.telegram.org` с VM. Квота
публичных IP проекта — 2, и 02.10 обе заняты (`sbx-code-1` и пробная VM
другой сессии): для `bro-app-1` освободить адрес или попросить поддержку
поднять квоту. Watchdog живёт на той же VM: до переключения прода завести
внешнюю проверку `https://brobro.tech/eve/v1/health`.

Готово: перезапуск сервера не теряет ходов и карточек, расписания не
дублируются.

### Сеть Cloud.ru: Telegram и адреса между VM

Пробы 02.10 (`ru.AZ-1`, VM с публичным IP, запросы строго по одному):

- `api.telegram.org`: DNS даёт 149.154.166.110 — 0 TCP-соединений; из 22
  адресов Telegram открывается только 149.154.167.220 (сертификат
  `api.telegram.org`), и там 78–85% попыток: пропавший SYN не возвращается,
  удачное соединение — за ~45 мс. `t.me` закрыт; входящие вебхуки не
  затронуты.
- Обход — `scripts/cloudru-app-host/tg-egress/` на VM Бро: `/etc/hosts` ведёт
  `api.telegram.org` на 127.77.0.1, iptables REDIRECT — на форвардер, который
  до первого байта клиента находит открывшееся соединение (новая попытка каждые
  300 мс). TLS сквозной, код eve и Бро не меняется, сторож VM (urllib) идёт тем
  же путём. Запасной путь — CONNECT через прокси (`TG_EGRESS_PROXY`), с VM не
  проверен. Итог живой проверки — ниже. Выкат и сторож VM проверяют путь
  `tg_egress.py --check` (по имени, через `/etc/hosts` и REDIRECT) и тревожат
  не через Telegram.
- VM проекта не достаёт до публичного IP другой VM проекта (hairpin нет), по
  приватному 10.0.1.x — да, с тем же sslip.io-именем и сертификатом. Поэтому
  на VM Бро `CLOUDRU_PRIVATE_ROUTING=on`: запросы к хосту песочниц, хостам
  пула и worker браузерных VM (fetch и WebSocket CDP) набирают приватный IP,
  найденный в Compute API (`agent/lib/browser-vm/private-route.ts`). Обратно
  в Бро ходит только `sandboxd` (`/eve/v1/sandbox-tools`): хосту песочниц —
  `host.py create … --hosts-entry brobro.tech=bro-app-1` или на живом хосте
  `host.py set-hosts`. Хосты пула и worker в Бро не звонят.
- Новая VM, открывшая 3–8 соединений разом в первые минуты, теряла TCP и UDP
  насовсем: установка — последовательно и после 60 с стабильной сети.

Живая проверка форвардера 02.10 (пробная VM `low-1-1`, `ru.AZ-1`, ubuntu
22.04, Python 3.10, systemd 249; поддельный токен — `getMe` отвечает 401, как
только запрос дошёл до Bot API): 200 из 200 `curl getMe` через `/etc/hosts` и
форвардер (p50 0,15 с, p90 0,46 с, максимум 2,15 с), 20 из 20 через urllib.
В те же минуты напрямую на 149.154.167.220 с таймаутом 5 с — 54 из 60. Из 221
соединения форвардера 170 открылись с первой попытки, 51 — со второй–четвёртой,
ни одно не потеряно.

### 5. База: Neon → PostgreSQL Cloud.ru — кластер и бэкапы готовы, данные не перенесены

Сделано (`scripts/cloudru-app-host/README.md`, раздел «База»): кластер
Managed PostgreSQL 18 `bro-pg` (Standard 1 vCPU/2 ГБ, SSD 20 ГБ, один узел,
подсеть `Default_ru.AZ-1`), пользователь `bro_app`, базы `bro`,
`bro_workflow`, `bro_stand`, `bro_stand_workflow` и `bro_restore_check`, все
libc `C.UTF-8` (`host.py pg create|users|databases|status`, повторяемы;
пароль и ключ бэкапов — в `new-secrets.json`, `host.py env` сам собирает из
них `DATABASE_URL` и `WORKFLOW_POSTGRES_URL` профиля). Кластер виден только из
подсети VM: Vercel до него не достанет, поэтому база переезжает в одно окно с
приложением (этап 6), а все операции с ней — ops-скрипты на VM.

- Бэкап каждую ночь (`bro-backup.timer`, 04:10 МСК): `pg_dump -Fc` → AES-256
  (`BACKUP_ENCRYPTION_KEY`) → `backups/postgres/<время>.dump.enc` в
  `bucket-ac164a` с манифестом, 14 дней; сразу за ним — восстановление в
  `bro_restore_check` со сверкой числа строк каждой таблицы. Манифест подписан
  HMAC ключом бэкапов: подложенный в бакет дамп не восстановится. Сбой —
  сообщение владельцу в Telegram и повтор раз в час, пока не пройдёт; нет
  удачного бэкапа больше 26 часов или нет ключа — тоже. Выключить — только явно
  (`BACKUPS=off`). Свои бэкапы
  кластера (ежедневно, 14 дней) — второй слой: они восстанавливают лишь в
  новый кластер.
- Перенос — `db-copy.sh neon app --replace`: дамп Neon (`pg_dump` 18, без
  `neon_auth`, со схемой `drizzle` и её шестью «осиротевшими» строками — они
  безвредны: drizzle смотрит только на последний `created_at`), число строк
  источника до и после дампа и в дампе совпадает, счётчики записи не сдвинулись,
  а до дампа источник обязан стоять только на чтение без открытых транзакций;
  копия источника — зашифрованной в `backups/postgres/<время>-neon.dump.enc`,
  копия цели — в `<время>-preapp.dump.enc`, восстановление одной транзакцией и
  сверка каждой таблицы. Таблица чужой роли валит перенос, а не теряется молча.

Осталось: на VM проверить, что `pg_dump` достаёт Neon по 5432 (`host.py ops
bro-app-1 db-copy.sh neon app --dump-only` с `host.py env … --with-neon`;
из облачной сессии 5432 закрыт), репетиция переноса в `bro_stand`
(`db-copy.sh neon app --replace --live-source` на стенде: Neon ещё живой) и
первый ночной бэкап с проверкой.

**Ворота перед этапом 6 (действие владельца):** копия `BACKUP_ENCRYPTION_KEY`
из `~/.bro-app-host/env/new-secrets.json` лежит в менеджере паролей владельца.
Ключ есть только там и в `/etc/bro/env` VM (deployd его не отдаёт): потеря VM
и сессии без этой копии — потеря всех бэкапов.

Окно переноса — вместе с этапом 6, по шагам — раздел «Переключение» ниже:
Neon только для чтения (`ops/db-neon-mode.sh read-only`), `db-copy.sh neon
app --replace`, env прода. `NEON_DATABASE_URL` остаётся в `/etc/bro/ops-env`
на неделю наблюдения — для отката; после недели — `host.py env bro-app-1
--profile prod` без `--with-neon`, это его убирает.

Откат базы:

- **До первой записи в Cloud.ru** (DNS ещё не переключали или переключили и
  сразу вернули): DNS назад, `db-neon-mode.sh writable` (`RESET
default_transaction_read_only` и `pg_terminate_backend` соединений Vercel),
  расписания Vercel включить. Neon всё это время не менялся.
- **После записей в Cloud.ru** — обратный перенос в новое окно только для
  чтения. Neon с момента переноса стоит только на чтение, поэтому в нём нечего
  беречь, и вместо дампа «новых строк» переносится база целиком: так
  приезжают и изменения, и удаления, и проверка та же. По шагам: `host.py stop
bro-app-1 bro-eve bro-web` (запись в Cloud.ru кончилась) → `host.py ops
bro-app-1 db-neon-mode.sh read-only` (повтор: Neon остаётся только для
  чтения, а прочие сессии роли завершаются) → `host.py ops bro-app-1
db-copy.sh app neon --replace` (пишет сквозь `read_only` Neon и только пока он
  `read_only`, только с VM прода и без чужих сессий в Neon: `read_only` —
  лишь умолчание новых сессий, открытая раньше пишет; перед этим кладёт
  зашифрованные копии `app` и самого Neon в Object Storage) →
  `db-neon-mode.sh writable` (`RESET default_transaction_read_only` и
  `pg_terminate_backend`) → DNS назад,
  расписания Vercel включить. Записи Cloud.ru после `stop` не теряются: их
  нет. VM с базой не удалять, пока Vercel не проработал неделю.
- Логическая репликация Cloud.ru → Neon не используется: у `bro_app` нет
  права `REPLICATION` (роли кластера — `pg_monitor`, `pg_read_all_data`,
  `pg_write_all_data`, `pg_signal_backend`), а `wal_level` Neon — `replica`;
  не проверена — не полагаться.

Готово: бэкап за прошлую ночь восстанавливается проверкой, перенос с
Neon сошёлся по всем таблицам, откат отрепетирован на `bro_stand`.

### 6. Переключение

Окно — ночь, 02:00–06:00 МСК (23:00–03:00 UTC). Команды — из облачной сессии
(`host.py` — `python scripts/cloudru-app-host/host.py`), DNS и проект —
Vercel API с `VERCEL_TOKEN` (`$T` ниже — токен без пробелов и кавычек,
`$Q` — `slug=nikto256-6851s-projects`). Вебхуки Photon, ЮKassa, Browser Use
и возвраты Composio остаются на том же домене `brobro.tech`; Telegram —
мостом, без вебхука (раздел ниже), поэтому `setWebhook` не нужен.

**До окна (днём, не в окно):**

Окно накрывает ночной бэкап VM (`bro-backup.timer`, 04:10–04:20 МСК,
`Persistent=true`): с env прода он снял бы пустую `bro` в прод-префикс как
«последний» и мог бы уронить `db-copy.sh` (`no_bro_connections`), поэтому
шаг 2 выключает его вместе с расписаниями, а после шага 6 бэкап снимается
вручную. И с шага 4 до шага 7 запись Бро на Vercel падает, а VM ещё не
принимает: Telegram копит (`hold`), ЮKassa по своей документации повторяет
уведомление до ответа `200` (до суток), а повторяет ли Photon вебхук
iMessage — не проверено: входящие iMessage этих минут считать потерянными.
Шаги 4–7 идут подряд, без пауз (запрос DNS из шага 7 подготовить заранее).

1. Ворота этапа 5 пройдены: копия `BACKUP_ENCRYPTION_KEY` у владельца,
   репетиция `db-copy.sh` на стенде, ночной бэкап с проверкой.
2. `~/.bro-app-host/env/prod.json` (`0600`): `TELEGRAM_OWNER_CHAT_ID` (на
   Vercel его нет), `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` (sensitive на
   Vercel, в сессии нет) и `OPS_ALERT_WEBHOOK_URL` (https, push-канал
   владельца не через Telegram: тревога о пути к Telegram иначе никуда не
   дойдёт). Канал проверить тестовой отправкой (`curl -sS -o /dev/null -w
'%{http_code}' -d test "$URL"` — `2xx`, у владельца пришло). `host.py env
bro-app-1 --profile prod --dry-run` не должен печатать «not found» и
   «would refuse»: без `--dry-run` прод с таким env не уходит.
3. Секреты, сделанные для переезда (`new-secrets.json`), — те же на Vercel,
   иначе откат ломается: `TELEGRAM_WEBHOOK_SECRET_TOKEN` (мост и
   `switch-to-webhook` шлют его; eve на Vercel со старым ответит 401) —
   записать на Vercel прод (sensitive), передеплоить прод и сразу
   `setWebhook` на `https://bro-next.vercel.app/eve/v1/telegram` с новым
   секретом (curl из README моста, «Откат без VM»; Telegram повторяет
   отвергнутые обновления). `BROWSER_VM_SIGNING_KEY`: из него выведены ключи
   живых хостов пула `bro-host-*` и VM пилота — либо на VM идёт значение
   Vercel (владелец кладёт его в `prod.json`), либо после переключения хосты
   пула и VM пилота пересоздаются.
4. Код хоста на `bro-app-1`: `host.py update-host bro-app-1`, затем
   `host.py ops bro-app-1 tg-bridge.sh status` — `tg-egress: active, check:
ok` и `no TELEGRAM_BOT_TOKEN in /etc/bro/env (stand env)`: в стендовом env
   токена нет, вебхук отсюда не виден. Вебхук — из сессии: `curl -sS
"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"` — `url`
   на `bro-next.vercel.app`. Релиз с `ops/db-neon-mode.sh`: `host.py deploy
bro-app-1` (пока со стендовым env).
5. Хосту песочниц — адрес Бро: `python scripts/cloudru-code-host/host.py
set-hosts sbx-code-2 --hosts-entry brobro.tech=bro-app-1 --hosts-entry
cloud.brobro.tech=bro-app-1` (ждать `2`).
6. TTL: записи зоны `brobro.tech` (DNS Vercel, `ns1/ns2.vercel-dns.com`) — 60
   с (02.10: `@` ALIAS, `*` ALIAS, CAA с `letsencrypt.org`); новые A — тоже 60. Проверка: `dig +noall +answer brobro.tech @ns1.vercel-dns.com`.
7. Внешняя проверка `https://brobro.tech/eve/v1/health` (мониторинг Cloud.ru
   или внешний пинг): сторож VM не видит падения самой VM и сети.
8. В день окна — дельта Blob → S3 (раздел 2): `blob-to-s3.ts`, затем
   `blob-to-s3.ts --verify` с `DATABASE_URL` прода (только чтение, печатает
   счётчики; нужно разрешение владельца на чтение продовой базы). VM читает
   вложения только из S3: ненайденных быть не должно.

**Окно:**

1. 02:00 — расписания Vercel выключить: проект `bro-next` → Settings → Cron
   Jobs → Disable Cron Jobs. Проверка: `curl -sS -H "Authorization: Bearer
$T" "https://api.vercel.com/v9/projects/bro-next?$Q"` — `crons.disabledAt`
   не `null`. Иначе стадия `vms` поллера Vercel по базе только для чтения
   всё равно гасила бы VM Cloud.ru, а с VM их было бы два.
2. Env прода на VM с выключенными расписаниями и бэкапами (база `bro` ещё
   не та): в `prod.json` временно `"EVE_SCHEDULES": "off"` и `"BACKUPS":
"off"`, затем `host.py env bro-app-1 --profile prod --with-neon` (до
   рестарта deployd накатывает миграции релиза на `bro` и схему мира на
   `bro_workflow`; `WARNING` о двух `off` — ожидаемо).
3. Telegram копит обновления (до 24 ч): `host.py ops bro-app-1 tg-bridge.sh
hold` — `deleteWebhook` без потери ожидающих; Vercel больше их не получает.
   Вебхук команда снимает, только если health eve на VM отвечает `200` (после
   шага 2 — да). Hold без моста дольше трёх часов сторож считает тревогой.
4. Neon только для чтения: `host.py ops bro-app-1 db-neon-mode.sh read-only`
   (`ALTER DATABASE … SET default_transaction_read_only = on` и
   `pg_terminate_backend` прочих сессий роли; ждать `default_transaction_read_only=on`).
   С этой минуты запись Бро на Vercel падает, чтение работает.
5. `host.py stop bro-app-1 bro-eve bro-web` (плановая: сторож молчит о них
   до трёх часов, `plannedStop` в `host.py status`), затем `host.py ops
bro-app-1 db-copy.sh neon app --replace` (сверка всех таблиц).
6. Из `prod.json` убрать `EVE_SCHEDULES` и `BACKUPS`, `host.py env bro-app-1
--profile prod --with-neon` — eve и Next поднимаются на перенесённой базе с
   расписаниями (`host.py status`: список `off` пуст). Сразу `host.py ops
bro-app-1 db-backup.sh` — первый бэкап прода уже перенесённых данных и
   свежий `last-backup.json` (иначе сторож к утру поднимет тревогу по
   бэкапу стенда прошлой ночи); ночной по таймеру — со следующей ночи, а
   совпав с ручным, ждёт его: скрипты базы идут по одному (`db_lock`).
7. DNS на VM. Сначала листинг зоны (POST не идемпотентен — повтор после
   потерянного ответа дал бы вторую A): `curl -sS -H "Authorization: Bearer
$T" "https://api.vercel.com/v4/domains/brobro.tech/records?$Q&limit=100" |
python3 -c 'import json,sys; [print(r["id"], r["name"] or "@", r["type"],
r["value"]) for r in json.load(sys.stdin)["records"]]'`. Для имени, у
   которого A с `176.109.111.216` ещё нет: `curl -sS -X POST -H
"Authorization: Bearer $T" -H "Content-Type: application/json"
"https://api.vercel.com/v2/domains/brobro.tech/records?$Q" -d
'{"name":"","type":"A","value":"176.109.111.216","ttl":60}'` и то же с
   `"name":"www"`; после — снова листинг: ровно одна такая A на имя. Проверка — `dig +short
A brobro.tech @ns1.vercel-dns.com` и `www.brobro.tech`: только
   `176.109.111.216`. Если отвечает и ALIAS Vercel, снять домены с проекта
   (`DELETE /v9/projects/bro-next/domains/www.brobro.tech`, затем
   `…/brobro.tech`): зона остаётся в аккаунте, `bro-next.vercel.app` — тоже.
8. `host.py sites bro-app-1 --set brobro.tech,www.brobro.tech` (`www` — 308
   на апекс; `cloud.brobro.tech` уходит). Сертификаты Let's Encrypt Caddy
   берёт сразу, раз A уже на VM; проверка — `curl -sSI
https://brobro.tech/` и `https://www.brobro.tech/x` (308 на
   `https://brobro.tech/x`).
9. `host.py ops bro-app-1 tg-bridge.sh switch-to-bridge` — проверка
   tg-egress, мост забирает накопленное.
10. Внешние адреса — только сверить: Photon — вебхук
    `https://brobro.tech/eve/v1/photon`, ЮKassa — HTTP-уведомления
    `https://brobro.tech/api/yookassa`, Browser Use (если вебхук задан) —
    `https://brobro.tech/eve/v1/browser-use`, Composio — возврат собирается из
    `BETTER_AUTH_URL`. Адрес на `bro-next.vercel.app` в кабинете — заменить на
    `brobro.tech`.
11. Проверки: `host.py status bro-app-1` (health web/eve, `telegram`,
    `watchdog.down` пуст); `curl https://brobro.tech/eve/v1/health`; вход
    по телефону (код iMessage), веб-чат с ответом, сообщение и кнопка
    карточки в Telegram (`host.py ops bro-app-1 tg-bridge.sh status`:
    `delivered` растёт, `dropped` 0), iMessage туда и обратно, фото в чат
    (Object Storage), поручение task-агенту в песочнице (`sandboxd` → Бро по
    приватному адресу), браузерное поручение пилота — только если на VM
    значение `BROWSER_VM_SIGNING_KEY` Vercel (пункт 3 «До окна», первый вариант); при
    втором — после пересоздания хостов пула и VM пилота, до того поручения
    пилота падают; `host.py logs bro-app-1 bro-eve` без ошибок; на Vercel
    runtime-логи `bro-next` затихли.

**Откат** (решение — до 06:00; первым делом записать время):

1. `host.py stop bro-app-1 bro-eve bro-web` — запись в Cloud.ru кончилась.
   Мост не трогать: он держит неподтверждённые обновления и ждёт eve.
2. База: были записи в Cloud.ru (почти всегда — расписания, сообщения) —
   `host.py ops bro-app-1 db-neon-mode.sh read-only` (повтор: завершает
   сессии Vercel, открытые после шага 4 окна; копия в Neon идёт только без
   чужих сессий), затем `host.py ops bro-app-1 db-copy.sh app neon
--replace`: Neon получает базу целиком (и изменения, и удаления; пишет
   сквозь `read_only` и только пока он `read_only`, копии обеих сторон — в
   Object Storage). Отказ «other sessions on Neon» — Vercel переподключился:
   повторить оба шага. Скрипты базы идут по одному (`db_lock`): идущий
   ночной бэкап (04:10 МСК) копия ждёт до часа. Записей не было — копию
   пропустить. Затем `host.py ops bro-app-1 db-neon-mode.sh writable`.
3. Vercel: Cron Jobs → Enable; если домены снимали — вернуть
   (`POST /v10/projects/bro-next/domains` с `brobro.tech` и `www.brobro.tech`
   c `"redirect":"brobro.tech","redirectStatusCode":308`).
4. DNS: листинг зоны (шаг 7 окна) и `DELETE
/v2/domains/brobro.tech/records/<id>` для каждой A со значением
   `176.109.111.216`, не только сохранённых id; повторный листинг — таких
   нет, `dig` снова отдаёт ALIAS Vercel.
5. Telegram: `host.py ops bro-app-1 tg-bridge.sh switch-to-webhook
https://bro-next.vercel.app/eve/v1/telegram` (мост выключается,
   доставленное подтверждается, `setWebhook` с тем же секретом). VM или её
   выход к Telegram лежит — `setWebhook` с любой машины с доступом к
   Telegram (README моста, «Откат без VM»), а когда путь VM к Telegram
   вернётся — та же `switch-to-webhook` с тем же адресом: мост выключится.
6. Записи: всё, что Бро записал в Cloud.ru, приехало в Neon шагом 2;
   записи Vercel в окне не случились (Neon был только для чтения — эти
   запросы упали, а не потерялись молча; входящие iMessage этого времени
   могли пропасть — см. начало раздела). Файлы, загруженные на VM, лежат в
   Object Storage, и сборка Vercel с PR хранилища читает их оттуда же; на
   сборке до него они не откроются (раздел 2). Ходы, шедшие в мире
   `bro_workflow`, не переносятся. VM и базу не удалять неделю.
7. Браузер: если по пункту 3 «До окна» хосты пула и VM пилота пересоздавали с новым
   `BROWSER_VM_SIGNING_KEY`, Vercel со своим ключом до них не достучится —
   на откате их пересоздать снова (или положить ключ VM на Vercel и
   передеплоить), до того браузерные поручения пилота падают.

### Наблюдение 24 ч

- Каждый час первые 6 часов, потом утром и вечером: `host.py status
bro-app-1` — health, `watchdog.down` и `watchdog.undelivered` пусты,
  `telegram.bridgeEnabled`; внешняя проверка зелёная.
- Telegram: `tg-bridge.sh status` — `status: polling`, `pending` 0,
  `dropped` 0, `eveRefused` false; `journalctl` форвардера — нет `upstream
down`, доля успехов `/health` tg-egress не ниже 90%.
- Расписания идут один раз: на VM тики в `host.py logs bro-app-1 bro-eve`
  (`[proactive] check`, поллер браузеров), на Vercel `crons.disabledAt`
  стоит, runtime-логов нет. Neon остаётся `read_only` (`db-neon-mode.sh
status`) — до решения об откате.
- Первая ночь после переезда (окно сняло бэкап вручную, шаг 6):
  `bro-backup.timer` в 04:10 МСК — бэкап и проверка восстановления прошли (`host.py logs bro-app-1 bro-backup`, без тревоги).
- Ошибки: `host.py logs bro-app-1 bro-eve` и `bro-web` — `turn.failed`,
  `MODEL_CALL_FAILED` (баланс RouterAI, алерт кредитов), 5xx Caddy;
  диск (`diskFreeGb`) и память VM.
- Каналы: iMessage (Photon) доставляет в обе стороны, вход по коду,
  оплата ЮKassa (уведомление дошло, подписка продлилась), подключение
  Composio возвращает на `brobro.tech`, поручения браузера и task-агента.
- Через неделю без отката: `host.py env bro-app-1 --profile prod` без
  `--with-neon` (убирает адрес Neon), Neon — в архив, затем уборка Vercel
  (`vercel.json`, Gateway-строки моделей, зависимость `vercel`, Blob).

### Telegram из РФ

В РФ Telegram работает только через VPN. С VM Cloud.ru адрес
`api.telegram.org` из DNS не отвечает, запасной `149.154.167.220` — в 5
случаях из 6 (замеры и живая проверка форвардера — раздел «Сеть Cloud.ru»
выше); входящий вебхук на адрес в РФ ненадёжен. Поэтому:

- **Исходящие** (eve и Бро: `sendMessage`, `answerCallbackQuery`, файлы,
  алерты владельцу) — без правки кода: `/etc/hosts` и REDIRECT ведут
  `api.telegram.org` в форвардер `scripts/cloudru-app-host/tg-egress/`,
  который перебирает адреса Telegram и, если задан, прокси вне РФ.
- **Входящие** — мост `scripts/cloudru-app-host/tg-bridge/`: long polling
  `getUpdates` и POST каждого обновления в локальный eve с секретом, как это
  сделал бы вебхук. Offset — только после `200` от eve (или явного выброса
  «ядовитого» обновления), дубли отсекает мост (eve `update_id` не
  проверяет); внутри чата обновления уходят в eve по очереди, но порядок
  обработки не гарантирован: голосовое или фото eve разбирает после ответа, и
  следующий текст может его обогнать. Мост и вебхук несовместимы
  (`getUpdates` при вебхуке — `409`): переключение —
  `tg-bridge.sh switch-to-bridge`, откат —
  `tg-bridge.sh switch-to-webhook <url>` через `host.py ops`, а без VM —
  `setWebhook` с любой машины (README моста).

Готово: на VM с мостом сообщение и кнопка карточки доходят до Бро, ответ
приходит; рестарт моста не теряет сообщений и почти не дублирует (один дубль
— только при падении ровно между `200` от eve и записью файла состояния),
рестарт eve не теряет то, что eve ещё не принял (принятое за миг до рестарта
— на совести eve, как и с вебхуком, поэтому deployd перед рестартом eve
останавливает мост); упавший или застрявший мост виден watchdog (что для
этого делает сервер — README моста, «Что делает сервер»).

## Параллельно: Instinct-подобные улучшения

- **Субагенты.** Сейчас один `task` с песочницей. Дальше: исследователь
  (много страниц, только чтение), «браузерный» task-агент, которому главный
  отдаёт поручение целиком, и ежедневный воркер памяти (роадмап 31) — тот же
  механизм eve, без своей очереди.
- **CLI вместо схем.** Новые инструменты без личных данных — сначала в
  маршрутизатор песочницы (`agent/lib/sandbox/router.ts`), а не в схемы
  главного агента.
- **Браузер дешевле и быстрее.** Сейчас ≈18 ₽ за поручение (≈60 шагов ×
  ≈30 тыс. токенов почти без кэша). Порядок: настройки browser-use (flash,
  урезанная история, несколько действий за шаг, правила в системном
  промпте ради кэша) → повтор удачных путей по сайтам без модели (как кэш
  Stagehand v3) → решение одним вызовом «операция + элемент» (идея Jev и
  OpenAI Decisions API). Jev сегодня не видит shadow DOM, фреймы и картинки
  и обучен на английском; Decisions API в ограниченном превью, без цены, и
  из РФ им пользоваться нельзя по условиям OpenAI — ждать его не нужно,
  слой решения делаем заменяемым.
