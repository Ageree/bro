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

### 2. Хранилище: Blob → Object Storage

- Картинки и снимки экрана (`agent/lib/image-artifact/storage.ts`,
  `app/artifacts/[artifactId]`), вложения Gmail и Диска (`agent/tools/gmail.ts`,
  `drive.ts`) — в `bucket-ac164a`; клиент S3 уже есть
  (`agent/lib/browser-pool/s3.ts`), выдача — подписанной ссылкой, как
  `sandbox-files`.
- Файловая память eve (`agent/memory/profile.ts`, `vercelBlob`) — свой
  бэкенд памяти на S3; «автоматический» бэкенд вне Vercel бросает.
- Ключи `BETTER_AUTH_SECRET` и `SECRET_ENCRYPTION_KEY` в env `bro-next` не
  заданы (проверено 01.10): они лежат в Blob
  (`db/services/installation-secrets.ts`). До ухода их надо достать из Blob и
  задать явно в env нового сервера — без них не расшифровать сейф и не
  проверить ни одну сессию входа.
- Песочница главного агента (вложения человека, `eve-sandbox:`) — на бэкенд
  `bro-cloudru`. Старые сессии ссылаются на файлы Vercel Sandbox: смена имени
  бэкенда заводит новую песочницу, поэтому вложения старых сессий надо
  перенести или принять их потерю (решение владельца).

Готово: в коде нет `@vercel/blob`; новые картинки и вложения открываются из
S3.

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

Окно переноса (вместе с этапом 6):

1. Расписания Vercel выключить. Neon — только чтение для приложения:
   `ALTER DATABASE neondb SET default_transaction_read_only = on` и
   `pg_terminate_backend` прочих соединений роли (Vercel переподключится
   уже в режиме чтения; запись у Бро на Vercel падает, чтение работает).
2. `host.py env bro-app-1 --profile prod --with-neon` (адрес Neon — только в
   `/etc/bro/ops-env` для ops-скриптов, не в env приложения), затем
   `host.py stop bro-app-1 bro-eve bro-web`.
3. `host.py ops bro-app-1 db-copy.sh neon app --replace`.
4. `host.py restart bro-app-1`, проверки, DNS `brobro.tech` на VM (этап 6).
   `NEON_DATABASE_URL` остаётся в `/etc/bro/ops-env` на неделю наблюдения —
   для отката; после недели — `host.py env bro-app-1 --profile prod` без
   `--with-neon`, это его убирает.

Откат базы:

- **До первой записи в Cloud.ru** (DNS ещё не переключали или переключили и
  сразу вернули): DNS назад, в Neon `ALTER DATABASE neondb RESET
default_transaction_read_only` и `pg_terminate_backend` соединений Vercel,
  расписания Vercel включить. Neon всё это время не менялся.
- **После записей в Cloud.ru** — обратный перенос в новое окно только для
  чтения. Neon с момента переноса стоит только на чтение, поэтому в нём нечего
  беречь, и вместо дампа «новых строк» переносится база целиком: так
  приезжают и изменения, и удаления, и проверка та же. По шагам: `host.py stop
bro-app-1 bro-eve bro-web` (запись в Cloud.ru кончилась) → `host.py ops
bro-app-1 db-copy.sh app neon --replace` (пишет сквозь `read_only` Neon и
  только пока он `read_only`, только с VM прода и без чужих сессий в Neon:
  открытая до `read_only` пишет — сначала `pg_terminate_backend`; перед этим
  кладёт зашифрованные копии `app` и самого Neon в Object Storage) → в Neon
  `RESET default_transaction_read_only` и `pg_terminate_backend` → DNS назад,
  расписания Vercel включить. Записи Cloud.ru после `stop` не теряются: их
  нет. VM с базой не удалять, пока Vercel не проработал неделю.
- Логическая репликация Cloud.ru → Neon не используется: у `bro_app` нет
  права `REPLICATION` (роли кластера — `pg_monitor`, `pg_read_all_data`,
  `pg_write_all_data`, `pg_signal_backend`), а `wal_level` Neon — `replica`;
  не проверена — не полагаться.

Готово: бэкап за прошлую ночь восстанавливается проверкой, перенос с
Neon сошёлся по всем таблицам, откат отрепетирован на `bro_stand`.

### 6. Переключение

DNS `brobro.tech` на Cloud.ru; вебхуки Telegram, Photon, YooKassa и
возвраты Composio остаются на том же домене. Откат — DNS обратно. После
недели без отката — убрать `vercel.json`, Gateway-строки моделей и
зависимость `vercel`.

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
