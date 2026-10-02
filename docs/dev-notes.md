# Заметки для агентских сессий

Общая память агентов, которые пишут код в этом репозитории. Облачная сессия
стартует со свежего клона и ничего не помнит о прошлых сессиях, кроме того, что
закоммичено. `CLAUDE.md` подключает этот файл, поэтому он попадает в контекст
каждой сессии Claude Code.

Как вести:

- Пишите то, что следующая сессия иначе узнает на собственных ошибках:
  неочевидную причину сбоя, ограничение eve, Vercel или CI, принятое решение и
  его причину.
- Одна запись — пара строк: факт, почему так, где смотреть (путь к файлу или
  коммит). Подробный механизм — в комментарии кода, здесь — правило и путь.
- Правьте или удаляйте записи, которые перестали быть верными.
- Не пересказывайте историю задач и то, что и так видно из кода или `AGENTS.md`.
- Никаких секретов, токенов, внутренних адресов и личных данных пользователей.
- Держите файл коротким (ориентир — до 150 строк): он загружается целиком в
  каждую сессию.

## С чего начать

- Бэклог с приоритетами и критериями «готово» — `docs/roadmap.md` (сделанное
  вычёркивайте там же в своём PR); как гонять бенчмарки и их итоги —
  `docs/benchmarks/README.md`; промпт сессии, которая запускает исполнителей и
  мёрджит их PR, — `docs/orchestrator-prompt.md`.
- Куда уходят деньги и что снижать — `docs/agent-costs.md`; пул браузеров в
  песочницах на общих хостах Cloud.ru (`runc`, gVisor — запасной) —
  `docs/browser-pool.md`; заметки по браузерной инфраструктуре (Cloud.ru, VM,
  хосты пула, worker) — `docs/browser-infra-notes.md`.
- Сравнение с Instinct и что из него взято в бэклог (пункты 24–33 роадмапа) —
  `docs/instinct.md`; план переезда с Vercel на Cloud.ru по этапам —
  `docs/cloudru-migration.md`, промпт сессии, которая доводит его до конца, —
  `docs/cloudru-full-migration-prompt.md`; песочница для кода и task-агент —
  `sandbox/README.md`.

## Процесс

- Основная ветка — `bro-next`, PR — в неё; CI — `.github/workflows/checks.yml`.
  Коммиты и заголовки PR — по-русски, с точки зрения пользователя.
- Ревьюит только cubic и только PR не в черновике; на merge-коммит в голове PR
  он ставит зелёную проверку без ревью — кладите сверху обычный коммит.
- В свежей облачной сессии нет `node_modules` (`pnpm install`), а Node 22 валит
  ~12 наборов `pnpm check` («Unexpected identifier 'r'»). Node 24 без root:
  `npm pack node-linux-x64@24` в scratchpad, `bin` — в начало `PATH`.
- `pnpm build` без `.env.local` падает на сборе данных страниц: хватает заглушек
  `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`. knip в `pnpm check`:
  новый каталог точек входа (как `agent/instrumentation/`) — в `knip.config.ts`.
- Формат проверяет `oxfmt` (`pnpm format:check`), не Prettier: `npx prettier`
  переформатирует TypeScript иначе, и CI падает. Чините `pnpm exec oxfmt <файлы>`.
- Перед последовательным `pnpm check --concurrency=1` запустите
  `pnpm types:generate`: иначе type-aware lint не видит сгенерированные
  `PageProps` и ложно сообщает об unsafe-типах.
- PGlite-тест с `vi.resetModules()` должен в каждом кейсе заново импортировать
  `@db` и подменять `db`, иначе висит на `pg.Pool`
  (`db/tests/proactive.test.ts`). Наружу тесты не пускает `tests/setup-env.ts`.
  Так же виснет `vi.mock` с `importOriginal` модуля, тянущего `@db`: сбой
  записи в таком тесте делайте триггером PGlite (`failVmUptimeWrites` в
  `tests/agent/browser-pool/sandbox.test.ts`).
- Превью делят базу с продом, поэтому сборка зовёт `db:migrate:deploy` (на
  превью пустой): миграции неслитых PR ложились в прод, и drizzle пропускал
  более ранние `when`. Миграцию PR перед слиянием генерируйте поверх bro-next.
- `drizzle-kit migrate` применяет пачку миграций одной транзакцией: `NOT VALID`
  у CHECK блокировку таблицы не укорачивает.
- `pnpm build:eve` без заглушек `DATABASE_URL`/`BETTER_AUTH_*` падает
  на «Invalid environment variables», как `pnpm build`.
- knip не видит использование модуля в тесте, если его динамический `import()`
  разобран из `Promise.all([...])`: экспорт, нужный только тестам, импортируйте
  отдельным `await import(...)`.
- Промис, который вернул шпион `vi.fn`, vitest обрабатывает сам: отказ
  `mockRejectedValue` не станет unhandled. Пропущенный `.catch` ловит только
  простая функция вместо шпиона (`db/tests/health.test.ts`).

## eve

- eve закреплён на `0.62.0` с `patches/eve@0.62.0.patch`; обновление —
  перевыпуск патча (`patches/README.md`). `pnpm build` собирает только Next.js,
  агента и durable-замыкания проверяет только `pnpm build:eve`.
- Колбэки динамических инструментов — инлайн в `defineTool()` или ссылкой на
  идентификатор: `approval: policy("x")` теряет durable-дескриптор и падает в
  рантайме (юнит-тесты не видят), нужно `approval: (ctx) => policy(ctx, "x")`.
  Проверка — `transformDynamicToolExecute`
  (`eve/dist/src/internal/workflow-bundle/dynamic-tool-transform.js`).
- Инструмент не видит историю: нужное из неё (фото, слова человека, отказы)
  резолвер `turn.started`/`step.started` кладёт в замыкание. Замыкание — только
  JSON, а вложения в истории — `URL` `eve-sandbox:`: храните ссылки.
- Каналы без `turnPolicy` работают как `"steer"`: сообщение, пришедшее до
  начала ответа, перехватывает текущий ход; `"queue"` — только ходы-отчёты
  браузера (`completion.ts`) и расписания (`agent/lib/schedules/report.ts`). `defaultTools: false` выключает и готовую
  песочницу eve (`bash`, `read_file`, `write_file`), хотя `ctx.getSandbox()`
  работает (`node_modules/eve/docs/sandbox.mdx`).
- Владелец 01.10: Бро переезжает с Vercel на Cloud.ru — новое не завязывайте
  на Vercel (Sandbox, Blob, Workflow, Gateway). Свой сервер —
  `scripts/cloudru-app-host/README.md`: сборка для VM включается только
  `WORKFLOW_WORLD=postgres` (`pnpm build:eve`) и `NEXT_OUTPUT=standalone`
  (`next build`), без них сборка Vercel прежняя — не делайте эти режимы
  поведением по умолчанию, пока Vercel — путь отката.
- `next start` сам eve не поднимает (запуск зашит в `rewrites()`, их Next 16
  вызывает только при сборке): eve — свой процесс `node .output/server/index.mjs`,
  не `eve start` (обёртка копит весь вывод ребёнка в памяти).
  `/.well-known/workflow/*` наружу не публикуйте: вход очереди мира без
  авторизации. Без схемы мир Postgres падает на старте: до запуска —
  `ops/migrate.mjs world`; две среды на одной базе мира исполняют чужие ходы.
- Стенду VM не ставьте `TEST=1`, чтобы выключить расписания: его читает и
  Better Auth (`isTest()`) и снимает проверку Origin. Расписания глушит
  `EVE_SCHEDULES=off` (`agent/lib/schedules/enabled.ts`).
- Managed PostgreSQL Cloud.ru отвечает только по внутреннему адресу подсети
  VM: всё с базой — ops-скрипты на VM (`db-*.sh`), из сессии и Vercel её не
  видно. API по умолчанию создаёт базы с локалью `C`, где `ILIKE` не знает
  регистра кириллицы (поиск памяти): только `C.UTF-8` (`host.py pg databases`).
- В `psql -c` переменные `:'x'` не подставляются — SQL с ними подавайте на
  stdin. `pg_dump` падает на чужой таблице без прав: `db-lib.sh` исключает
  таблицы других ролей, но бэкап и перенос тогда валятся, пока таблицы нет в
  `ALLOW_FOREIGN_TABLES`: сверка строк смотрит те же таблицы и пропуска не
  видит. Ошибки psql в ops-скриптах — `VERBOSITY=terse`: `DETAIL`/`CONTEXT`
  сбойного COPY печатают строку с данными людей в лог job и journald.
- Ключ S3 приложения лежит в `/etc/bro/env`, то есть у инструментов модели:
  бэкапу верят только по HMAC манифеста (ключ из `BACKUP_ENCRYPTION_KEY`), а
  `NEON_DATABASE_URL` живёт в `/etc/bro/ops-env` deployd, не в env приложения.
- esbuild тянет в бандл с graphile-worker весь `typescript` (9 МБ, через
  `graphile-config`): `--external:typescript`. В облачной сессии нет `zstd`
  для `tar -I zstd`: `apt-get install -y zstd`.
- Хунки патча:
  - `durableMemoryToolsContext`: с фото в истории инструменты памяти пропадали;
    хунк опустошает `messages` в их замыкании, так что `tools()` провайдера
    историю не читает (`tests/agent/memory-tools-attachments.test.ts`).
  - `insertBeforeApprovalTail`: AI SDK выполняет одобренный вызов, только если
    последнее сообщение — `tool-approval-response`; ничего не добавляйте после
    него (`tests/agent/approval-memory-recall.test.ts`).
  - Перепривязка колбэков в новом процессе: 0.62 бросал «rebind did not
    restore», и сессия умирала (`tests/agent/dynamic-tool-rebind.test.ts`);
    резолверы `turn.started` поэтому должны быть идемпотентны.
  - `attachSession` в хендлере расписания; `harness/emission.js` — ошибка
    повтора одобренного вызова в `action.result`.
- Песочница task-агента — свой бэкенд eve `bro-cloudru`
  (`agent/lib/sandbox/backend.ts`): eve зовёт `prewarm` бэкенда при сборке,
  поэтому фабрика не бросает без `SANDBOX_*`, проверка — в `create`. Модель
  субагента должна резолвиться на `step.started` (хэндл OpenRouter не
  сериализуется), а динамический субагент eve требует статичную модель —
  поэтому `task` скрыт через `withheldTools` везде, кроме пилота
  `SANDBOX_WORKSPACES` (`agent/agent.ts`, тесты ждут `"task"` в списке).
- Итог фоновой задачи eve приносит родителю отдельным ходом: сообщение
  `[Task state]` с выводом задачи и указание «одним ответом человеку»
  (`eve/dist/src/tasks/delivery-context.js`).
- gVisor работает и в облачной сессии (root, cgroup v1): `sandboxd` гоняют на
  настоящем `runsc` — `SANDBOXD_REAL_ROOTFS=<корень> go test ./...` в
  `sandbox/sandboxd`. Прямой URL релиза runsc отвечает 404 — ставить `.deb`
  из apt-репозитория gVisor со сверкой подписи и sha256.
- Хост песочниц для кода — VM Cloud.ru (`scripts/cloudru-code-host/`,
  только VM `sbx-*`); runsc едет на хост объектом S3 (`boot.py vendor`), не
  из apt Google. gVisor не держит свой лимит памяти: память гостя лежит в
  cgroup, но не в RSS процессов, и OOM убивал весь `gvisor_sentry`. Поэтому
  `sandboxd` даёт cgroup запас и ставит заглушкам `oom_score_adj=1000`
  (`sandbox/sandboxd/memory.go`): умирает один процесс, код 137.
- `app/` не импортирует `agent/` (правило `no-forbidden-layer-imports`):
  HTTP-ручки агента — маршруты каналов под `/eve/v1/` (`agent/channels/sandbox.ts`).
- `POST /eve/v1/session` отвечает `202` раньше `session.started`: владельца
  пишет обёртка маршрута (`agent/channels/eve.ts`), иначе ранний поток — 403.
- `first-contact` решает `workspaces.introduced_at`
  (`claimWorkspaceIntroduction`), а не `chats`: переезд из Convex их не пишет.
- Любой сбой модели (и переполнение контекста) — `turn.failed`
  `MODEL_CALL_FAILED`; «скоро вернусь» — только при 402/429/5xx в `details`.
- `eve info` 0.62 не печатает подключения: их видно в
  `.eve/compile/compiled-agent-manifest.json`.
- Эвалы в облаке без Gateway и Docker: `OPENROUTER_API_KEY`, Postgres от не-root
  (`setpriv --reuid=postgres`, данные вне `/tmp/claude-0`), `pnpm db:migrate` и
  `eve eval agent --tag <тег>` с `DATABASE_URL`,
  `BETTER_AUTH_URL=http://127.0.0.1:9`, `NODE_ENV=development`.
  `agent` здесь — префикс путей: `eve eval agent <id>` гоняет весь набор.
  `eve dev` при старте продолжает незаконченные ходы из `.eve/.workflow-data`
  (и платит за них): прерванный прогон перед следующим уберите оттуда.

## Composio: Google, Notion, Slack и другие приложения

- Гранты живут в Composio, «токен» инструмента — id аккаунта (`ca_…`). Вход —
  карточка с Connect Link (`agent/lib/composio/authorization.ts`), засчитывается
  лишь аккаунт этой ссылки. Без `COMPOSIO_API_KEY` интеграций нет.
- Google — `googlesuper`: управляемое приложение одобрено лишь на широкие скоупы
  (узкие `*.readonly` Google блокирует), поэтому read-only-конфиг просит те же,
  а запись режет политика. Отзыв снимает грант всего OAuth-клиента, общего для
  уровней: уборка после нового входа только удаляет (`pruneConnectedAccounts`).
- Прокси: абсолютный URL на домене тулкита (иначе 400), повторы параметров — в
  query; ответ всегда HTTP 200, статус — в `status`/`data`. Ответы
  `GET /connected_accounts` несут данные подключения: целиком не печатайте.
- `apps` — белый список, политика закрыта: без карточки — лишь `readOnlyHint` с
  глаголом чтения в slug; карточка — до 3 500 знаков (Telegram режет на 4 000).
- Карточка входа паркует весь ход, поэтому Slack, Notion и `apps` ставят её,
  только если человек назвал приложение в этом ходе (`appsNamedByPerson`).
- Третьему лицу Бро пишет только письмом и в Slack; `contacts-search` отдаёт
  `canMessageVia`, иначе Бро предлагал «SMS или Telegram?».

## Ход и доставка

- В eve нет `toolChoice`: `send_message` форсирует резолвер модели на
  `step.started` (`agent/agent.ts`, `agent/lib/model/direct.ts`), пока
  сообщение человека без ответа (`agent/lib/delivery/pending.ts`). Не
  форсируются шаги после десятого, `anthropic/*` с reasoning (отвергает), ход
  `browser-result` после первого шага, шаг после упавшего `send_message` и
  строковый id Gateway (в `eve dev` eve авторизует Gateway только для строк).
- Модели повторяют `send_message`, перефразируя: `replyDirective` после доставки
  читался как новая просьба. Правила — в `agent/lib/delivery/`: повтор без
  нового — `stale`, затем `toolChoice: none` (`turn-sends.ts`, `novelty.ts`),
  претензии без дела — на переписывание (`claims.ts`).
- Одобренный на карточке вызов AI SDK выполняет после `step.started`:
  `send_message` шага его не видит, а вызов мог упасть (`approvedPending`).
- В ходе-отчёте браузера до сообщения с итогом нет инструментов с карточкой
  (`browser-report.ts`): карточка парковала ход до засчёта отчёта.
- До ответа на «остановить или оставить?» разрушающие инструменты убраны
  (`turnAwaitsAnswer`): модель спрашивала и через 3 с удаляла.
- Правило, которое слабая модель не держит из промпта, повторяйте в результате
  инструмента: «три варианта» (`pick` в `agent/tools/route_time.ts`), «билеты
  ищет браузер» (`ticketSearch` в `agent/tools/web_search.ts`), «сузь Google»
  (`agent/lib/privacy/google-access.ts`).
- Язык, род Бро и обращение держит пометка `replyDirective` в конце промпта
  каждого шага (`agent/lib/delivery/language.ts`; обращение — `settings`
  `form_of_address`), а не промпт или память; отправки по языку не фильтруйте
  (ломались переводы). Модели Gateway пометка не доходит: обращение ей
  дописывают инструкции (`30-message-style.ts`), язык так не передать —
  резолверы инструкций 0.62 не видят входящего сообщения.
- Промпт, который Бро пишет сам себе, начинается с `backgroundTurnMarker`
  (`shared/chat/background-turn.ts`): веб его прячет, язык по нему не берётся.

## OpenRouter и RouterAI

- Прямой провайдер выбирает `MODEL_PROVIDER` (`shared/model/provider.ts`), без
  него — OpenRouter по ключу, иначе Gateway. RouterAI — тот же API OpenRouter
  (провайдер AI SDK тот же, другой `baseURL`, `agent/lib/model/endpoint.ts`).
- RouterAI: `deepseek/*` без `provider.ignore: ["deepseek"]` висит на
  официальной точке DeepSeek (ответ через 900 с), поэтому `ignore` — в коде
  (`direct.ts`), не только в env. Кэш и цена зависят от хоста (до 15 раз):
  первым закреплён `deepinfra` (`routerAiDeepSeekOrder`): кэширует весь
  префикс, повторный шаг вдвое дешевле `sail-research`. Тот тоже кэширует, но
  01.10 рвал ответ за ответом (как 24.09) — остаётся в `brokenHosts`; хосты в
  `order` эти списки не пропускают. `sail-research` к тому же нумерует вызовы
  шага с `call_0`, и читатели хода по `toolCallId` путали вызовы — id
  перевыдаёт `uniqueToolCallIdsMiddleware`.
- RouterAI не переводит вызов на следующий хост `order`, если ответ уже пошёл:
  сбой приходит в конце (`finish_reason: "error"` или «Upstream error from
  …»), а повтор шага eve шёл на тот же хост, и ход висел до таймаута.
  `agent/lib/model/routerai/` читает ответ целиком, упавший закреплённый хост
  переносит в `ignore` на 10 минут (`hosts.ts`) и сразу повторяет вызов.
  Поиск (`agent/lib/web-search/search.ts`) идёт тем же fetch и маршрутом.
- RouterAI: ошибки приходят и HTTP 200 `{"error":"<JSON строкой>"}`, и кадром
  SSE `data:{"error":…}`; без `routerai/fetch.ts` провайдер AI SDK принимал их
  за пустой ответ, и «скоро вернусь» не видел 402/429/5xx.
- RouterAI: `usage.cost` и `/credits` — в рублях. eve 0.62 берёт цену шага лишь
  из `gateway.cost`, туда кладётся рубли ÷ `USAGE_USD_RUB` (`direct.ts`); в
  `usage_costs` такой шаг — рубли без `cost_usd` (`agent/hooks/usage-costs.ts`);
  шаги OpenRouter пишутся без цены.
- Модель по умолчанию — `deepseek/deepseek-v4.1-flash`
  (`shared/environment/env.ts`); в Vercel она не задана, кабинет её не меняет.
  Подсказки id в кабинете — свои у каждого провайдера (`model-selector.tsx`):
  в `/models` RouterAI есть не все id OpenRouter.
- Хосты DeepSeek в `provider.ignore` (`agent/lib/model/direct.ts`):
  `brokenHosts` (при `required` шлют `{}` или ломают вызов) и `keyOrderedHosts`;
  ветку union часть хостов выбирает по первому ключу (`discriminatorsFirst`).
  После правки гоняйте эвалы `schedules` и `reply`.
- Форсированный вызов часть хостов декодирует грамматикой по порядку схемы: у
  `send_message` порядок ключей модели (`kind`, `replyTo`, `text`), в
  форсированном шаге `text` обязателен, корню `oneOf` дописан `type: object`.
- OpenAI (и Azure) отвергает весь запрос, если `pattern` в схеме не его диалект
  (`\p{Cc}`, `(?<x>…)`): в схемах — простые регулярки, остальное в `.refine()`.
- zod 4 гоняет `.refine()` и после проваленного `z.url()`: в нём `new URL(x)`
  бросает — только `URL.parse(x)` (`shared/chat/message-delivery.ts`).
- `eve build` хранит схему статического инструмента как JSON Schema, и
  `.refine()` теряется; символ поведения `ask_question` spread теряет
  (`agent/tools/ask_question.ts`).
- `watchedModelFetch` (`agent/lib/model/stream-watchdog.ts`): тишина 90 с — один
  повтор до первого `data:`, нет `data:` 240 с (480 с с reasoning) — сбой;
  комментарии (`: OPENROUTER PROCESSING`, у RouterAI `: PROCESSING`) — жизнь,
  в них идёт рассуждение.
- Мини-классификатор сохранённых правил с JSON-ответом и лимитом 96 токенов
  не должен наследовать reasoning основного агента: он съедает тот же бюджет и
  может оставить ответ пустым. Явный `reasoning.enabled=false` только в его
  прямом вызове (`agent/lib/memory/rule-approval.ts`) сохраняет fail-closed
  проверку правил, а не обходит её.
- Слабые модели заполняют каждый необязательный параметр: пустое и `*` там —
  пропуск (`givenScope`). gpt-6-luna после доставки отвечает пустым шагом, и eve
  валит ход — `quietEndMiddleware` меняет его на `<eve-empty-delivery/>`.
- Шаблон чата DeepSeek склеивает все системные сообщения в начало промпта:
  «последнее» системное (пометка шага) стоит перед историей и рвёт кэш.
  Состав шага меряет `scripts/costs/step-context.ts` (`docs/agent-costs.md`, 3.2).
  За флагом `STEP_CONTEXT_WORKSPACES` (с 01.10 — пилот) время и записки идут после истории
  тегом `<bro-step-note>` (`agent/lib/step-context/`), а его подобия в
  остальном промпте обезвреживаются (`defuseStepNoteTag`); новые опции
  `modelSelection` добавляйте только под флагом — тесты `agent.test.ts`
  сверяют опции целиком.
- `GET /api/v1/credits` — только management-ключ (`OPENROUTER_MANAGEMENT_KEY`).
  Плагин `web` без `engine` у `openai/*` медленный и без ссылок: берём `exa`.
- `web_fetch` помнит отказ хоста лишь в разговоре: память инстанса закрывала
  сайт всем. Ограничитель Nominatim и OSRM — на инстанс, общего нет
  (`agent/lib/routes/openstreetmap.ts`).

## Vercel

- Стек ошибки прода — в runtime-логах `bro-next` по тексту (в `turn.failed` —
  только код).
- Маршруты каналов eve вне `/eve/v1/` в Build Output не публикуйте: Workflow
  переставал вызывать `/.well-known/workflow/v1/flow` (откат `bb5b1a0`). В проде
  до eve доходит только `/eve/v1/*`; у V4-запусков Browser Use вебхуков нет.
- Nitro отдаёт тику cron, заставшему задачу за работой, её же промис: зависший
  вызов хоронил все тики, поэтому каждое ожидание тика `browser-runs` ограничено
  (`agent/lib/browser-use/deadline.ts`), кроме стартов: нет идемпотентности.
  Ошибку фоновой работы расписания eve глотает: ловите сами.
- Ключи окружения приходили с переводами строк и в типографских кавычках:
  чистит `clean()` в `vm.py` и `build.py`. `VERCEL_TOKEN` облачной сессии
  30.09 тоже пришёл с переводом строки внутри: убирайте пробелы перед вызовом.
- Env Vercel действует лишь со следующего деплоя. `BETTER_AUTH_SECRET` и
  `SECRET_ENCRYPTION_KEY` в env `bro-next` нет: они в Blob
  (`db/services/installation-secrets.ts`) — перед уходом с Vercel достать.

## Браузерные поручения

План перехода — `docs/browser-cloud-migration.md` (итоги проверок — раздел
12): свой браузер на VM Cloud.ru по запросу с постоянным профилем, общий Бро не
копируем в VM. Человеку браузер не показываем: коды и согласия — только в чате.
Сторона VM — `browser-vm/` (worker, образ), пилотный стенд — `scripts/cloudru-browser-pilot/`.

- Инфраструктура браузера — в `docs/browser-infra-notes.md`: работаешь с
  `browser-vm/`, `agent/lib/browser-vm/`, `agent/lib/browser-pool/`, Cloud.ru
  или стендом — сначала прочитай его. Там же ключи и квоты Cloud.ru, выход VM
  в сеть, выкат worker, env пула и `BROWSER_STATE_KEY` (не менять никогда).
- Пул браузеров включён только пилоту владельца (`BROWSER_POOL_WORKSPACES`,
  прод, с 01.10), остальные поручения идут прежним путём (Browser Use). Зона
  Cloud.ru — `ru.AZ-1` (`CLOUDRU_ZONE`): `ru.AZ-3` выключена 30.09.

Файлы без пути — в `agent/lib/browser-use/`.

- `cdp.ts` вводит код как `enter_code` worker: обходит открытые shadow root и
  вставляет весь код одним `Input.insertText`; ошибка CDP-команды теперь
  отвергает вызов, а не даёт пустой ответ.
- Текст поручения — `composeBrowserTask` (`agent/tools/browser_task.ts`), тесты
  по дословным фразам; эвалов нет: каждый кейс — платный прогон.
- Правила Бро — в тексте задачи: из системного сообщения browser-use модель
  теряла подвал `RESULT…NEEDS`. Адрес в задаче — один Site: его browser-use
  открывает сам, без шага модели (`docs/agent-costs.md`, 3.3).
- DeepSeek на RouterAI по умолчанию думает: в JSON шага тогда течёт
  `｜｜DSML｜｜`, шаг пропадает, а вызов оплачен. Бро выключает это
  (`runTuning` в `agent/lib/browser-vm/runs.ts`, `tuning` worker).
- «accepted» от `attachSession(...).send` — не доставка: итог доставлен, когда
  ход-отчёт отправил сообщение, вызвал `browser_task` или закончился
  (`agent/hooks/browser-run-report.ts`). Аренду итога (10 минут) не
  укорачивайте: каждая передача тратит попытку из трёх.
- Действовать от имени человека запуск может только с `allowSubmit`, а тот —
  только через карточку с `submission`: текстом инструкций не держалось. Без
  него имя, телефон, почта и адреса в поручение не попадают.
- Одно поручение — одна карточка: `submission.chargeRub` разрешает и оплату до
  суммы +10%; подтверждение живёт, пока разрешённое не сделано
  (`errandStillAllowed`). Карточка и `execute` решают одной `consentFor`.
- Постоянные разрешения и наследование подтверждения — только в ходе человека
  (`startedByPerson` в `agent/lib/mode.ts`): текст хода `browser-result` пишет
  страница. В фоне `allowSubmit`/`allowPayment` — отказ без карточки.
- Код и согласие уходят в запуск только из слов человека (`said.ts`): ход-отчёт
  сам продолжал запуск с выдуманным кодом. Чей ход, решает открывшее его
  сообщение, а не auth. Исключение — код из письма сайта (`mail-code.ts`).
- Телефон для входа — секрет Browser Use на домене `site`, не текст: текст видят
  все страницы. Российский номер привязан и 10 цифрами (поля с маской «+7»),
  кроме Госуслуг: там одно поле на телефон, почту и СНИЛС.
- Логин Госуслуг вводится только на gosuslugi.ru и дан лишь госсайтам из
  закрытого списка (`public-services.ts`): вход отдаёт сайту профиль человека.
- Статуса «ждёт ввода» у Browser Use нет: правило «сразу кончай с
  `NEEDS: sms_code`» стоит сразу после текста поручения и главнее бюджета
  (`personStepLine`), иначе запуск ждал код весь бюджет.
- Метки итога (`ITEMS:`, `BOOKING:`, `NEXT:`…) — `outcome.ts`; промпт расписания
  по `NEXT:` — из просьбы человека, не со страницы. Заказ пишется лишь у
  запуска, который мог действовать (`couldHaveActed`).
- Антибот-стену и сетевой сбой поллер повторяет (`captcha-retry.ts`), но запуск,
  который мог действовать, на сетевой ошибке — никогда: мог нажать «Заказать».
  На VM повтор идёт в сессии прошлой попытки через новый выход: Avito закрывал
  каждый адрес минут через десять, и попытка с нуля не успевала дальше выдачи.
- У Browser Use нет идемпотентности, POST не повторяется: повтор несёт id
  поручения и номер попытки, захват находит начатый запуск в `GET /runs`.
- Куки ложатся в профиль только при чистой остановке (`PATCH /browsers/{id}`
  `stop`): погашенный облаком браузер теряет вход, поэтому ждущие страницы гасит
  поллер через 15 минут простоя (`release.ts`). Браузеры сессии — только
  `GET /browsers?agentSessionId=…&filterBy=active`.
- Профиль один на воркспейс, а два поручения на один аккаунт не идут разом
  (`sign-ins.ts`): коды параллельных входов гасили друг друга.
- Входы (`SIGNED_IN:`) продлевает расписание `browser-sign-ins`, кроме Госуслуг:
  ЕСИА на новом адресе спрашивает код всегда.
- На 429 (мало сессий) поручение встаёт в очередь (`queue.ts`), на 402 — алерт
  владельцу (`agent/lib/owner-alert.ts`).
- eve подписывает карточку лишь «Approve tool call: …»: текст собирает
  `shared/chat/approval-card.ts`. В iMessage eve примет ответ текстом, только
  равный id, английской метке или номеру (`channel/resolve-text.js`).

## Лимит трат без спроса

- Политика — `settings` (`spend_limit`), траты — `spend_entries`. Решения — под
  `pg_advisory_xact_lock`; на `neon-http` транзакций нет, резерв там отказывает.
- Страницу видит только облачный агент: потолок — текст поручения
  (`spendCapLine`), не замок; трата — по сообщённому (`reportedCharge`).
- Постоянные разрешения — поле `actions` той же политики: новый ключ `settings`
  требует миграции CHECK. Расширение решает `policyWidens`
  (`shared/spending/limit.ts`) той же проверкой покрытия, что и платёж.

## Учёт расходов

- `usage.total_cost` старого worker — цена browser-use по его долларовому
  прайсу (LiteLLM), а не рубли RouterAI. С 2026-10-01.1 worker отдаёт
  `usage.billed` — счёт RouterAI за все вызовы, и за те, чей ответ browser-use
  не разобрал и не посчитал; таблица `shared/costs/prices.ts` — запас для
  старых worker: цена RouterAI 01.10 удвоилась за утро. Worker с 30.09 цену
  не просит (`calculate_cost` тянул прайсы с GitHub и openrouter.ai и вешал
  запуск с Cloud.ru) и `total_cost` не отдаёт. Трафик прокси по запуску
  (`traffic`) отдаёт только обновлённый worker; хуки родителя шаги субагентов
  не видят.

## Google

- Уровень доступа — `settings.google_workspace_access` (нет записи — `full`).
  Запись при чтении или без подключения режет `googleWriteApproval` до карточки:
  иначе одобрение вело ко второй карточке, входу.
- 403 insufficient scopes — тоже старый грант: `withGoogleAuth` зовёт
  `requireAuth`; квота — 429 и 403 `rateLimitExceeded` (`client.ts`).
- Чтения Gmail и Диска считаются за ход (`turn-reads.ts`); параллельные вызовы
  одного шага счёт не видит. Оба файла — в `agent/lib/google-workspace/`.
- Ответ на письмо — по Gmail `id` (`replyToMessageId`), не `rfcMessageId`. Голос
  человека — письма с SENT и From из `sendAs`: плюс-адрес ящика тоже SENT.
- Отказ самой политики ai@7 пишет как одобрение с `isAutomatic: true`: это не
  отклонённая карточка (`agent/lib/delivery/declined-cards.ts`).
- В Календарь — только IANA-зоны (`+05:00` — 400 после карточки). Drive не
  сортирует `fullText contains` с `orderBy`: `searchDrive` сортирует сам.
- Новый сервис с данными человека — в `dataProcessors` (`agent/lib/privacy/`).

## Расписания и проактивные сообщения

- Веб-чат достижим только через `attachSession(sessionId)`: им шлют отчёты
  (`agent/schedules/browser-runs.ts`, `dynamic.ts`) и ответ воркеру. У канала
  `scheduled-run` — заглушка с 410: без маршрутов 0.62 его не соберёт.
- Расписание принадлежит человеку. Отчёт — в последний мессенджер (у веба нет
  пушей), в веб — только если там заведено и мессенджера нет
  (`reportConversations` в `db/services/scheduled-agent-jobs.ts`).
- Правка расписания берёт недостающее из расписания, не из профиля
  (`shared/schedules/timing.ts`). Праздники — только постановление № 1466 на
  2026 год: следующее допишите (`shared/schedules/holidays.ts`).
- `schedules-answer` принимает лишь run id, чей вопрос доставлен в этот чат
  после прошлого сообщения человека (`answerableScheduledQuestions`).
- `eve dev` не запускает расписания по cron: `POST /eve/v1/dev/schedules/<имя>`.
  Через `next dev` этому POST нужна локальная сессионная cookie: без неё
  middleware ведёт на `/sign-in`, а клиент с авто-редиректом видит HTML с 200
  вместо dispatch. V4 Browser Use не присылает вебхук, так что локальный
  `browser-runs` без этого тика не доставит законченный отчёт в чат.
- `next_check_at` захваченной проактивной проверки — её аренда: отсрочка
  проходит, лишь пока аренда и `google_state` те же (`deferProactiveWatch`).
- Воркер с сессией без начатого хода сторож ждёт ещё 20 минут: Workflow держит
  ход в очереди (`recoverStuckScheduledAgentRuns`).
- Метка `<eve-empty-delivery/>` где угодно или «передавать нечего» в конце —
  `nothing_to_report` (`agent/lib/schedules/outcome.ts`).
- У воркера и хода-отчёта нет сетевых `web_fetch`/`find_images`/`web_search`:
  письмо не должно увести на чужой адрес (`tests/agent/capabilities.test.ts`).

## Бенчмарк

- В `eve dev` OpenRouter не отдаёт цену шага: рубли локального прогона
  считайте по токенам `usage_costs` и `shared/costs/prices.ts`. Кэш внутри
  хода отстаёт от промпта на 6–14 тыс. и с флагом `STEP_CONTEXT_WORKSPACES`
  (`docs/agent-costs.md`, 3.2): сравнивайте по видам шагов.
- Драйвер `scripts/bench/` держит курсор сам: `eve/client` двигает `streamIndex`
  только по дочитанному ходу, `session.stream()` сдаётся рано.
- `eve dev` без Docker ставит `just-bash`, и pnpm переписывает `pnpm-lock.yaml`
  и `pnpm-workspace.yaml`: откатите и `pnpm install --frozen-lockfile`.
- Локально вход по телефону принимает любой код; Google у локального
  пользователя свой: почту и календарь гоняют на проде.
- Кейсы с входом через Госуслуги (d06, d07 ЕМИАС, d08 mos.ru) гоняйте строго
  по одному: параллельные входы в один аккаунт отменяют коды друг друга
  («Не удалось войти»). Коды Ozon из приложения живут около минуты.
- Не запускайте `bench send` в кейс, за которым ещё следит `bench run`: два
  слушателя ответят на карточку дважды, и второй ответ придёт Бро текстом
  («Cancel»). Проактивные сообщения без мессенджера ложатся в последнюю
  веб-сессию, то есть в чужой кейс прогона.
- Перед прогоном уберите следы прошлых: расписания и обращение на «вы» из
  d09/d15 переживают прогон и меняют следующий (d12 правил старую сводку).
- В эвалах eve инструменты не подменяются, `t.send` открывает новый чат
  (продолжение — `turn.session.send`), `t.judge` без Gateway не оценится.
- Письма заготовок с плюс-адресов ящика владельца (руководитель и друг d11)
  Gmail метит SENT, а фоновая проверка берёт только `in:inbox -from:me`
  (`agent/lib/proactive/probe.ts`): проактивность их не видит.
- Что делала проактивность, видно не в чате: сессии воркеров лежат в «Все
  чаты» как «New chat» с промптом «Proactive check…», исход каждой проверки —
  строка `[proactive] check` в runtime-логах. Простаивающий контейнер
  облачной сессии останавливается вместе с `observe`: утром дочитайте
  `--minutes 0`.

## Память Бро

- Устройство — `docs/memory.md`; пишет только модель в интерактивных ходах.
- Удаление записи из другого разговора — карточка (`memoryRemovalApproval` в
  `agent/lib/memory/profile.ts`): правило по источнику записи, а не «одно
  удаление за ход», — параллельные вызовы шага политика не видит.
- Правила, лимит и разрешения меняет лишь ход человека (`ruleWriteRefusal`).
- В системный промпт профиль не достать: ключ области памяти есть лишь у
  провайдера, а документ профиля eve дописывает в историю лишь при изменении.
