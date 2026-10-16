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

- Телефония — `docs/telephony.md`: провайдеры стоят в `shared/phone`, потому
  что ими пользуются и инструменты агента, и HTTP-обработчики. `PHONE_WORKSPACES`
  принимает id или *; PHONE_AUTO_PROVISION=on ставит новый workspace в очередь
  ровно при создании, без backfill. Выключение флага не освобождает
  платный номер; неоднозначные операции только сверяются, но не повторяются.
- Ход фонового помощника наследует caller человека, а ответ на карточку может
  не содержать нового сообщения: в телефонии одного `startedByPerson` мало.
  Сохраняется точная исходная операция, а фоновое сообщение необратимо помечает
  текущий ход недоверенным (`agent/lib/phone/policy.ts`).
- Отчёт о звонке закрывает ход, а не приём eve: сообщение или `turn.completed`
  (как `browser-run-report.ts`). Сообщение человека, вклинившееся в ход,
  подменяет `auth.current` (`turn-step.js` eve берёт auth последней доставки),
  поэтому ход помнит свой отчёт в состоянии сессии, а token отчёта не
  меняется при повторной выдаче (`agent/lib/phone/report-lease.ts`).
- `phone-call` не проверяет, что номер был в словах человека, и не ограничивает
  число звонков за ход (владелец 09.10): «найди ресторан на картах → позвони»
  должно работать. Охрана — только ход, открытый сообщением человека
  (`phoneActionTurn`); такую проверку не возвращайте без его решения.
- «Не дозвонился: линия не поднялась» без разговора в ElevenLabs (13.10): чтения
  `agents/<id>` и `phone-numbers/<id>` отвечали за 25–40 с при таймауте 20 с, и
  предзвонковые проверки `startCall` падали, не дойдя до POST (`request` глотал
  причину). Теперь они идут параллельно с таймаутом 60 с, а сбой до POST — это
  `failed`/`not_submitted` (можно повторить), `uncertain` — только после POST.
  Живой разговор по звонку смотрите в `GET /v1/convai/conversations` ключом сессии
  (аккаунт прода); без записи там сбой был до отправки.
- «Линия не ответила на подготовку» трижды подряд (14.10, повторные звонки в одну
  минуту): ElevenLabs отвечал за 0,2 с, агент и SIP-транк в порядке, последний
  звонок в `conversations` — первый (успешный). Предзвонковые чтения Exolve
  (`GetList`, `GetSIPList`, креды) шли без повтора и глотали причину, как
  ElevenLabs 13.10; теперь 3 попытки и `[phone] Exolve request failed` с причиной
  (`shared/phone/exolve.ts`). Подтвердить на проде не смогли (нет логов) — при
  повторе ищите эту строку и `[phone] call preflight failed` в `host.py logs`.
  `not_submitted` теперь сам помечает отчёт доставленным: человеку это уже
  сказал результат `phone-call`, а ход-отчёт на каждый такой сбой слал «ничего
  нового» и говорил о человеке в третьем лице.
- У ElevenLabs `metadata.cost_fiat` — USD, не RUB. SIP-плату Exolve нужно
  сверять и перед созданием SIP после паузы: первые три бесплатны, следующие
  платные; прежняя котировка не гарантирует бесплатный новый SIP.
- С адресов Cloud.ru (история; на Selectel не проверяли) прямой ElevenLabs API может отвечать редиректом country-access
  notice. Для него есть отдельный `ELEVENLABS_PROXY_URL` с TLS-проверкой:
  только SDK телефонии и операторский setup, не глобальный fetch/браузер.
- Голос телефонии (09.10): у пилотного агента стоял `cjVigY5qzO86Huf0OWal` —
  американский английский premade «Eric», отсюда нечеловечный русский. Голос,
  `turn`, температура и базовый промпт задаёт `scripts/phone/setup.ts`
  (`--voice-id`), приветствие и промпт звонка — `startCall` и `ingress.ts`.
  `turn_eagerness`: с 10.10 `eager` по просьбе владельца (пауза до ответа была
  1,4–2 с: 0,2–0,6 с решение о конце реплики и ~0,9 с модель); на `normal`
  возвращайте, если `eager` начнёт перебивать диктующего время или номер.
  Повторный звонок на номер, с которым уже был разговор (`done`, > 5 с),
  не представляется заново знакомым (`repeatCall`, `hasEarlierConnectedCall`
  в `db/services/phone.ts`); организациям представляется всегда. Решение владельца: Бро не называет себя ИИ в приветствии и не
  заводит речь о записи, но не отрицает ИИ и запись, если спросят; трубку
  вешает после прощания, а не сразу по выполнении задачи. Исходящий звонок
  открывается коротким приветствием сразу при соединении (см. ниже). Обращение выбирает
  промпт по задаче: заведения и незнакомые — «здравствуйте»/«вы», знакомый
  человек пользователя — «привет»/«ты».
- Бро здоровался дважды (13.10): `first_message` «Алло, привет!» уже звучит при
  соединении, а на «Привет» собеседника модель отвечала вторым «Привет!». Причина —
  `repeatCallRule` (повторный звонок знакомому) сам велел «поздоровайся по-свойски», и это
  перебивало слабое «не здоровайся второй раз». Теперь `noSecondGreetingRule`
  (`shared/phone/persona.ts`) стоит в промпте исходящего всегда, а повторный звонок
  приветствие не требует. Проверка — расшифровка в `GET /v1/convai/conversations/<id>`.
- Бро бросал трубку сразу после своей реплики (10.10, 11.10): `gpt-6-luna` без
  рассуждений вызывала `end_call` в том же ходе, что и приветствие (ElevenLabs
  `conversations/<id>`: `tool_calls` `end_call` у первой реплики агента, звонок 9 с,
  `termination_reason` «end_call tool was called»). Промпт, `hangupGuard` и
  описание инструмента не помогли, поэтому с 11.10 у агента **нет** `end_call`
  (`scripts/phone/setup.ts`, нужен `phone-setup.sh --apply`): звонок кончает
  собеседник или `silence_end_call_timeout` 12 с (`phoneSilenceSeconds` в
  `shared/phone/persona.ts`) и лимит длительности. Цена: после прощания линия
  висит до 12 с, а пауза собеседника дольше 12 с (диктует номер) обрывает звонок.
  Не возвращайте инструмент завершения, пока модель не держит правило без
  рассуждений. Манера речи и правила завершения общие для исходящего, входящего и
  базового промпта; смена модели агента — `PATCH` `prompt.llm` вместе с
  `reasoning_effort` (у Claude его нет); Haiku 5.5 в ElevenLabs 10.10 нет, владелец
  оставил `gpt-6-luna`.
- Паузы и «Секунду…» (12.10): в живом звонке `gpt-6-luna` отвечала 2–6 с, и через 3 с
  `soft_timeout_config` вставлял фиксированное «Секунду…» поверх ответа. Теперь
  `timeout_seconds: -1` (API: -1 или 0,5–8 с) и модель `deepseek-v41-flash`,
  `reasoning_effort: none` (`phoneLlm` в `shared/phone/persona.ts`). Замер текстом
  через WebSocket (`text_only`, временный агент): медиана до ответа 0,22–0,24 с против
  0,8–1,3 с у luna, gpt-4.1-mini 0,49, haiku-4-5 0,54. Лимит списка моделей —
  `GET /v1/convai/llm/list`. Упоминание слова «секунду» в запрете промпта само
  провоцирует его: запрет сформулирован без слова.
- Пауза до ответа (13.10, метрики `GET /v1/convai/conversations/<id>`): LLM+TTS ≈ 0,35 с,
  остальное — `turn_silence_before_initiation` (0,3–1,5 с) и линия. `spelling_patience: "auto"`
  удлиняло ожидание при диктовке, теперь `off`; `optimize_streaming_latency: 4`
  (`scripts/phone/setup.ts`). Вернуть `auto`, если Бро начнёт влезать в диктуемый номер.
- Записная книжка Бро (`CONTACTS_WORKSPACES`, id или `*`; нужна и телефония):
  таблица `phone_contacts`, сервис `db/services/contacts.ts`, инструменты
  `contact-find/save/delete` в `agent/tools/phone-contacts.ts`. Запись — только
  в ходе, открытом сообщением человека (`rootApproval` и `phoneActionTurn`,
  общие с `phone-call`); поиск сравнивает слова по основе (маме = мама), поэтому
  «Маша» и «Мама» не путаются, а «Саше» найдёт «Саша с работы». Снять флаг —
  инструменты пропадают, таблица остаётся. Раздела «Контакты» в `/workspace` нет.
  С 11.10 в проде `*` (решение владельца — сразу всем, без пилота).
- Результат инструмента, который eve отдаёт модели, — строго JSON: `Date` из
  строки drizzle валит его (`ToolOutputSerializationError`), как было у
  `phone-status` на проде 11.10. Даты — `toISOString()` на границе инструмента
  (`agent/tools/phone.ts`). Отчёт о звонке (`agent/lib/phone/report.ts`) не
  несёт цены: модель называла «стоимость голоса в долларах» без просьбы;
  цену она читает через `phone-status`, когда человек спросит.
- Пустой `first_message` исходящего (09.10) вживую 11.10 дал тишину в начале:
  человек снял трубку и сам сказал «Алло?». Теперь приветствие звучит сразу при
  соединении (`outboundGreeting`; «Алло, привет!» при `familiar: true` у
  `phone-call`, иначе «Здравствуйте!»); провайдер принимает `first_message` в
  overrides звонка.
- `host.py build_env` всегда задаёт `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
  `CI=1` и сохраняет заданный оператором `COREPACK_HOME`: иначе новый worktree
  ждёт интерактивного подтверждения скачивания pnpm вместо сборки релиза.

- Скорость операций Яндекса (12.10, `docs/yandex-api/speed.md`): вкладка
  открывается за 0,1 с, время уходит в загрузку страницы origin (Афиша 5 с,
  Маркет 8 с) — read-операции ставьте на `robots.txt` своего origin, как Go,
  а `loaded: "interactive"` хватает там, где контекст лежит в самой странице.
  Афиша с сервера без браузера — `YANDEX_DIRECT_WORKSPACES`, с откатом во вкладку.
  Способ 4 (сервер по cookies профиля) замерен 12.10 и отвергнут: выигрыш ≈1 с,
  с IP сервера Маркет редиректит; проба — `ops/yandex-session-probe.sh`
  (id владельца третьим аргументом), итоги в `speed.md`.

- Браузерные e2e-тесты (раннер e2e, `e2e/`) — `docs/e2e.md`. С 04.10 набор
  не в CI и не обязателен в PR (решение владельца), гоняется лишь вручную.
- Скилл `/orchestrate-cloud-threads` (`.claude/skills/orchestrate-cloud-threads/`):
  координатор раздаёт каждую единицу работы отдельной облачной сессии, а не
  долгоживущему субагенту (кэш субагента ~5 минут, потом дорогое перечитывание).
  Работает в облаке лишь потому, что закоммичен в репозиторий.
- Бэклог с приоритетами и критериями «готово» — `docs/roadmap.md` (сделанное
  вычёркивайте там же в своём PR); как гонять бенчмарки и их итоги —
  `docs/benchmarks/README.md`; промпт сессии, которая запускает исполнителей и
  мёрджит их PR, — `docs/orchestrator-prompt.md`.
- Куда уходят деньги и что снижать — `docs/agent-costs.md`; пул браузеров —
  `docs/browser-pool.md` (прод с 10.10 — постоянный сервер Selectel,
  Firecracker; хосты Cloud.ru — история); заметки по браузерной
  инфраструктуре (VM, хосты пула, worker) — `docs/browser-infra-notes.md`.
  Переезд на Selectel и где что живёт — `docs/selectel-migration.md`.
- Сравнение с Instinct и что из него взято в бэклог (пункты 24–33 роадмапа) —
  `docs/instinct.md`; переезд с Vercel на Cloud.ru (сделан 02.10) —
  `docs/cloudru-migration.md`, промпт сессии, которая доводила его до конца, —
  `docs/cloudru-full-migration-prompt.md`; песочница для кода и task-агент —
  `sandbox/README.md`.

## Процесс

- Дизайн (15.10): все страницы, кроме лендинга, — на одной системе: тёплая
  бумага `#f1f2ee`, чернила `#141510`, белые плашки (`bro-plate`: рамка 2px,
  радиус 24px), кнопки и поля-капсулы, Source Serif 4 для заголовков и Geist
  для остального (`app/layout.tsx`, `app/styles/brand/bro.css`). Основной цвет —
  чернила, не синий: прежний `--primary` в `globals.css` убран. Навигация —
  капсула и тёмный футер (`web/components/paper/capsule.tsx`, `footer.tsx`),
  боковой панели кабинета нет. «Сейф» — раздел `/workspace`, а не вкладка:
  `/vault` только редирект с query (ссылки агента `?setup=vault&kind=…` идут
  на `/workspace`). Лендинг грузит Source Serif 4 и Geist отдельно, со своими
  токенами в `landing.module.css`; остальные страницы берут их из корневого
  `app/layout.tsx`.
- Публичный лендинг использует Source Serif 4 как кириллическую замену Fraunces
  (в исходном шрифте Hilos нет русских букв). Его шрифты и токены изолированы
  в `app/(public)/landing.module.css`: остальные страницы живут на общей
  системе (запись «Дизайн»), правка одной не должна менять другую.
- Границы портретов в `portrait-wallpaper.tsx` измерены по alpha > 16 оригиналов
  1254×1254; web-копии 512×512 не меняют эту систему координат SVG.
- Изолированное превью запускайте с `EVE_SCHEDULES=off`, но не передавайте это
  значение Vitest: тесты расписаний проверяют обычный включённый режим.
  Для `pnpm check` и прямых запусков тестов оставляйте умолчание расписаний.
- В eve 0.62 `EVE_NEXT_PRODUCTION_ORIGIN` управляет только production-топологией;
  для отдельного dev-превью интеграция Next читает `EVE_BASE_URL`. Не поднимайте
  агента ради просмотра публичной страницы: укажите изолированный loopback-origin.
  Внешний hostname dev-превью нужен в локальном `allowedDevOrigins`, иначе HTML
  откроется, но часть JS получит 403 и интерактивность не заработает.
- Основная ветка — `bro-next`, PR — в неё; CI — `.github/workflows/checks.yml`.
  Коммиты и заголовки PR — по-русски, с точки зрения пользователя.
- Владелец заранее разрешил всем сессиям (03.10), переспрашивать не нужно:
  код и миграции, слияние в bro-next при зелёном CI, выкат, откат и рестарт
  на VM прода, env прода (`prod.json`, `host.py env`, `state save/restore`),
  deployd, ops-скрипты и серийную консоль, чтение и запись базы прода,
  создание и удаление своих ресурсов Cloud.ru и Selectel.
- Правила владельца для всех сессий (03.10): спрашивать его только о том, что
  может лишь он (ключ из кабинета сервиса, код из SMS, пополнение);
  `bro-app-1` и `sbx-code-2` (Cloud.ru, уборка — с его разрешения), `bro-app-sel-2`,
  `bro-dedicated-3` и базу прода не удалять; его Gmail и
  Календарь — только чтение, тестовые события можно, но потом удалить;
  поручения браузеру с его аккаунта (он же аккаунт бенчмарка) — только на
  чтение, брони и оплаты не подтверждать; до 3 000 ₽ сверх обычного расхода
  без спроса. Новое поведение — флагом сначала владельцу, затем бенчмарк,
  затем всем. Лимиты подписки дороги: без мутационных прогонов, больших ревью
  и недельных наблюдений внутри сессии.
- Ревьюит cubic и только PR не в черновике; на merge-коммит в голове PR
  он ставит зелёную проверку без ревью — кладите сверху обычный коммит. С
  03.10 до 01.11 его квота кончилась (`neutral`, «AI review line limit
  reached»): ревьюят субагенты сессии, Hacktron `skipped` — тоже норма.
- Vitest подхватывает тесты из забытых worktree подагентов в
  `.claude/worktrees/` и падает на чужих моках: закончив с worktree —
  `git worktree remove -f -f <путь>`. В чекауте с симлинком на `node_modules`
  `pnpm exec vitest` падает с `ERR_PNPM_UNSAFE_MODULES_DIR` — запускайте
  `./node_modules/.bin/vitest`.
- Длинное задание сессии-исполнителю (`create_session`) через подагента
  классификатор обрезал: полный текст — файлом в служебной ветке без слияния,
  а промпт — «прочитай `git show origin/<ветка>:<файл>`».
- В свежей облачной сессии нет `node_modules` (`pnpm install`), а Node 22 валит
  ~12 наборов `pnpm check` («Unexpected identifier 'r'»). Node 24 без root:
  `npm pack node-linux-x64@24` в scratchpad, `bin` — в начало `PATH`.
- `TELEGRAM_BOT_USERNAME` облачной сессии начинается с `@`, и проверка env
  роняет каждый тест, который импортирует `@shared/environment`, и `pnpm build`
  / `build:eve`: гоняйте их через `env -u TELEGRAM_BOT_USERNAME`, в env прода —
  без `@`. Из-за `IMESSAGE_PROJECT_ID` в env сессии прямой `vitest run` падает
  и на `db/services/auth/tests/photon.test.ts` («resolves project credentials
  lazily»), даже на чистом bro-next: `env -u IMESSAGE_PROJECT_ID`. Так же
  `OPS_ALERT_BOT_TOKEN` сессии валит `agent/lib/model/tests/credits.test.ts`: тревога
  уходит служебным ботом, а тест ждёт тестовый токен — `env -u OPS_ALERT_BOT_TOKEN`.
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` сессии без `S3_ENDPOINT` и
  `S3_REGION` валят `pnpm build:eve` той же проверкой: снимайте и их.
- `pnpm build` без `.env.local` падает на сборе данных страниц: хватает заглушек
  `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`. knip в `pnpm check`:
  новый каталог точек входа (как `agent/instrumentation/`) — в `knip.config.ts`.
- Тесты (аудит 14.10, `docs/test-audit.md`): не пишем проверку дословного текста промпта, кроме
  правила денег, согласия, безопасности или кодов (одна ключевая фраза на правило); не добавляем
  строки `it.each` того же класса входа и тест, идущий тем же путём кода к тому же исходу; не тестируем
  константы, умолчания env и аргументы мока без проверки результата. Дубль ли тест, видно по покрытию
  до и после удаления (`@vitest/coverage-v8` в зависимостях нет — ставьте во временный каталог), но
  SQL в PGlite, код eve и функции страницы покрытие V8 не видит.
- `vi.unstubAllEnvs()` в `afterEach` снимает и подмены `tests/setup-env.ts`
  (тестовый `COMPOSIO_API_KEY`): ручной `vitest run` тогда видит ключ из env
  сессии и проходит, а `pnpm check` (turbo) и CI env не передают — тест
  падает. Нужный ключ подменяйте в `beforeEach` самого теста.
- `drizzle-kit generate` пишет `db/migrations/meta/*.json` не в формате
  `oxfmt`: после генерации — `pnpm exec oxfmt db/migrations/meta`.
- oxlint `anti-slop` запрещает `typeof`-ветвления, параметры `unknown` и
  `Record<string, unknown>`: внешнее разбирайте схемой zod, варианты — по `kind`.
- Формат проверяет `oxfmt` (`pnpm format:check`), не Prettier: `npx prettier`
  переформатирует TypeScript иначе, и CI падает. Чините `pnpm exec oxfmt <файлы>`.
- Oxc/knip резервируют до 6 GiB виртуальной памяти под raw-transfer. На
  облачной машине с 4 GiB и `vm.overcommit_memory=0` это падает даже без
  расхода RAM; `sudo sysctl -w vm.overcommit_memory=1` разрешает резервирование.
  Проверки запускайте последовательно; ограничения Node передавайте через Turbo
  с `--env-mode=loose`, иначе они могут не попасть в дочернюю команду.
- На машине с 4 GiB `pnpm build` и `pnpm build:eve` убивает физический OOM
  даже с ограничением JS heap; 4 GiB swap позволяют собрать оба. Webpack не
  запасной путь для eve 0.62: он не разбирает `using` в клиенте eve, поэтому
  оставляйте стандартный Turbopack.
- Перед последовательным `pnpm check --concurrency=1` запустите
  `pnpm types:generate`: иначе type-aware lint не видит сгенерированные
  `PageProps` и ложно сообщает об unsafe-типах.
- PGlite-тест с `vi.resetModules()` должен в каждом кейсе заново импортировать
  `@db` и подменять `db`, иначе висит на `pg.Pool`
  (`db/tests/proactive.test.ts`). Наружу тесты не пускает `tests/setup-env.ts`.
  Так же виснет `vi.mock` с `importOriginal` модуля, тянущего `@db`: сбой
  записи в таком тесте делайте триггером PGlite (`failVmUptimeWrites` в
  `tests/agent/browser-pool/sandbox.test.ts`).
- Миграции прода с 02.10 катит deployd при релизе на VM (`ops/migrate.mjs`);
  до этого превью Vercel делили базу с продом, и миграции неслитых PR ложились
  в прод, а drizzle пропускал более ранние `when`. Миграцию PR перед слиянием
  генерируйте поверх bro-next: параллельные PR сталкиваются номерами, второй
  перегенерирует свою, журнал и снимки руками не правят.
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
- Фейковые часы vitest не двигают именованный импорт `setTimeout` из
  `node:timers/promises`: ожидание шло настоящее, а запоздавший повтор
  попадал в `fetch` следующего теста. Ожидание, которое тест проматывает, —
  на глобальном `setTimeout` (`pause` в `scripts/bench/retry.ts`).

- e2e: `next dev` на `127.0.0.1` грузит скрипты, только пока он в
  `allowedDevOrigins` (`next.config.ts`), иначе форма входа уходит обычным GET
  без гидратации; значок `devIndicators` закрывал «Выйти» и отнимал клики.
  Приложению раннер передаёт лишь `PATH`, `HOME` и `command.env`: прокси и CA
  облачной сессии — тоже через него (`e2e.config.ts`), иначе модель — «self-signed
  certificate». Playwright 1.63 требует свой Chromium, а в `/opt/pw-browsers`
  старый: `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>` и `playwright install chromium`.
- Management-ключ OpenRouter проходит `GET /api/v1/key`, но на вызов модели
  отвечает «User not found»: в `OPENROUTER_API_KEY` — только обычный ключ.
- `ROUTERAI_API_KEY` облачной сессии 05.10 — ключ прода, баланс общий: опыты
  уменьшают баланс Бро (при нуле он молчит всем). Kimi K3 и Grok 4.7 — 6–8 ₽ за
  вызов в 20 тыс. токенов; смотрите `/api/v1/credits` до и после.
- Selectel (05.10): облачные VM без вложенной виртуализации; из облачной
  сессии SSH закрыт, HTTP на :80 VM открыт, а HTTP-агента с исполнением
  команд классификатор не пускает — работа VM целиком в cloud-init, итоги
  статикой (`scripts/selectel-bench/`). Порт прямо в `external-network` не
  выделяется (нужны своя сеть, роутер и floating IP); `rebuild` VM с сетевым
  диском cloud-init не перезапускает.
- 15.10 `sel.py down` удалял **все** плавающие IP региона и в ru-3 снял адрес
  прода: brobro.tech лежал ~30 минут. Теперь `down` трогает лишь IP своих VM.
  Вернуть тот же адрес API не даёт (Neutron — `PolicyNotAuthorized`, resell —
  `service_unavailable`). Чинится так: новый IP на порт VM; A-записи `@` и
  `www` в DNS Vercel, TTL 60 (`PATCH` записи отвечает 404 — новая запись
  `POST` с `teamId`, старая удаляется); домен операций `/var/lib/bro/domain`
  (sslip.io от IP) с перерисовкой Caddyfile; кэш `bro-app-sel-2.json` и
  `state save`. Снаружи Selectel новый IP ответил лишь через ~15 минут.

## Прод на VM

- С 10.10 прод — Selectel (`docs/selectel-migration.md`, «Переключение»):
  VM `bro-app-sel-2` (`SL1.2-4096-32`), база `bro-pg`, S3 `bro-bucket`;
  браузеры и песочницы кода (`sbx-dedicated-3`, `code.<ip>.sslip.io`) — на
  одном выделенном сервере `bro-dedicated-3` (CL25-NVMe, месячный тариф), с
  общим Caddy и своим потолком памяти у каждого (`sandbox/README.md`).
  Новый `sandboxd` туда — только переустановкой сервера. Бро считает место
  на хосте как `MemTotal − reserve`, а не потолок `memory_limit_mb` `hostd`:
  на общем сервере сверх 19 ГБ `hostd` ответит 507 — пока пул у одного пилота,
  это не мешает; при росте — отдавать потолок в `/v1/capacity`. Аккаунт Cloud.ru
  10.10 приостановлен за неуплату (VM выключены, S3 — `TenantSuspended`):
  всё про Cloud.ru — история (`docs/cloudru-migration.md`, «История»). Операции: `BRO_CLOUD=selectel` и
  `BRO_APP_HOST_DIR=/root/.bro-app-host-selectel` (полный путь), у
  `scripts/cloudru-code-host/host.py` — тот же `BRO_CLOUD`. Ключи — в env
  облачной сессии: `SELECTEL_API_KEY` (или `SELECTEL_TOKEN`),
  `SELECTEL_ACCOUNT`, `SELECTEL_PROJECT`, `S3_*` бакета `bro-bucket`
  (`PROBE_BUCKET`); ключи оператора (выкат, env прода, `updateKey` хостов) —
  `host.py state restore`, им нужен прежний `CLOUDRU_KEY_SECRET`: им
  зашифровано состояние, хоть Cloud.ru и закрыт. Env прода —
  `host.py env bro-app-sel-2 --profile prod --allow-missing
--no-alert-webhook`; инфраструктура Selectel (`S3_*`, пул `static`,
  хост песочниц) — в `prod.json` этого каталога.
- Выкат из свежей облачной сессии без `SELECTEL_PROJECT`/`SELECTEL_ACCOUNT`:
  `state restore`, `env`, `deploy`, `logs`, `ops` им не нужны (VM берётся из
  кэша `bro-app-sel-2.json`), нужен только S3: `S3_ENDPOINT=https://s3.ru-1.storage.selcloud.ru`,
  `S3_REGION=ru-1`, `PROBE_BUCKET=bro-bucket` (без них — 403 на `operator/state.bin`);
  `status` Selectel API ходит и без проекта падает. Сборке нужны Node 24 и `zstd`
  (`apt-get update` перед `install`). Тон звонка — ops-скрипт `phone-setup.sh` с флагами
  `--public-url https://brobro.tech --apply --output /tmp/x.env`.
- Адрес deployd в кэше `bro-app-sel-2.json` из `state restore` может отстать от
  VM (15.10: старый адрес deployd в 17:10 начал рвать TLS, `deploy` падал на
  «Connection reset by peer», а сайт отвечал). Если `status` по кэшу рвётся, сверьте
  адрес с `host.py status` (ему нужен `SELECTEL_PROJECT` из
  `GET https://api.selectel.ru/vpc/resell/v2/projects`; файл `project` состояния —
  не он). Собранный релиз выкатывается без пересборки: `deploy --version`.
- `host.py state save` грузит в `operator/state.bin` весь локальный каталог и
  затирает более новые файлы другой сессии, а `state restore` без `--force`
  оставляет уже лежащие локальные (`cmd_state` в `host.py`). 15.10 так затёрся
  `bro-app-sel-2.json` с новым адресом VM: следующий выкат шёл бы на мёртвый
  адрес, `PUT env` падал на «Connection reset». Перед правкой env или выкатом —
  `state restore --force`; перед `state save` — убедиться, что чужое новое не
  затрётся. Версии `operator/state.bin` в бакете включены: прежняя — `GET ?versions`
  и `versionId` (`s3.signed` в `scripts/cloudru-sandbox-probe/s3.py`). Живой env
  сверяйте по sha256 текста из `GET /ops/v1/env` deployd с составленным `compose_env`.
- deployd пропускает в аргументах `host.py ops` только `[A-Za-z0-9._:/=@%?&+-]`
  (`ARGUMENT` в `host/deployd.py`): список через запятую он отвергает («at most 16
  plain arguments»), ops-скрипты соединяют значения через `+`.
- Локальный диск флейвора Selectel при смене флейвора не уменьшается: VM
  меньше — только новой VM и переключением (`docs/selectel-migration.md`, шаг 6).
- Память VM (4 ГБ): у `bro-eve` куча `--max-old-space-size=1280`, у `bro-web` 640
  (действует с рестарта), swap 2 ГБ делает `install-code.sh` (не фатально: без
  места или при сбое — предупреждение). `MemoryHigh`/`MemoryMax` в юниты не
  ставьте, пока на проде не снят `systemctl show bro-eve bro-web -p MemoryPeak`:
  лимит cgroup после `daemon-reload` убьёт живой eve посреди хода.
- Баланс Selectel проверяет `watchdog.py` раз в 15 минут. Ключ —
  `SELECTEL_BILLING_TOKEN` (только чтение биллинга, не `SELECTEL_TOKEN`: тот
  удаляет VM, а ops-env получают все ops-скрипты релиза) в `/etc/bro/ops-env`.
  Порядок: сначала `host.py update-host`, потом `host.py env … --with-selectel-balance`
  (берёт ключ из env сессии); `host.py env` без флага ключ снимает, проверка
  тихо выключается. Порог — `SELECTEL_BALANCE_MIN_RUB` (1000).
  Вместо ключа — сервисный пользователь с единственной ролью «Биллинг»:
  `SELECTEL_BILLING_USER_ID`, `SELECTEL_BILLING_PASSWORD`,
  `SELECTEL_BILLING_ACCOUNT` (номер аккаунта), все три в env сессии для того же
  `--with-selectel-balance`; пользователь главнее ключа. Сторож берёт токен у
  Keystone (`cloud.api.selcloud.ru/identity/v3/auth/tokens`, 24 ч, заголовок
  `X-Auth-Token`; статический `X-Token` его не принимает), кладёт в
  `watchdog.json` (0600) и меняет за час до срока или после 401; сбой Keystone —
  «не прочитано», а не низкий баланс.
- Selectel и RouterAI блокируют всё при нуле на балансе: при пустом RouterAI
  Бро молчит всем («Недостаточно средств»), при нуле Selectel пропадает и S3.
  Баланс Selectel — `GET https://api.selectel.ru/v3/balances` (`X-Token`,
  значения в копейках).
- `WIPE_SQL` (`ops/db-lib.sh`) не должен трогать последовательности identity: у
  `GENERATED ALWAYS AS IDENTITY` (миграции с 0065) `DROP SEQUENCE` отдельно — ошибка,
  она уходит вместе с таблицей. 13.10 из-за этого ночной бэкап падал на
  «could not empty the scratch database», а в `check` оставалась копия данных.
  Причина не в замках: воспроизведено на чистом PostgreSQL (`WipeSqlTest`).
- Личная почта: Mail.ru завышает `RFC822.SIZE` относительно полного
  `BODY.PEEK[]`; сравнение этих длин отвергает настоящее письмо. Читайте
  полное тело с лимитом literal у ImapFlow, а не частичный блок по этой оценке.
  Яндекс отказывает `SEARCH HEADER MESSAGE-ID`: для копии отправленного
  проверяются только envelope последних 50 писем, без чтения их тел.
  В ImapFlow `seen: undefined` означает `UNSEEN`, а не отсутствие фильтра:
  не передавайте boolean-поля поиска, если человек фильтр не задал.
  Mail.ru также теряет совпадения у `SUBJECT … UNSEEN`, хотя `UNSEEN SUBJECT …`
  на том же UID работает: добавляйте флаги и даты перед текстовыми критериями.
- Кошелёк ЮMoney (15.10, пилот `YOOMONEY_WORKSPACES`, с 15.10 — владелец): баланс, история
  и платежи с баланса по OAuth (`agent/tools/yoomoney.ts`, `yoomoney_pay.ts`,
  `db/services/yoomoney/`, `shared/yoomoney/`, маршруты `/api/yoomoney/*`). Приложение —
  yoomoney.ru/myservices, Redirect URI `https://brobro.tech/api/yoomoney/callback`. `state` у
  ЮMoney нет: он едет в query Redirect URI, ЮMoney его сохраняет, а обмен кода повторяет тот
  же URI. На неверный код, секрет или URI `/oauth/token` отвечает 200 `{"access_token":""}`, а
  не ошибкой OAuth: секрет проверяет лишь настоящий вход. Токен живёт 3 года без refresh, 401
  — подключение удаляется. Права на экране согласия видны лишь после входа в кошелёк:
  лимит `.limit()` в scope из облака не проверить, его нет.
- Платежи ЮMoney: каталог витрин (`/api/showcase-search`, `/api/showcase/<id>`) публичный и
  без токена; форма идёт шагами: 300 — следующая форма (адрес — `Location`), 400 — ошибки
  полей, 200 — параметры `request-payment`. Оплата по ИНН (витрина 5551) через API не
  открывается (404/405) — такие находки отброшены. `process-payment` с тем же `request_id`
  повторно не платит и возвращает исход: так читаются `in_progress` и потерянный ответ
  (`status`); `contract_not_found` при таком чтении — «неизвестно», не отказ.
  Тестового режима у API кошелька нет (15.10): с `test_payment`/`test_result` ЮMoney
  отказывал каждому платежу. Проверка без денег — `request-payment`, он ничего не списывает.
  Одно «да» платит один платёж: захват пишет `consent_hash` (разговор, ход, вопрос) под
  уникальным индексом — иначе одинаковый второй платёж в том же ходе проходил по тому же
  «да» (Лавку от этого спасала опустевшая корзина). Потерянный исход сверяется с историей
  кошелька, с которого платёж готовился (`account` в строке; другой подключённый кошелёк о
  нём не знает): перевод — по `label` (id платежа), услуга — только успешная операция той же
  витрины (`pattern_id`) на ту же сумму: чужая неудачная попытка той же суммы — не отказ.
  «Нет в истории» — лишь после чтения всего окна и через 30 минут.
- Оплата привязанной картой ЮMoney (15.10): право `money-source("wallet","card")` в scope
  (старое подключение — переподключить), карта — только за услуги, не переводы. Услугу, на
  которую не хватает баланса, Бро ставит на карту (`db/services/yoomoney/card.ts`). Без CVV
  (`csc_required: false`) платит обычное «да» в чате (владелец 15.10: без блокеров — текстом);
  с CVV — ссылка `/pay/<id>?t=<HMAC id>`, согласие — нажатие «Оплатить», CVV из формы сразу в
  `process-payment`, не хранится. 3-D Secure: форма `acs_params` на `acs_uri` хранится в строке
  до ответа банка, страница её отправляет, банк возвращает на `/api/yoomoney/pay/<id>/return`.
  Повтор `process-payment` одним `request_id` — только для `pending` (ЮMoney уже ответил на
  карту): у неотвеченного это первый вызов, и ЮMoney по умолчанию платит кошельком —
  `unknown` карты сверяется только по истории. У `/pay/*` `Referrer-Policy: strict-origin`:
  при `no-referrer` (и `same-origin` — для формы банка) браузер шлёт форму с `Origin: null`.
  Пока человек у банка, `request_id` один ЮMoney отвечает `illegal_params` (15.10): это не
  отказ — сверка с историей, платёж ждёт (`yoomoneyReadBackSilent`). Ручная проверка статуса
  посреди 3-D Secure так закрыла первый живой платёж картой «Мир» (ЮMoney шлёт её в 3-D Secure
  1.0.2 через `mirconnect.ru`). Банк возвращает на `…/return?r=ok|fail`; ход платежа — строки
  `[yoomoney] process-payment` и `card payment …` в журнале `bro-web`.
- Ops-адрес `host.py` — IP из кэша `<VM>.json` в `BRO_APP_HOST_DIR`, а не из DNS: 15.10 IP VM
  сменился, кэш из `state restore` остался старым, и `logs`/`deploy` рвались «Connection reset
  by peer». Сверьте IP кэша с A-записью `brobro.tech`.
- OAuth почты требует настройки самого ящика, не только scopes приложения:
  Яндекс — «Почтовые программы» → IMAP; Mail.ru — «Внешние сервисы» →
  «Доступ к Почте по IMAP, POP и SMTP». Выключенная настройка блокирует вход
  даже с правильным клиентом и токеном.

- AgentMail: один ящик на workspace, временные task-субагенты ящики не
  расходуют. С 10.10 ящик у каждого воркспейса, когда задан ключ: `AGENTMAIL_WORKSPACES`
  пуст или не задан — всем, `off` — никому (откат), список id — только им;
  ключ только в env сервера. Тариф ограничивает число ящиков. Проверка настоящего ящика — `host.py ops NAME agent-mail.sh
self-test WORKSPACE_ID`, письмо только самому агенту. После обрыва send
  его ключ живёт у провайдера 24 ч: локальная незавершённая операция старше
  23 ч не повторяется; receipt завершённой хранится в базе.
- AgentMail API отвечает CloudFront 403 с IP Cloud.ru и с резидентного
  выхода РФ; выход США работает. `AGENTMAIL_PROXY_URL` — отдельный CONNECT
  прокси только этого API, с проверкой TLS; браузерный прокси не меняйте.
- Прокси облачной сессии может снять `Content-Length`: S3 PUT вернёт 411,
  а deployd увидит пустой JSON («version must match», хотя версия верна).
  Рабочий путь: объекты по 8192 байта, сборка на VM со сверкой SHA-256;
  подписанный POST deployd — через loopback из serial-консоли, статус — GET.

- Прод с 02.10 был на VM Cloud.ru, с 10.10 — Selectel; Vercel `bro-next` как
  путь отката закончился 09.10 (уборка и история Cloud.ru — `docs/cloudru-migration.md`). Убирая «ветку
  OpenRouter», не трогайте `createOpenRouter` в `agent/lib/model/direct.ts`:
  через него с другим `baseURL` ходит RouterAI — единственный провайдер прода.
- Слияние прод не обновляет: релиз — `host.py deploy <VM>`, и он собирает
  текущий чекаут: сначала полная продовая ветка и Node 24 (на Node 22 —
  «build with Node v24…»). Выкат и `host.py env` перезапускают eve и web и
  рвут идущие ходы: не во время прогона бенчмарка. Логи —
  `host.py logs <VM> bro-eve` (и `bro-web`), стек ошибки ищите там по тексту
  (в `turn.failed` — только код); runtime-логи Vercel — лишь путь отката.
- С 08.10 телефония в `bro-next`, и продовая ветка снова она. Журнал миграций
  взят из живой базы: `0053_phone`, почта `0054`, `0055_browser_delegation`
  с прежними `when` прода — их не перегенерируйте и не переименовывайте:
  Drizzle сравнивает время миграций, а не имена, и пропустил бы или повторил их.
- Env прода собирает `host.py env <VM> --profile prod` с `--allow-missing` и
  `--no-alert-webhook` (до 09.10 ещё `--with-neon`, иначе с VM уйдёт адрес
  Neon), потом `host.py state save`; последний слой — `prod.json` (`compose_env`).
  Пилоты — там же, `null` снимает имя. Ключ из `SENSITIVE_ON_VERCEL` без
  значения в профиле берётся из env облачной сессии, а `BROWSER_VM_LLM_API_KEY`
  — из её `ROUTERAI_API_KEY`: новый ключ RouterAI кладите в `prod.json` под
  обоими именами, иначе сессия со старым выкатит старый, и браузер пула на нём.
  OAuth Mail.ru/Яндекса берёт пары `*_MAIL_CLIENT_*` из env сессии; включение
  личной почты — `MAIL_WORKSPACES` в профиле. Ключей приложения недостаточно:
  почтовые scopes должны быть разрешены в кабинете самого провайдера.
  `SKILLS_WORKSPACES` и `TASK_FILES_WORKSPACES` берут только id воркспейса или
  `*`: email, как в пилотах снимка Vercel, валит проверку env, и eve не
  стартует.
- Классификатор auto mode Claude Code блокирует запись в `~/.bro-app-host`,
  `host.py env` («Secret-Store Writes») и выкат неслитой ветки с общим
  SQL-скриптом, а «разрешаю» владельца в чате не засчитывает. Не обходите:
  владелец меняет режим permissions сам. Базу читайте узким ops-скриптом через
  PR: `host.py ops` гоняет скрипты выкаченного релиза (`usage-stats.sh`,
  `memory-keys.sh`).
- Бот баг-репортов (`BUG_BOT=on`, `agent/lib/bug-bot/`, тик `agent/schedules/bug-bot.ts`):
  люди пишут служебному боту `OPS_ALERT_BOT_TOKEN`, отчёты уходят в
  `OPS_ALERT_CHAT_ID` с шапкой `🐞 #bug №N`, реплай владельца — человеку. Токен
  должен отличаться от `TELEGRAM_BOT_TOKEN`: `host.py` на профиле stand кладёт
  токен Бро в `OPS_ALERT_BOT_TOKEN`, и опрос `getUpdates` отнял бы обновления у
  `tg-bridge` (409), поэтому при равных токенах бот выключен (`bugBotTarget`).
  Опрос — long polling внутри минутного тика, ~55 с, offset в `bug_bot_state`;
  409 ставит паузу на 5 минут. Метки сообщений владельцу: `ownerMessageLabels`
  в `agent/lib/owner-alert.ts` (`#alert`, `#bug`, `#digest`), у `watchdog.py`
  свой `ALERT_TAG`.
- Журнал ходов владельца — `turn_log` (хук `agent/hooks/turn-log.ts`, сервис
  чтения `db/services/turn-log.ts`): id хода повторяется, поэтому открытой
  бывает лишь одна строка сессии и хода, а открытая старше 6 ч — `lost`.
  Тексты (`turn_log_entries`) — только при `OWNER_TRANSCRIPTS=on`, через общий
  с `conversation_log` фильтр `agent/lib/privacy/secrets.ts`; ключи JSON вида
  `password` выкидываются до фильтра: слово «password» в строке срезает фильтр
  всего хвоста. Сбой хода человека — `alertOwner` раз в час на пару
  воркспейс+код, сводка — `agent/schedules/owner-digest.ts`.
- Страница владельца `/workspace/admin` (`ADMIN_USER_IDS`: id Better Auth или
  email через запятую; пусто — не пускает никого). Охрана одна — `adminProcedure`
  в `web/trpc/router.ts`: страницы зовут те же процедуры через `createCaller`
  (`admin/_lib/caller.ts`), чужому — 404. Текст хода грузится по клику отдельным
  запросом `admin.transcript`, списком его нет.
- Тревоги владельцу (баланс RouterAI, пул) шлёт `agent/lib/owner-alert.ts`
  служебным ботом `OPS_ALERT_BOT_TOKEN` в `OPS_ALERT_CHAT_ID` (пара сторожа
  VM). Без него — ботом Бро в чат владельца с Бро, с шапкой «прислала проверка,
  не Бро»: свои сообщения бот не получает, и Бро, спрошенный о тревоге,
  отпирался, а потом выдумывал источник (05.10).
- Свежая облачная сессия без `~/.bro-app-host` не выкатит на VM
  (`DEPLOY_SIGNING_KEY`, пароли консолей, env-файлы): сначала
  `host.py state restore`, после смены ключей — `host.py state save`
  (`scripts/cloudru-app-host/README.md`, «Ключ и артефакты»). Восстановленный
  кэш IAM-токена Cloud.ru (`~/.bro-app-host/token`) просрочен, а свежий `mtime` прячет
  это от `cloudru.py`: консоль падает на 401 «Jwt is expired» — удалите файл.
  `host.py logs` отдаёт лишь хвост в 2000 строк; окно постарше — консолью:
  `journalctl --since … | gzip` и presigned PUT в бакет стенда (`s3.py`).

- Серийной консоли у облака Selectel нет («Unavailable console type serial»), есть
  noVNC: `host.py update-host` с `BRO_CLOUD=selectel` идёт через `scripts/selectel/vnc.py`
  — RFB-клавиши на tty1, команда скриптом из S3 со сверкой sha256, вывод — PUT по
  presigned-ссылке. QEMU теряет клавиши при быстром наборе (залипал Shift): пауза на
  каждое событие (`KEY_PAUSE_S`), строка ~40 с; картинка экрана — `vnc.py screen`.
  Без `websocket-client` (`pip install`) консоли нет. Бронь `POST /host-update`
  при сбое снимите `DELETE host-update`, иначе релизы, env и ops не стартуют.
- Cloud-init 21.3 образа Selectel не знает `chpasswd: users` (с 22.3): у
  `bro-app-sel-2` root был без пароля (`passwd -S` — NP), tty1 пускал без него, а
  `nullok` PAM давал `su` в root любому пользователю. `boot.cloud_init` пишет и
  `list`, а `update-host` на Selectel ставит хэш пароля из `<VM>.password`, если NP.
  Пароль `vnc.py` набирает, только если экран не повторил пробные клавиши
  (`asks_password`): иначе при NP он уходил в shell и его историю.
- Для `host.py` с Selectel нужен `SELECTEL_PROJECT`: id проекта даёт
  `GET https://api.selectel.ru/vpc/resell/v2/projects` с `X-Token`. Каталог
  `vendor/` не входит в `state restore`, поэтому перед `update-host` —
  `host.py vendor`.
- У аккаунтов, вошедших по телефону, почта синтетическая
  (`phone-…@local-vault.invalid`): в `ADMIN_USER_IDS` кладите id пользователя,
  а не почту.
- Оркестрация облачных сессий: `send_message` из сессии-исполнителя ждёт
  ручного одобрения и вешает её, поэтому исполнители координатору не пишут —
  он следит за PR сам. Ревьюер-субагент в чекауте координатора только читает
  (`git diff`, `git show`, без checkout). PR с конфликтом против базы не
  запускает CI вовсе: сначала слейте базу.

## eve

- Подтверждения действий не используются; новая покупка остаётся за обычным
  вопросом и ответом человека. Перенос файлов проверяется отдельно настоящим
  Chromium и HTTPS-формой (`browser-vm/worker/test_file_uploads.py`,
  `BRO_FILE_UPLOADS_CHROME`, browser-use 0.13.10 и aiohttp 3.14.3): документ
  синтетический, совпадение проверяется побайтно, другой сайт не получает его.
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
- Фото и PDF тоже лежат в `/workspace/attachments`, хотя модель получает их
  без пути. Оригиналы для сайта перечисляет `browser_files list`, а передача
  идёт без карточки в текущую браузерную сессию, с привязкой к HTTPS-сайту
  поручения (`BROWSER_VM_FILES_WORKSPACES`: только id или `*`). Telegram принимает
  PDF до 20 МиБ; документ больше лимита надо прислать заново, из истории его
  восстановить нельзя. Входящие файлы браузера не входят в отчёты и удаляются
  при закрытии его сессии (`agent/tools/browser_files.ts`, worker).
  Подготовку делает обычный task-агент своими инструментами, не сценарий
  конкретного сайта. Его `share_file` привязывает результат к workspace и
  корневому разговору; без этой записи старую ссылку браузеру не передать.
- Каналы без `turnPolicy` работают как `"steer"`: сообщение, пришедшее до
  начала ответа, перехватывает текущий ход; `"queue"` — только ходы-отчёты
  браузера (`completion.ts`) и расписания (`agent/lib/schedules/report.ts`). `defaultTools: false` выключает и готовую
  песочницу eve (`bash`, `read_file`, `write_file`), хотя `ctx.getSandbox()`
  работает (`node_modules/eve/docs/sandbox.mdx`).
- Владелец 01.10: Бро живёт на своих серверах (с 10.10 — Selectel), новое не
  завязывайте на Vercel (Sandbox, Blob, Workflow, Gateway). Свой сервер —
  `scripts/cloudru-app-host/README.md`: сборка для VM включается только
  `WORKFLOW_WORLD=postgres` (`pnpm build:eve`) и `NEXT_OUTPUT=standalone`
  (`next build`), без них сборка Vercel прежняя — не делайте эти режимы
  поведением по умолчанию, пока Vercel — путь отката.
- eve на SIGTERM выходит сразу (`sandboxShutdownPlugin`), и очередь Graphile
  не успевает вернуть свои задания: они заперты на 4 ч, а шаг ждёт аренду
  ядра workflow (860 с) — ход после рестарта продолжался через 14 минут.
  Перед каждым стартом eve `world-unlock.sh` (ExecStartPre в
  `bro-eve.service`, код хоста — переживает откат релиза) завершает сессии
  старого eve и возвращает задания; аренду не уменьшайте — шаги пойдут
  дважды. Один eve на базу мира: иначе unlock заберёт живые задания.
- `next start` сам eve не поднимает (запуск зашит в `rewrites()`, их Next 16
  вызывает только при сборке): eve — свой процесс `node .output/server/index.mjs`,
  не `eve start` (обёртка копит весь вывод ребёнка в памяти).
  `/.well-known/workflow/*` наружу не публикуйте: вход очереди мира без
  авторизации. Без схемы мир Postgres падает на старте: до запуска —
  `ops/migrate.mjs world`; две среды на одной базе мира исполняют чужие ходы.
- Стенду VM не ставьте `TEST=1`, чтобы выключить расписания: его читает и
  Better Auth (`isTest()`) и снимает проверку Origin. Расписания глушит
  `EVE_SCHEDULES=off` (`agent/lib/schedules/enabled.ts`).
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
- Релиз для VM собирается с `MODEL_PROVIDER` VM (`build_env` в
  `scripts/cloudru-app-host/host.py`): `web_search` выбирается при загрузке
  модуля, и без него в сборку попадал инструмент Gateway — RouterAI отвечал 400
  на каждый ход. Такие решения при загрузке модуля проверяйте на стенде ходом.
- deployd запускает ops-скрипты релиза от `bro` (файлы релиза — его); от root —
  только `ROOT_OPS` из бандла хоста (`ops/tg-bridge.sh`). Файл релиза от root
  не запускайте: его может переписать `bro`, а с ним инструменты модели, —
  такой запуск дал бы им root. Код хоста на живой VM —
  `host.py update-host`, а не пересоздание. Oneshot-юниты (`bro-egress`) он
  сам не перезапускает: что хосту нужно сразу, зовёт `install-code.sh`
  (`egress.sh`), а рестарт `bro-egress` перезапустил бы Caddy, web и eve.
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
- Вызов `task` хук видит в `actions.requested` как `kind: "tool-call"` с
  `toolName: "task"`, не `subagent-call` (внутренний запрос диспетчера,
  `harness/coordination.js`). Хуки шага отрабатывают до его конца
  (`closeAndDrain`), а тело задачи ждёт `ready` после шага
  (`acknowledgeDelegatedTasksStep`): новой задаче ждать файлов не нужно. Но
  сообщение занятому task-агенту (`steer.js`) уходит из execute `task` и
  обгоняет хуки шага: файлы такого сообщения ребёнок просит заново ~20 с.
  `actions.requested` приходит на каждый вызов отдельно (`emission.js`):
  лимит файлов шага держит состояние хода, а не событие. Ход-отчёт
  задачи сохраняет вызывающего, поэтому одного `startedByPerson` мало: ход
  чей-то, только если его открыло сообщение человека под его вызывающим и
  ни одно сообщение хода не пришло от фоновой задачи
  (`message.received.kind`, `agent/hooks/task-files.ts`).
  Оба хука идут в области песочницы шага (`context/run-step.js`), так что
  `ctx.getSandbox()` там работает; у ребёнка, продолженного после карточки
  входа, `message.received` нет — файлы того хода не копируются.
- Песочница task-агента с файлами человека — без сети навсегда: хук ребёнка
  до первого файла кладёт метку `sandbox/person-files/<sandbox id>` в S3, а
  роутер `tools` на каждый сетевой вызов её проверяет и при метке или сбое
  чтения отказывает (`agent/lib/sandbox/router.ts`): иначе инъекция в
  таблице уводила файл в URL `web-fetch`. Проверка идёт при любом S3, а не
  по флагу: снятый `TASK_FILES_WORKSPACES` иначе вернул бы сеть песочницам с
  файлами. Цена: каждый сетевой вызов пилота ждёт GET метки, а сбой S3
  снимает сеть у всех помощников пилота; «нет» не кэшируйте — метку ставят
  перед первым файлом. Токен роутера тут не помощник: он выпущен при открытии
  песочницы, до файлов. Метку не удаляйте и не сметайте с `sandbox/inbox/`.
  Объект inbox ребёнок берёт, только если ему меньше 5 минут
  (`inboxFreshMs`): ход человека перезаписывает объект при каждом
  упоминании, а старый назвал чужой ход. Свои хосты Бро, S3 и путь
  `/eve/v1/sandbox-files` на любом хосте роутер не открывает и в
  редиректах (`fetchable`): ссылка `share_file` из отчёта — публичная. Ищет
  их во всём URL, раскодированном до 8 раз, без невидимых символов и с
  разрешёнными `/./` и `/x/../`, и в каждом вложенном `http(s):` после
  `URL.parse`: прокси-читалки (`allorigins.win/raw?url=`,
  `r.jina.ai/https%253A…`) качали её сами. Это ловит лишь наивную инъекцию:
  ссылка `share_file` предъявительская (id и `sig`), по частям
  (`?a=<id>&b=<sig>`, `web_search`) её не видно; граница — без сети
  помощника в помеченном разговоре.
- Текст из файлов уходит отчётом: ход-отчёт может звать `task`, и помощник
  без метки, новый или продолженный, выносил бы данные в URL. Поэтому файл
  метит и разговор (`sandbox/person-files-conversations/…`), а в таком
  разговоре ребёнок уходит из сети (метка лишь песочницы), если ход человека
  за 5 минут не записал именно этот текст (`takePersonSend`, пишет
  `agent/hooks/task-files.ts`) или сообщение — steer. Запись — по sha256 текста
  (у старта — после «Caller message:» eve) и одноразовая: её занимает
  (`taken:`) ход ребёнка (сессия, id хода и `sequence`: в преемнике eve
  id ходов снова с `turn_0`), взявший её, и повтор его шага после рестарта
  находит свою отметку, а ход-отчёт с тем же текстом — чужую. Старт ещё
  назван id хода вызова (`parent.turn.id`): хосты нумеруют вызовы шага с
  `call_0`; `parent.turn.sequence` в ключ не входит — eve берёт его из
  состояния Бро при диспетчеризации, часто уже следующего хода.
  Эту проверку разговора, запись отправок человека, правило ссылок
  хода-отчёта и превью Telegram не выключают ни флаг, ни уход из пилота
  task-агента, ни Gateway (`taskFilesGuarded`, `conversationHoldsFiles` в
  `agent/lib/sandbox/pilot.ts`): данные файлов остаются в истории, флаг
  останавливает лишь перенос файлов. Поэтому при сбое S3 модель помощника
  отказывает в сообщении. `ctx.session.parent` у
  ребёнка навсегда от стартового вызова: id вызова и ход продолжения живут
  только в состоянии канала субагента eve, поэтому продолжение сверяется по
  `agentId`, который ребёнок выводит из `parent` как eve
  (`mintStartOperation`). Сбой чтения ничего не метит: модель ребёнка
  отказывает в этом сообщении, следующее проверяет заново; метка не
  записалась — отказывает до записи (`offlineRefusal`).
- В ходе-отчёте task-агента `send_message` не отдаёт серверам чужих URL:
  `link` и вложения, кроме ссылок `share_file` (`isSharedFileLink`), идут
  текстом — Telegram и iMessage качают вложение сами, веб грузит по URL.
  Правило и текст Telegram без превью — в разговоре с меткой файлов
  (`conversationHoldsFiles`), а при `TASK_FILES_WORKSPACES` — в любом. Его
  спрашивает каждая отправка Telegram любого воркспейса, поэтому сначала
  идёт листинг одного ключа под метками разговоров воркспейса
  (`max-keys=1`, `workspaceHoldsPersonFiles`), а не отдельная метка
  воркспейса: релизы #290/#300 писали только метки разговоров. «Есть»
  помнится навсегда, «нет» — 5 с (меньше пути от метки до отчёта: чтение
  файла, ответ ребёнка и шаг Бро), сбой — «есть» и минуту без запросов. Без S3 превью остаются, а ход-отчёт режет ссылки
  всегда (`reportTurnHoldsFiles`). Открыто: ход человека может переписать
  текст отчёта из истории в сетевую задачу или сам `web_fetch`; превью
  ссылки текста в iMessage.
- Субагент eve 0.62 берёт и свой `instructions/` рядом с `instructions.md`:
  `defineDynamic` там — `dynamicInstructions` манифеста, а `.md` в нём —
  статичная запись, поэтому текст строк о файлах — в
  `agent/subagents/task/instructions/content/` (читается не рекурсивно).
- gVisor работает и в облачной сессии (root, cgroup v1): `sandboxd` гоняют на
  настоящем `runsc` — `SANDBOXD_REAL_ROOTFS=<корень> go test ./...` в
  `sandbox/sandboxd`. Прямой URL релиза runsc отвечает 404 — ставить `.deb`
  из apt-репозитория gVisor со сверкой подписи и sha256.
- Хост песочниц для кода — `scripts/cloudru-code-host/` (имена `sbx-*`): VM
  или, в проде с 10.10, выделенный сервер рядом с браузерами (`host.py
user-data`, `sandbox/README.md`); runsc едет на хост объектом S3 (`boot.py vendor`), не
  из apt Google. gVisor не держит свой лимит памяти: память гостя лежит в
  cgroup, но не в RSS процессов, и OOM убивал весь `gvisor_sentry`. Поэтому
  `sandboxd` даёт cgroup запас и ставит заглушкам `oom_score_adj=1000`
  (`sandbox/sandboxd/memory.go`): умирает один процесс, код 137.
- Убийство `exec` (`killScript` в `sandbox/sandboxd/exec.go`) узнаёт процессы
  по `/proc/<pid>/environ`, а у процесса посреди `execve` оно пусто, пока
  читается бинарник (на Linux; фейковый runsc гоняет команды на хосте). Так
  `TestDrainKillsOpenExecs` раз в десятки прогонов CI оставлял `sleep` живым:
  он первый в пакете запускает `sleep`, и кэш диска раннера, видимо, холодный.
  Поэтому скрипт добивает и потомков помеченных процессов по родителям.
  Повтор без CI: холодный бинарник `sleep` в `/usr/local/bin` и
  `blkio.throttle.read_bps_device` на диск (cgroup v1).
- `app/` не импортирует `agent/` (правило `no-forbidden-layer-imports`):
  HTTP-ручки агента — маршруты каналов под `/eve/v1/` (`agent/channels/sandbox.ts`).
- `POST /eve/v1/session` отвечает `202` раньше `session.started`: владельца
  пишет обёртка маршрута (`agent/channels/eve.ts`), иначе ранний поток — 403.
- Коды входа (iMessage с линии Бро): Better Auth режет сам лишь по IP в памяти
  процесса (`/phone-number/*` — 10 в минуту, только при `NODE_ENV=production`) и
  номер не считает. Свой лимит — в базе (`sign_in_code_sends`,
  `db/services/auth/code-sends.ts`): номер 3 за 10 минут и 10 в сутки, адрес 10
  и 40. Проверка — в `hooks.before`, а не в `sendOTP`: эндпоинт пишет новый код
  до `sendOTP`, и отказ подменил бы код, который у человека уже есть;
  `/sign-in/phone-number` выключен — он слал код мимо лимита. IP верен: Caddy
  ставит `x-forwarded-for` одним адресом клиента, Next его не трогает (`??=`),
  а Better Auth верит лишь одиночному значению. Принятая цена: любой может
  исчерпать лимит чужого номера и закрыть ему вход по коду на 10 минут (сутки —
  при 10 запросах). Код, который iMessage не отправил, слот возвращает
  (`releaseSignInCodeSend`).
- `web_fetch` eve сам не пускает на приватные адреса: каждый редирект и каждый
  адрес из DNS (`execution/web-fetch/request.js`); после обновления eve это
  ловит `tests/agent/tools/web-fetch.test.ts`. Свои загрузки по URL от модели
  (`find_images`, вложения `send_message`) идут через `fetchPublic`, а не
  глобальный `fetch`: `isBlockedHost` смотрит лишь имя.
- `first-contact` решает `workspaces.introduced_at`
  (`claimWorkspaceIntroduction`), а не `chats`: переезд из Convex их не пишет.
- Любой сбой модели (и переполнение контекста) — `turn.failed`
  `MODEL_CALL_FAILED`; «скоро вернусь» — только при 402/429/5xx в `details`.
- Telegram на Cloud.ru — не вебхуком: мост `scripts/cloudru-app-host/tg-bridge/`
  (`getUpdates` → POST в локальный endpoint eve, не через Next: `proxy.ts`
  ведёт на `/sign-in`). eve отвечает `200` до хода и `update_id` не проверяет:
  offset и дубли — на мосте. `getUpdates` боевого бота при вебхуке — `409`.
  Принятое eve (`200`) до рестарта eve может пропасть, поэтому deployd перед
  рестартом eve останавливает мост (`bridge_paused`, README моста, «Что делает
  сервер»).
- `limits` eve кладёт в сессию при её создании: новый потолок входа
  (`agent/agent.ts`) живая сессия Telegram получит лишь со следующей, а живёт
  она 30 дней (`sessionTimeoutMs`). Без потолка eve после 40 млн входа ставил
  карточку Approve/Stop. На Vercel после деплоя ход сессии снова `turn_0`, а
  `usage_costs` молча теряет совпавшие ключи шагов: замер по ходам
  (`usage-stats.sh`) такие сессии исключает и считает.
- `eve info` 0.62 не печатает подключения: их видно в
  `.eve/compile/compiled-agent-manifest.json`.
- Эвалы в облаке без Gateway и Docker: `MODEL_PROVIDER=routerai` и
  `ROUTERAI_API_KEY` (OpenRouter без денег), Postgres от не-root
  (`setpriv --reuid=postgres`, данные в `/var/lib/postgresql/…`: в scratchpad
  `initdb` падает), `pnpm db:migrate` (нужен и `DATABASE_URL_UNPOOLED`) и
  `eve eval agent --tag <тег>` с `DATABASE_URL`,
  `BETTER_AUTH_URL=http://127.0.0.1:9`, `NODE_ENV=development`. Локального
  Бро запускайте через `env -i` с явным набором: в env сессии есть
  `SUPERMEMORY_API_KEY`, и память ушла бы в облачный индекс Supermemory.
  `agent` здесь — префикс путей: `eve eval agent <id>` гоняет весь набор.
  `eve dev` при старте продолжает незаконченные ходы из `.eve/.workflow-data`
  (и платит за них): прерванный прогон перед следующим уберите оттуда.

## Геолокация

- `LOCATION_WORKSPACES` (id или `*`; с 15.10 в проде `*`, владелец; откат — id владельца, не `null`), обзор — `docs/location.md`. `position`
  (где человек) ≠ `place` (место, о котором говорит): пересланное и булавки — `place`,
  venue — «вероятно там», только приход; `.loc.vcf` — `position` лишь по подписи
  текущего места (`agent/lib/location/vcf.ts`, список подписей не сверен с живой
  карточкой iPhone).
- В сообщении человека — только маркер `[геопозиция]`/`[место]`; адрес и попадания —
  строками `context` («Геопозиция:»), иначе адрес читался бы как слова человека.
  `onMessage` в сеть не ходит: reverse — фоном и только при свободном слоте.
- Трансляция: eve выбрасывает `edited_message`, правки несёт мост лишь при
  `TG_BRIDGE_LIVE_LOCATION=on` (`prod.json` → `/etc/bro/env`; код моста — только
  `host.py update-host`) на `/eve/v1/telegram-location`. Порядок: релиз eve с
  маршрутом → мост → флаг; без маршрута мост выбрасывает правку на 404 без повторов.
  В режиме вебхука трансляции нет. «Идёт» — правка `telegram_live` ≤ 10 мин.
  Троттлинг правок (геозона раз в 15 с) — в памяти процесса: верно при одном eve.
  `place` ждёт до `expires_at` во всех путях
  (`nextCheckOf`, возобновление, `heldCheck`). Попадание из сообщения — `suppressed`
  и строка в том же ходе: упади ход — напоминание потеряно. Ночью будит лишь `movedFar`.
- Журнал: строки контекста свёрнуты, результаты инструментов геолокации —
  `{"redacted":"location"}`, но ответы Бро (`[message] bro`) могут назвать адрес.

## Подписки на события

- Пилот `SUBSCRIPTIONS_WORKSPACES` (п. 27). Проверяет код, без модели: тик
  `agent/schedules/subscriptions.ts` раз в 5 минут (отдельно от `dynamic.ts`)
  берёт слежки, чей срок проверки подошёл, — каждая читается раз в 6 часов;
  находка, сбой третий раз подряд или конец срока — уже завершённый прогон
  скрытого задания `kind='subscription'`, отчёт везёт обычный `dynamic.ts`;
  ночью — по правилу `wake` (`agent/lib/subscriptions/delivery.ts`).
- Ссылку и порог `watch-create` берёт только из слов человека (`personMessages`
  и ответы `ask_question` в `said.ts`), снятых на `step.started`: на
  `turn.started` не видно ссылки, пришедшей посреди хода. Ход-отчёт task-агента
  несёт auth человека, поэтому нужен ещё `personWordsThisTurn(...).said`.
  Цену читает JSON-LD, meta и itemprop с публичного адреса (`fetchPublic`),
  текст страницы в модель не идёт.
- Откат пилота: убрать воркспейс из `SUBSCRIPTIONS_WORKSPACES`. Живые слежки
  тогда не удаляются, а стоят: тик их не читает и не шлёт новостей, истёкшая
  кончается молча, возобновить нельзя; вернули в пилот — идут дальше. Парсер
  цены идёт по чужим 2 МБ синхронно, `within()` его не прервёт: теги — через
  `indexOf` (`htmlTags` в `price.ts`); по всему HTML идут лишь линейные
  проходы (`asciiLower`, поиск `>` и концов `<script>`), регулярки разбора
  тегов — только на срезах до 4 КБ.
- Рейсы в пилоте — слежки `template='flight'`, каждая на своём скрытом
  задании (`kind='subscription'`), не на proactive. Заводит и закрывает их
  проактивная проверка (`syncFlightWatches`), только для своих рейсов
  человека (организатор, принял приглашение или `fromGmail`, номер рейса и
  аэропорт в месте — `isOwnFlight`). Напоминания (`evening`, `checkin`,
  окна — `dueFlightStages`, вечер по часам города вылета) проверка кладёт в
  свой же прогон с ключами `…#evening`: регистрация, открывшаяся ночью, уходит
  с утренней почтой одним сообщением. В выборке прогона (не больше 12) они
  первые, а сделанным пишется лишь унесённое прогоном. Тик подписок рейсы не
  берёт: их `next_check_at` — 9999 год. Время вылета, обычного открытия
  регистрации и выезда считает код (`flightFacts`, с оговоркой «обычно»);
  дорогу — только до `aeroway:aerodrome` и только для уходящего напоминания.
- Откат релиза до #277 при живых слежках рейсов: сначала удалить их задания
  (`DELETE FROM scheduled_agent_jobs WHERE id IN (SELECT job_id FROM
subscriptions WHERE template = 'flight')`, строки уйдут каскадом): код #277
  иначе покажет их в `schedules-list` как слежки за ценой. Проактивное задание
  они не трогают.
- Вечерняя почта в пилоте: с 21:00 проверка идёт как ночная
  (`eveningMailUntil`) — запуск только по срочному (тема о рейсе или
  безопасности, письмо с `IMPORTANT`, событие в ближайшие 12 ч), отметка
  стоит, и утро читает весь вечер одним запуском (d11: «утром одно сводное
  сообщение»). Ночная проверка пилота читает час назад: срочное письмо, чей
  прогон застал занятое задание, не ждёт утра.
- `usage_costs.run_id` фонового хода — id прогона расписания: «подписка без
  модели» проверяется суммой по прогонам её задания; сводка поручений
  (`summarizeUsageCosts`) строки `background` не считает.
- Посылки (15.10, тот же пилот): шаблон `parcel`, только Почта России
  (`agent/lib/subscriptions/parcel/`). Её JSON сайта
  (`www.pochta.ru/api/tracking/api/v1/trackings/by-barcodes`) отвечает с адреса
  Selectel без браузера и без ключа за 0,1–0,2 с, иностранному — 417 HTML;
  официальный `rtm34` требует логин (100 запросов в сутки при регистрации).
  СДЭК из России не читается ничем: сайт отдаёт 418 и JS-проверку антибота и с
  датацентра, и с резидентного выхода, `lk.cdek.ru` — за SSO, `api.cdek.ru` —
  ключ договора и только свои заказы. Для СДЭК нужен ключ агрегатора или
  браузер — решение владельца. Проверял зонд-VM в ru-3 (`sel.py up`).
- Слежка за посылкой не кончается на новости: итог `news` пишет отчёт и
  оставляет её активной, `done` (вручена) закрывает молча. Новость — только
  смена: новая ожидаемая дата, прибытие в место выдачи, срок хранения ≤ 2 дней
  (раз на дату; продление — снова), возврат или утрата (они закрывают). Номер
  из письма берёт код проактивной проверки: письма с доменов `pochta.ru` и
  `russianpost.ru`, тема и сниппет, один поиск Gmail по отправителю, днём и
  ночью. Письмо человеку уходит прогоном проактивности, поэтому слежка его не
  повторяет: первое чтение слежки из письма — точка отсчёта (с отметкой срока
  хранения), а слежку, чьё письмо унёс прогон, `noteParcelLetters` метит
  `letterPending`, и её следующее чтение — тоже отсчёт. Слежку из письма завёл
  Бро сам, поэтому при выключенных сообщениях Бро (`proactive_messages`) тик
  её держит, не читая. Откат на релиз без `parcel`: тик и `schedules-list`
  таких строк не видят, CHECK шире — откату не мешает.

## Яндекс Еда

- Корзина Еды: `add_bulk` прибавляет количество к блюду, уже лежащему в корзине; менять его — PUT `/api/v1/cart/<id позиции>`. Чтение корзины видит позиции только с `soft_multi=true` в query (`agent/lib/yandex/food/cart.ts`, `food.eda_cart_set`).
- Ссылку банка (3-D Secure) открывает только человек: открытие её в браузере
  Бро (12.10, проба) тратит сессию банка, вторая — «Invalid request», и Лавка
  отменила заказ. Окно подтверждения — около 6 минут.
- Карты аккаунта в Trust общие для сервисов, но Go держит их в
  `unverified_cards` (`card_antifraud`, `usable: false`), пока карта не
  проверена банком; веб Go сам не умеет (мост `goplatform.private.payments.verify`
  есть только в приложении). Проверка общая: после оплаты картой с 3-D Secure
  в Еде (12.10) та же карта в Go стала `available` и оплатила поездку, а Еда
  дальше списывала без 3-D Secure. Ссылку проверки даёт Trust:
  `create_verification_intent` с `service_token` Go (`trustToken` конфига
  страницы) и `binding_id` отвечает 201 с `form_url`, только если в
  `form_params` есть `integrationProfileId` (`yandex_default`, он же
  `profile.name` карты), без него — 400 «Validation failed» (`go.card_verify`
  в `agent/lib/yandex/go/card.ts`).
- После кода банка страница 3-D Secure сама уходит на Яндекс
  (`process_psp_3ds`): закрыть её раньше — деньги заблокированы, а Лавка
  платежа не видит (`wait_user_action`) и через ~7 минут отменяет заказ с
  возвратом (12.10).
- Заказ Еды (`agent/lib/yandex/eda/checkout.ts`, проверено вживую 12.10): страница
  `/checkout` не нужна. `POST /api/v2/cart/go-checkout` с адресом даёт предложения с
  картой и `requestId`; `POST /api/v1/orders` берёт цену только с `request_id`
  этого предложения (со случайным — 400 `OrderData` 59 «спрос вырос») и без
  заголовка `X-Device-Id` (любой, свой) отвечает 400 `UserData` 6. Оплата —
  опрос `eats-payments/v1/order/tracking`: `done`, `3ds_required` со ссылкой,
  `error`/`cancelled`. Отмена — `POST /api/v2/orders/<nr>/cancel`.

- Мини-онбординг Яндекса (12.10): `yandex` `account.ready` (`agent/lib/yandex/ready.ts`)
  сначала спрашивает вход у Яндекс ID (`status`): сессия Go входа не доказывает —
  у того, кто ни разу не открывал Go, `goSession` даёт `no_user_id`, а у анонима
  список карт пуст. Потом читает карты из `/3.0/paymentmethods` Go, а следующий шаг (вход по ссылке, ссылка банка
  через `yandex_purchase` `verify_card` только после «да», где привязать карту) несёт
  `reply` результата, а не промпт. Знакомство (`first-contact`) узнаёт о бете, боте
  багов (только при `bugBotTarget()` и `BUG_BOT_USERNAME`, иначе — ни слова) из контекстной строки
  `firstContactContext`; условий, приватности и ссылок в знакомстве нет (владелец 12.10).

## Composio: Google, Notion, Slack и другие приложения

- Адрес возврата карточки входа eve строит от базы мира, а на VM это loopback
  (`WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4274`): браузер человека попадал
  на свой 127.0.0.1. В Composio уходит адрес сайта (`publicCallbackUrl` в
  `agent/lib/composio/authorization.ts`), `/eve/*` Caddy отдаёт eve.
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
- `apps` — белый список с проверкой подключения, сохранённых запретов и
  режима Google только на чтение. Порученные чтения и изменения в интерактивном
  ходе и продолжении браузерного отчёта идут без карточек; фоновые работники
  новых действий не разрешают (`agent/tools/apps.ts`, `agent/lib/mode.ts`).
- Карточка входа паркует весь ход, поэтому Slack, Notion и `apps` ставят её,
  только если человек назвал приложение в этом ходе (`appsNamedByPerson`).
- Третьему лицу Бро пишет только письмом и в Slack; `contacts-search` отдаёт
  `canMessageVia`, иначе Бро предлагал «SMS или Telegram?».

## Ход и доставка

- Самостоятельность (владелец 14.10): общий принцип — раздел «Сначала сам, потом
  человек» в `autonomy.md` (добудь или сделай недостающее сам, держи цель, а не
  шаг, препятствие обходи сам). Пример провала — регистрация на Product Radar:
  Бро просил прислать слайды и «говори „грузи“». Ядро пилота навыков упёрлось в
  10k токенов, поэтому раздел заменил в ядре строки «Первым делом», «Недостающую
  деталь» и «Не останавливайся» из `role/interactive.md` (в полной версии они есть).
- Бро для человека — один, от первого лица (правило в `message-style.md`, повтор в `completion.ts` и нотах `browser_task`): без «помощника», «запуска», «браузера» как отдельного исполнителя. Страховки в `send_message` нет: человек сам говорит «браузер».
- Ссылку входа модель копирует с ошибками (10.10: хвост длинного id потерян).
  `send_message` подменяет любой `…/handoff/<id>` в тексте на последнюю ссылку,
  которую выдал `site-login-link` (`agent/lib/login-handoff/exact-link.ts`).
  Не полагайтесь на то, что модель перепишет ссылку верно.
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
  Переспрос другими словами (вопрос и сразу второй о том же) кодом не режем
  (владелец 15.10, закрытый #466): правило по общим словам глушило ответы,
  поправки сумм и второй пузырь знакомства, а лишний вопрос безвреден.
- Скорость ответа (11.10, по журналу eve прода): обычный ход — 3 шага модели
  по ~3–5 с (~50k токенов входа, кэш 98%), человек ждёт шаг 0 + инструмент +
  шаг с `send_message`; третий шаг (текст после отправки) он не ждёт. Долго
  чаще из-за инструментов: yandex 6–11 с, yandex_purchase 15–23 с, phone-call
  15 с. Ход без инструментов с 1000 знаков reasoning на шаге 0 — 9 с.
  `FAST_REPLY_WORKSPACES` выключает reasoning на всех шагах хода человека
  (`agent/lib/delivery/fast.ts`). Замер DeepInfra, 36k токенов, forced
  `send_message`, кэш: reasoning `low` 3,2 с (разброс 2,9–6,7), `off` 2,8 с
  (2,4–3,4); прирост растёт с длиной рассуждений. Кэш DeepInfra раздельный
  для `low` и `off`: первый `off` после простоя читается без кэша. Together
  быстрее (шаг 2,3–2,8 с), но в 4 из 8 замеров промах кэша по 1,3 ₽ вместо
  0,07 ₽ — закреплять его для всех не стоит.
- Heads-up пилота доходил только на 13,9 с (11.10): ответ RouterAI читается
  целиком до передачи eve (`routerai/fetch.ts`), а eve исполняет инструменты
  шага после его конца, поэтому `send_message` в одном шаге с длинным
  `browser_task` ждал генерации всего task. `EARLY_REPLY_SPLIT_WORKSPACES`
  просит heads-up отдельным шагом (`earlyReplySplitNote`): на стенде 3 из 3,
  2,2–3,9 с вместо 3,9–15 с. Стримить мимо буфера нельзя без потери повтора
  упавшего хоста: сбой часто приходит в конце ответа.
- С 11.10 в проде `FAST_REPLY_WORKSPACES`, `EARLY_REPLY_WORKSPACES` и
  `EARLY_REPLY_SPLIT_WORKSPACES` — `*` (владелец, сразу всем). Живой замер на
  аккаунте владельца до → после: «что ты помнишь обо мне» 40,5 → 3,5 с,
  поиск цены 16,5 → 4,7 с до первого сообщения, heads-up 13,9 → 3,2 с. Первый
  ход после рестарта eve читает без кэша (~12 с): кэш `off` холодный. Откат —
  вернуть id владельца или снять флаг в `prod.json` и `host.py env`.
- Пилот `EARLY_REPLY_WORKSPACES`: первое сообщение хода человека — одна
  строка до 120 знаков «сейчас поищу» — уходит, а не на `status`. От ответа
  её отличает текст результата `headsUpDeliveredNotice`: по нему
  `awaitsDelivery` держит шаг форсированным, а `turnSends` кладёт её в
  `headsUps`, не в `delivered`. Канал помечает ход доставленным уже на ней:
  Telegram гасит «печатает…» и не постит ответ текстом — только `send_message`.
- Модель писала `DELIVERY_COMPLETE` (метку «ответ уже доставлен» из
  инструкций) в сам `send_message`, и человек получал её сообщением:
  `withoutBookkeeping` в `agent/tools/messaging.ts` вырезает её и
  `<eve-empty-delivery/>`, отправка из одной метки — пропуск `sentinel`.
- Одобренный на карточке вызов AI SDK выполняет после `step.started`:
  `send_message` шага его не видит, а вызов мог упасть (`approvedPending`).
- В ходе-отчёте браузера до сообщения с итогом нет инструментов с карточкой
  (`browser-report.ts`): карточка парковала ход до засчёта отчёта. В пилоте
  шага набор хода постоянный (`reportTurnTools`), а три его карточки
  отказывают в approval и в execute (`reportCardHold`: состояние хода
  `holds.ts` или `reportDeliveredAt`). AI SDK решает approval всех вызовов
  шага до первого execute: карточка в шаге сообщения получает отказ
  (`tests/agent/tools/report-cards.test.ts`).
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
- С `CLOUDRU_FM_API_KEY` (свой ключ Foundation Models API: IAM-ключ — 400
  «invalid api key secret») чат RouterAI без `plugins` при сетевой ошибке,
  молчащем соединении или 500/502/503/504 (и внутри HTTP 200) уходит в
  Cloud.ru FM, затем 5 минут сразу туда, потом один пробный вызов в RouterAI
  (`routerai/fallback.ts`, на процесс; 4xx не переключает). Теряются
  веб-поиск, цена шага (нет `usage.cost` — шаг `unpriced`), закрепление хостов
  и кэш DeepInfra, `reasoning`; модель — `CLOUDRU_FM_MODEL` для любого
  воркспейса. Отказ FM возвращает сбой RouterAI («скоро вернусь»). Ключ —
  только сервисного аккаунта в области проекта, иначе FM отвечает 401
  «Please create service account on the project scope»; IAM-токен проекта
  пускает лишь в `GET /v1/models`. Владелец 04.10: FM пока не заводим — ключа
  нет, запасной путь спит; код не убирать и ключ не искать.
- RouterAI — единственный провайдер прода, 402 «Insufficient balance» не
  переключает и на FM: при пустом балансе Бро молчит всем (03.10 — дважды).
  Баланс — `GET /api/v1/credits` ключом прода (рубли) или пробный ход
  драйвера бенчмарка: в журнале eve 402 видны лишь у прошедших ходов и в
  длинном хвосте (`--lines 20000`). Ключ, а не сервис, сломан, если
  completions и `/credits` отвечают 500
  `internal error`, `/models` — 200, а заведомо неверный ключ — 401: помог
  новый ключ из кабинета. Ключ из env облачной сессии может быть тем, мёртвым.
- `ROUTERAI_API_KEY` облачной сессии приходит в типографских кавычках:
  `/api/v1/credits` без их снятия отвечает 401, хотя ключ рабочий. Снимайте их
  Python (`str.strip("“”")`), не `tr`: тот режет байты, остаток UTF-8 даёт 500
  `internal error` на всё — как у мёртвого ключа (15.10).
- С 11.10 чат-вызовы `deepseek/deepseek-v4.1-flash` идут сначала в RunInfra
  (`RUNINFRA_API_KEY`, `agent/lib/model/routerai/runinfra.ts`): первый токен
  0,9–1,0 с против 2,3–2,9 с у RouterAI, шаг с кэшем ≈0,11 ₽ против ≈0,04 ₽.
  Любой сбой RunInfra (сеть, не 2xx, `error` в ответе) отдаёт тот же вызов
  RouterAI и на 5 минут выключает RunInfra; поиск (`plugins`), другие модели и
  сырые вызовы — только RouterAI. Цена RunInfra в долларах, в `usage.cost`
  она уходит рублями по `USAGE_USD_RUB`. Откат — убрать ключ из `prod.json`.
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
- OpenInference (03.10), как только в истории есть вызов инструмента, кажет
  модели 2–4 инструмента из 34: Бро отвечал «инструмента сохранения нет», и
  e2e памяти падал на любой ветке. Он в `brokenHosts`; новую причуду хоста
  проверяйте повтором тела шага на `provider.only` каждого хоста.
- Форсированный вызов часть хостов декодирует грамматикой по порядку схемы: у
  `send_message` порядок ключей модели (`kind`, `replyTo`, `text`), в
  форсированном шаге `text` обязателен (в пилоте шага — в каждом), корню
  `oneOf` дописан `type: object`.
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
- Роутер моделей (14.10, пилот `MODEL_ROUTER_WORKSPACES`, `agent/lib/model/router/`):
  вид задания task-агента читает Jev (`typesafe/jev-1.13`, `POST /systemone`
  RouterAI; `questions` — объект, не массив) раз на сессию, 0,7–1,7 с и ≈0,004 ₽,
  и шлёт задание по маршруту `TASK_AGENT_ROUTES`. Своих маршрутов нет, без них
  Jev не зовётся: 14.10 Haiku 5.5 делал слайды не лучше DeepSeek (3 живых
  задания, 0,7–0,9 ₽ против 0,45–0,83 ₽), а Sonnet 5.5, Gemini 4 Argon и GPT-6.1
  Sol решили задачи с ловушкой (ипотека, встреча через часовой пояс, договор с
  допсоглашением) так же верно, как DeepSeek, в 10–30 раз дороже за ответ.
  Флагман окупается разве что повтором провалившегося многошагового задания.
  Ход самого Бро не переключается: +1 с к каждому ответу и холодный кэш чужой
  модели на ~50k истории. Anthropic кэширует, только если просить:
  `cache_control` верхнего уровня (`extraBody` в `direct.ts`), иначе каждый шаг
  Haiku — полная цена входа.
- Роутер инструментов (`TOOL_ROUTER_WORKSPACES` — id или `*`; `TOOL_ROUTER_MODE`
  `shadow` по умолчанию | `on`; нужны пилоты навыков и шага, `toolRouterEligible` в
  `agent/lib/tool-router/pilot.ts`). С 15.10 в проде всем: `*` у
  `TOOL_ROUTER_WORKSPACES`, `SKILLS_WORKSPACES`, `STEP_CONTEXT_WORKSPACES` (и
  `LOCATION_WORKSPACES`), `TOOL_ROUTER_MODE=on`. Откат — id владельца (не email: у
  навыков и роутера он валит проверку env, и eve не стартует) в `prod.json` и
  `host.py env`; `null` снимает имя совсем (`compose_env`), выключая пилот и
  владельцу. `TOOL_ROUTER_MODE` один на всех: владельца в `on`, а прочих в `shadow`
  не держать. ход человека видит ядро
  (`agent/lib/tool-router/groups.ts`) и группы, которые Jev выбрал одним запросом System One
  (14 вопросов `noul`, `questions.ts` — дословно из оценки, правка слова — новый прогон и
  пороги). Набор хода только растёт; в окне 60 мин от последнего шага с блоком роутера —
  объединение с прежним (кэш RunInfra живёт ≥ 40 мин, 15.10), сбой — все группы без смены
  базы. В `shadow` ничего не ждётся и не скрывается: смотрите `[tool-router] shadow-result`
  (`missed`) и `shadow-decision`, в `on` — `hidden-call` и `cannot`. Выбор роутера — не
  авторизация: «группа не открыта → человек не просил» не выводите, скрытый инструмент
  исполняется по имени через свои approval/execute. Откат — `shadow` или снять флаг.
  С решением Jev навык нескольких групп (google, apps, recommendations…) даёт лишь выбранные
  Jev из своих, а если ни одной — все (`triggerGroups`, в логе `narrowed`); `first-contact` не
  сужается. Фолбэк Госуслуг в почту и на Диск идёт в ходе-отчёте браузера, его роутер не трогает.
  В `shadow` набор не сужается: что спрятал бы `on`, пишет `narrowed` в `shadow-decision`, и
  `missed` в `shadow-result` без него завышает полноту `on`.
  `places` открывают и слова о своём месте («когда приду на…», «где я», «мои напоминания
  у мест», `agent/lib/location/phrases.ts`): Jev 1.13 15.10 не дал группы ни напоминанию у
  адреса, ни просьбе показать напоминания у мест (модель сначала звала `open_tools`).
  Просьба «напомни, когда приду/уйду» ещё и даёт строку `context` о `place_reminder`: модель в 2
  из 4 живых ходов сначала грузила навык подбора мест и открывала уже открытые `places`. Навык
  велела грузить записка самого роутера (`routerSkillNote`, `places` → recommendations): у
  `places` её больше нет — инструменты мест в ядре навыков и на блок не ссылаются. Записку
  получает лишь группа, чьи короткие описания отсылают к блоку навыка.
- Jev 1.14 есть только у TypeSafe (`jev-1.14.0`; `jev-1.14` — 400 «Unknown model»), у
  RouterAI — 1.13 (`typesafe/jev-1.13`, отвечает `typesafe/jev-1.13-20260917`): клиент
  (`system-one.ts`) зовёт TypeSafe и через 250 мс тишины — RouterAI, пороги берёт по имени
  модели **из ответа** (`decision.ts`). Без последнего сообщения Бро полнота на настоящих
  ходах 0.79, с группами вызовов за 60 мин — 1.0. Скрипта оценки в репозитории нет (ходы
  владельца туда не кладутся): новый прогон — ходы с группами вызовов (`shadow-result`,
  `missed`), вопросы `questions.ts` дословно и полнота по каждому порогу.
  Ответ на `ask_question` меняет строку состояния, и следующий шаг спрашивает Jev снова.
- TypeSafe отвечает VM прода в России **451** (страна закрыта, 15.10). Через `TYPESAFE_PROXY_URL`
  (выход США, как `AGENTMAIL_PROXY_URL`) Jev 1.14 отвечал за 0,6–0,7 с, а RouterAI 1.13 — за
  0,5–0,6 с при той же оценке: владелец оставил RouterAI, `TYPESAFE_API_KEY` в `prod.json` нет
  (без ключа роутер сразу идёт в RouterAI, без хеджа). 451 держит TypeSafe час и тревожит
  владельца, как отказ ключа (`refusedStatuses` в `system-one.ts`).
- Картинки с 14.10 — MAI Image 2.6 Flash: 2,13 ₽ против 3,73 ₽ у Gemini Lite Image,
  16–33 с против 5–10 с; 9 живых проб с русским текстом — у MAI дубль «18:00» в
  2 из 3 приглашений, у Gemini выдуманный адрес в 3 из 3; Seedream 5.0 Flash
  писал «раждения» 3 из 3. Модель с русским текстом проверяйте несколькими
  пробами, одна удачная ничего не доказывает. Видео (`generate_video`, с 14.10 всем; `VIDEO_WORKSPACES=off` — откат, список id — только им): RouterAI
  `POST /videos` → опрос `polling_url` → `content`, ключ — только на хост API;
  HeyGen Video 1 — 1,96 ₽/с, 5 с за 18–29 с, фото первым кадром (`frame_images`).
  Клип лежит в `generated_image_artifacts` как `video/mp4`, Telegram шлёт его
  `sendVideo`; веб-чат показывает ссылку-файл. Повтор шага посреди ожидания
  платит второй раз: задание пишется лишь готовым.
- Слабые модели заполняют каждый необязательный параметр: пустое и `*` там —
  пропуск (`givenScope`). gpt-6-luna после доставки отвечает пустым шагом, и eve
  валит ход — `quietEndMiddleware` меняет его на `<eve-empty-delivery/>`.
- Шаблон чата DeepSeek склеивает все системные сообщения в начало промпта:
  «последнее» системное (пометка шага) стоит перед историей и рвёт кэш.
  Состав шага меряет `scripts/costs/step-context.ts` (`docs/agent-costs.md`, 3.2).
  За флагом `STEP_CONTEXT_WORKSPACES` (с 15.10 в проде `*`) время и записки идут после истории
  тегом `<bro-step-note>` (`agent/lib/step-context/`), а его подобия в
  остальном промпте обезвреживаются (`defuseStepNoteTag`); новые опции
  `modelSelection` добавляйте только под флагом — тесты `agent.test.ts`
  сверяют опции целиком.
- Пилот `HISTORY_TRIM_WORKSPACES` (пункт 28 роадмапа) шлёт модели старые
  результаты инструментов, длинные `task` у `browser_task` и отчёты браузера
  кратким следом (`agent/lib/history/`); история eve и её читатели видят всё
  целиком. Граница старого сдвигается лишь раз в 8 ходов сверх 4 последних:
  между сдвигами префикс промпта кэшируется. Всё решение — по пачкам из 8
  ходов, и пройденная пачка не меняется: id вызова, что встречается в своей
  пачке дважды (`call_0` OpenRouter и старого RouterAI), не урезается никогда,
  а id, уже занятый прошлой пачкой, урезается лишь там (в промпте — только
  первая часть с id). Иначе повтор id через 8 ходов возвращал целым уже
  урезанный результат, и провайдер перечитывал историю. Сообщения человека
  без ответа Бро между ними — один ход; сообщение, пришедшее в ход после его
  первого шага, держит память процесса (`turnTrims`), после рестарта eve
  граница может сдвинуться раз посреди хода. Урезаются лишь результаты
  читающих инструментов и `browser_task`, и никогда — с `error` или
  `status` `failed`/`refused`: в результате записи может быть единственный
  след сделанного, а «вызови снова» у неудачной записи повторило бы её.
- Сжатие eve внутри хода ломает читателей хода: `withResumptionGuard`
  дописывает копию старого текста человека, и она читается как открывший ход
  (`agent/lib/compaction/turn-start.ts`). Пилот `COMPACTION_WORKSPACES` сжимает
  лишь на шаге 0, когда открывший ход текст (не фото, не отчёт task-агента, не
  `context.*`) — последний (`compactsAtTurnStart`); ручной
  `attachSession().compact()` динамической модели Бро не работает. История
  сжатой сессии переписана навсегда (веб-чат читает события, его это не
  трогает); `COMPACTION_INPUT_TOKENS` меньше 100k валит проверку env на старте.
- Что сжатие сделало с ходом (`none`/`start`/`inside`), пишет хук
  `agent/hooks/turn-compaction.ts` в состояние сессии eve
  (`agent/lib/compaction/record.ts`): переживает рестарт eve и шаги на другом
  инстансе Vercel. Порядок в шаге: резолвер модели → хук `step.started` →
  резолверы инструментов → `maybeCompact` (`tool-loop.js`). Дошло ли
  сообщение хода до истории, решает не `message.received` (его eve шлёт и для
  текста, взятого ответом на вопрос или карточку), а история на шаге 0:
  резолвер модели зовёт `recordStepHistory`. `compaction.completed` eve шлёт
  и без новой сводки (лишь переставив записи памяти или урезав старые
  результаты): хук пишет заявку, а сжатием она становится, только если
  сводка в истории сменилась (`summaryDigest`) — решает резолвер модели
  следующего шага или читатель по своей истории. При `inside` и без записи, но с
  маркером сводки, слов человека нет (`form_of_address` не сохраняет), вид
  хода — из записи или наименьший набор; история без маркера читается как
  прежде, для всех, не только пилота: eve сжимает и сам, у края окна. Ход без
  своего сообщения после `inside` и ход после ручного `compact` (он идёт под
  id следующего хода) — тоже `inside`. Что шаг 0 прочёл до сжатия `start`
  (вопрос об оплате, `heard`, вопросы расписаний), держит память инстанса
  (`turnMemory`, перезапись при `none`: преемник снова с `turn_0`): без неё
  читатели лишь отказывают; письмо «на вы» ищется и в соседних сообщениях
  (`nearby`), которые сжатие отрезало от `said`. Пока после сводки нет
  результата инструмента, `said` идёт назад лишь до открывшего ход, чей шаг 0
  её написал (`summaryOpener`; без записи — только своё): после упавшего хода
  eve хранит сжатую историю, и старый код стоит вплотную к новому сообщению.
  После хода, сжатого `inside`, `said` — только открывший ход (`afterInside`):
  копия охраны стоит после оставленных результатов, и они её не отрезают.
- Порог задаёт окно, которое сообщает шаг (`agent/lib/compaction/window.ts`).
  Вызов сжатия пишет `compactionCallMiddleware` ключом `compaction:` с id
  ответа провайдера: повтор шага сжимает тем же промптом, и платят дважды
  (`usage-stats.sh` считает шагами лишь `step:`); после сбоя сводки сессия
  сутки без пилота (`compactionHeld`), 429/5xx — лишь на последней из трёх
  попыток AI SDK.
- «Одна история поверх каналов» (п. 28, `CROSS_CHANNEL_WORKSPACES`) — не
  общая сессия: в eve 0.62 `alias()` не выходит из пространства имён канала.
  Сводка другого канала — user-сообщение хода с `kind` не `user`: «просьбу
  хода» берите только из `kind: "user"` (`requestText` в `profile.ts`).
  Срок 14 дней держит только `memory-history`, и при `EVE_SCHEDULES=off`.
- e2e-набор идёт без пилотов (как прод). Пилот, нужный одному тесту,
  включайте email-записью в `e2e.config.ts`, а тест ставит её своему
  человеку в базе (`e2e/chat/cross-channel.e2e.ts`): у раннера нет env на
  тест, а вторая цель гоняла бы весь набор дважды.
- Блок инструментов идёт до истории: смена набора или схемы внутри хода
  перечитывает всю историю. В пилоте шага ход держит один набор
  (`agent/lib/turn-kind/tools.ts`), снятое прежде правило — отказ в approval
  и execute с «не сделано»; убирать можно лишь `ask_question` (eve делает
  карточку по имени) и действия, ждущие ответа (`defineState` в approval не
  проверен в `eve dev`). Хэш блока — `[tools]` в логах; вне пилотов байты
  стережёт `tests/agent/tools/flag-off.test.ts`.
- В пилоте навыков ход человека видит инструменты домена (google, apps,
  money, schedules) лишь с его навыком (`agent/lib/skills/tools.ts`): новый
  инструмент впишите в таблицу групп, иначе он в ядре. Короткое описание —
  только при `skillsLayout(ctx) === "core"`, параметры те же, а снятое
  правило — в теле навыка (`body-only`, `tests/agent/skills/tools.test.ts`).
  Схему выбирайте тернарником в `inputSchema` резолвера: eve делает из него
  durable-схему с замыканием. Тело навыка, называющее инструмент чужой
  группы, пишет рядом `load_skill <группа>` или даёт его через
  `toolSkillExtras` (тест в `agent/lib/skills/tests/tools.test.ts`). Группа,
  открытая лишь словами сообщения, пришедшего посреди хода, в следующем ходе
  пропадает: слот прикладывает блоки только на `turn.started`.
- Знакомство (`first-contact`, `role/interactive.md`) предлагает позвонить
  человеку сам (`phone-call`), если его номер `active` по `phone-status`; текст
  правят вместе с хэшами промптов в `tests/agent/skills/flag-off.test.ts`
  (новые значения печатает упавший тест).
- Строка `<!-- …` в `agent/instructions/content/` — только маркер навыка
  (`skill:`, `body-only:`, `core-only`, `full-only`), иначе каталог падает
  при загрузке. Ядро держит `tests/agent/skills/core.test.ts` (≤ 10 тыс.
  токенов, запаса почти нет): новая строка ядра — за счёт другой, а
  укороченную сверьте с фразами `bodies.test.ts`.
- id хода eve — `turn_N`, счётчик своей сессии (и заново с `turn_0` в
  преемнике): кэш вердикта пилота — по сессии и ходу
  (`pilotVerdictOfTurn`), состояние хода — с id запуска. Строку
  `report_delivered_at` ставит и `browser_task status`: карточки отчёта в
  пилоте верят лишь `send_message` хода и строке на начало хода
  (`openReportTurn` в хуке `browser-run-report`); ответ на карточку eve
  ведёт новым ходом.
- `GET /api/v1/credits` — только management-ключ (`OPENROUTER_MANAGEMENT_KEY`).
  Плагин `web` без `engine` у `openai/*` медленный и без ссылок: берём `exa`.
- Результат инструмента модель пересказывает человеку: имя провайдера, статус и
  текст его ошибки («RouterAI 402 Insufficient balance») в результат не кладите.
  Модели достаётся нейтральная причина, подробности — в `console.warn`
  (`WebSearchError.reason` в `agent/lib/web-search/search.ts`, `generate_image`).
- Timepad (`timepad_events`, 14.10): есть, только когда задан `TIMEPAD_API_KEY`
  (prod.json), и лишь в интерактивных ходах; только чтение. Cloudflare API Timepad
  отвечает «403 forbidden» на HTTP/1.1 (`fetch` Node, `curl --http1.1`) при любых
  заголовках и пускает HTTP/2: инструмент ходит через undici `allowH2`. Прокси
  облачной сессии HTTP/2 из undici не пропускает — живую проверку делайте curl.
  Границы дат Timepad читает как московское время, зону игнорирует (`…Z` давал
  события на 3 ч раньше): границы — с `+03:00`.
- `web_fetch` помнит отказ хоста лишь в разговоре: память инстанса закрывала
  сайт всем. Ограничитель Nominatim и OSRM — на инстанс, общего нет
  (`agent/lib/routes/openstreetmap.ts`).

## Vercel

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
- Env Vercel действует лишь со следующего деплоя, а до прода на VM не доходит
  вовсе (раздел «Прод на VM»). `BETTER_AUTH_SECRET` и
  `SECRET_ENCRYPTION_KEY` в env `bro-next` нет: развёртывание Vercel читает их из Blob
  (`db/services/installation-secrets.ts`); вне Vercel задавать те же значения
  (`installation-secrets.json`, сверен с Blob 02.10), новые разлогинят всех и
  закроют сейф. Пока это чтение есть, `BLOB_*` остаётся в `turbo.json`:
  без него `pnpm start` не видит ключа Blob.
- Картинки и вложения — в S3 под `artifacts/<storage_pathname>`
  (`shared/object-storage/artifacts.ts`). Cloud.ru отвечает 304 без `ETag`:
  маршрут берёт ETag из запроса. 404 и у пропавшего бакета: отсутствие —
  лишь `NoSuchKey`. Срок — на ответ и на каждое чтение тела, не на всё тело:
  медленный клиент тянул бы 10 МБ дольше минуты. Node в облачной сессии ходит через прокси
  только с `NODE_USE_ENV_PROXY=1`, и прокси изредка рвёт соединение («fetch
  failed») — скрипты повторяют запрос (`scripts/cloudru-app-host/blob-to-s3.ts`).
- Ключ песочницы сессии eve без `bootstrap` и файлов workspace не зависит от
  текста `agent/sandbox.ts` (`sourceHash` входит лишь в план `bootstrap`,
  `runtime/sandbox/keys.js`), но зависит от имени бэкенда: смена
  `AGENT_SANDBOX` заводит каждой сессии новую песочницу без старых вложений.

## Браузерные поручения

План перехода — `docs/browser-cloud-migration.md` (итоги проверок — раздел
12): свой браузер по запросу с постоянным профилем (VM Cloud.ru, с 10.10 — выделенный сервер Selectel), общий Бро не
копируем в VM. Человеку браузер не показываем: коды и согласия — только в чате
(исключение — окно входа по ссылке, ниже и `docs/login-handoff.md`).
Сторона VM — `browser-vm/` (worker, образ), пилотный стенд — `scripts/cloudru-browser-pilot/`.

- Инфраструктура браузера — в `docs/browser-infra-notes.md`: работаешь с
  `browser-vm/`, `agent/lib/browser-vm/`, `agent/lib/browser-pool/`, Cloud.ru
  или стендом — сначала прочитай его. Там же ключи и квоты Cloud.ru, выход VM
  в сеть, выкат worker, env пула и `BROWSER_STATE_KEY` (не менять никогда).
- Cookie без срока (session cookie) Chrome выбрасывает при каждом запуске, а
  парковка runc и загрузка VM — холодный старт: такой вход пропадал. С 09.10
  образ ставит `RestoreOnStartup: 1`, а worker закрывает восстановленные
  вкладки (`close_restored_tabs`); действует лишь с нового образа или корня
  пула. Не переписывайте cookies в «вечные»: срок входа решает сервер сайта.
- Вход по ссылке (`LOGIN_HANDOFF_WORKSPACES`, 09.10): человек сам входит на сайт
  в окне браузера Бро, `docs/login-handoff.md`. С 10.10 — для всех воркспейсов,
  флаг не задан = включено, `off` = откат; нужен пул (`BROWSER_BACKEND=pool`).
  Это исключение из «браузер человеку не показываем»: только вход, только по
  ссылке из его слов. Worker шлёт ему лишь картинку, принимает лишь `tap`/`text`/`key`
  (сырой CDP человеку не отдавайте: через него читаются все cookie и файлы
  профиля), а токен `ses: "h:<id>"` `authorize` пускает только в сокет окна.
  `Page.startScreencast` в headless Chrome кадров статичной страницы не шлёт —
  окно снимает страницу `captureScreenshot`. Тест на настоящем Chrome —
  `BRO_HANDOFF_CHROME=<chrome> python -m unittest test_handoff` в
  `browser-vm/worker`.
- API сервисов Яндекса (`yandex`, флаг `YANDEX_API_WORKSPACES`: id или `*`, без
  писем): запрос делает сама страница во вкладке браузера пула, cookies не
  читаем и не возвращаем. Транспорт — `agent/lib/yandex/transport.ts`: вкладка
  `createBrowserVmBrowser({ wake: true })` (будит песочницу как ход человека,
  до 30 с), `callInPageOverCdp` (`browser-use/cdp.ts`) открывает origin
  операции и зовёт её **фиксированную** функцию через `Runtime.callFunctionOn`,
  аргументы — данными, не строкой кода. Операция — `defineYandexOperation`
  (`operations.ts`), сервис подключается одной строкой в `registry.ts`. Страница
  может ходить только на свой origin (CSP id.yandex.ru закрывает чужие
  `fetch`): каждый сервис — своими операциями на своей странице. Инструмент —
  только в ходе, открытом сообщением человека (`agent/tools/yandex.ts`);
  `access: "cart"` требует отметки модели `personAskedToChangeCart`.
- Прямые покупки Яндекса — отдельный `yandex_purchase` и дополнительный флаг
  `YANDEX_PURCHASE_WORKSPACES` (нужны оба флага), пока только поддержанная
  корзина Лавки. Вопрос с точным итогом проверяется по доставленному сообщению
  и ответу человека, не отметке модели. `yandex_purchases.submitting/unknown`
  нельзя повторять или освобождать по TTL: запрос мог создать заказ.
  API и браузер делят `lockWorkspaceSpending`; у продолжения браузерного
  поручения переносите существующую резервацию до внешнего вызова, иначе
  reconciler старого run может снять защиту в промежутке.
  Пилотный `pending:dispatch:` не освобождается по TTL или старому outcome;
  queue/captcha принимают только найденный запуск своей попытки, не повторяют
  create после пустого поиска. Флаг выключения не снимает уже созданный fence.
  Номер заказа не доказывает оплату; границы проверки — `docs/yandex-api/purchases.md`.
- С 11.10 владелец включил `YANDEX_API_WORKSPACES=*` и
  `YANDEX_PURCHASE_WORKSPACES=*` для всех. При параллельных выкатах старый
  `prod.json` уже возвращал пилот: перед изменением env восстановите свежее
  операторское состояние и сверьте его render hash с `GET env`; после выката
  сохраняйте оба `*`, не перезаписывая остальные актуальные настройки.
- Живой взгляд на сервисы Яндекса из браузера пула владельца (поиск API,
  проверка операции) — `scripts/cloudru-app-host/yandex-probe.py <VM> spec.json`:
  `{workspace, op, args}` зовёт операцию реестра, `{workspace, page, steps}`
  пишет fetch/XHR страницы с телами. Результат — через S3, не в журнал job.
  Бандлу ops с кодом браузера нужен `--loader:.md=text` (тексты навыков `?raw`).
- Заказ Go (11.10) — одна операция `go.book` в одной вкладке: suggest →
  finalsuggest → routestats → orderdraft → ordercommit (на 202 коммит шлётся
  снова, как на сайте; draft — никогда). Защита от второй поездки — текущий
  заказ в `/3.0/launch` самого Яндекса, а не таблица (история заказов поездку в
  поиске не показывает — так `go.ride` 11.10 её не увидел): прежние фазы в
  `yandex_purchases` при сбое навсегда блокировали все покупки воркспейса.
  Отмена — `taxiontheway` с `break: "user"` (`go.cancel`); проверено вживую.
- Go использует общий native-кеш CSRF в `localStorage` (`csrf_token`:
  `token`, `validUntil`, запас 60 с). Безусловный `/csrf_token` перед каждой
  фазой добавлял точку отказа даже при живом токене. `net::ERR_TUNNEL_CONNECTION_FAILED`
  не означает отказ API: проверяйте отдельно CONNECT прокси и HTTP-ответ сервиса.
- `401 INVALID_CSRF_TOKEN` Go не означает потерю входа: нативный клиент обновляет
  CSRF, а cookies остаются. В Bro обновление и повтор разрешены только чтениям,
  не draft/commit. API-контекст Go — его статическая страница на том же origin:
  запуск полной SPA дополнительно шлёт launch и параллельные запросы авторизации.
- Лавка может вернуть `create_orders_disabled` на submit даже при
  `availableForCheckout: true`. Готовая корзина не доказывает доступность
  оформления; общий HTTP 400 после dispatch не разрешает повтор или снятие
  резерва. Пустая история заказов не доказывает отсутствие банковского hold.
  Успешный submit возвращает `data.orderId`, не только верхнеуровневый номер.
  Даже HTTP 200 может сразу сопровождаться отменённым заказом и неизвестной
  оплатой: сообщение «Вернём деньги» ещё не подтверждает возврат.
  У уже подтверждённой карты Лавка не присылает `verifyStrategy`: клиент считает
  её `verified`. В снимке отсутствие нормализуется в `null`; смена стратегии
  после вопроса всё равно требует нового предложения и подтверждения.
- «Оплачиваю?» дважды за один заказ Лавки (14.10): модель пересказывала
  `confirmationQuestion` своими словами, `confirm` принимал «да» лишь на дословный
  текст, и Бро слал служебный вопрос вторым. Теперь «да» на свой вопрос Бро
  засчитывается, если в нём точный итог (`namesTotal`) и судья нашёл тот же
  состав и адрес (`askedInOwnWords` в `agent/tools/yandex_purchase.ts`, как
  `paymentUnanswered` у `browser_task`); вопрос до `prepare` с тем же итогом
  `prepare` велит сразу подтверждать.
- Скидка Лавки (13.10): `price` позиции уже со скидкой, а `totalItemsPrice` —
  сумма до неё, разницу несёт `totalDiscountValue`. Сверка позиций с
  `totalItemsPrice` отвергала любую скидочную корзину (`money_inconsistent`).
  Отказ корзины виден пробой `yandex-probe.py` с `page` и шагом из
  `pageSource` (`lavka.purchase_*` нет в реестре, режим `op` их не зовёт).
- `callInPageOverCdp` ждёт функцию в странице до 60 с, а не 15 с команды CDP
  (`callRunTimeoutMs`, бюджет — у транспорта): 13.10 submit Лавки опрашивал
  оплату дольше, CDP бросил вызов, и оплаченный заказ стал `unknown`.
- Оплата Лавки картой: перед `orders/submit` сайт пишет карту в корзину
  (`cart/v1/set-payment`, `meta.card`, новая `cartVersion`); заказ из корзины
  без карты Лавка отменяет за 0,6 с, `payments/v1/status` — `cancel` (так
  падали все заказы API до 12.10). После submit сайт опрашивает статус раз в
  2 с: карта с `verifyStrategy: card_antifraud` даёт `init`, затем
  `wait_user_action` со ссылкой trust.yandex.ru (3-D Secure) — её Бро отдаёт
  человеку (`agent/lib/yandex/lavka/checkout.ts`). Страница оформления — `/check`.
- Двухминутный TTL котировки Лавки — не срок согласия человека. После его
  «да» истёкшую котировку перечитываем: только служебные offer/version/expiry
  могут обновиться, товары, цены, адрес, cartId и карта должны совпасть.
  Свежий снимок сохраняется в том же атомарном claim; попытки после dispatch
  не обновляются и не повторяются (`yandex_purchase`, `lavka/checkout.ts`).
- Проверка выхода прокси идёт внутри `browser_task`: 09.10 четыре проверки по
  15–36 с держали ход 91 с, а следующее сообщение человека ждало за ним.
  Ход человека перебирает выходы не дольше `turnExitBudgetMs`, остальное —
  очередь и тик (`inTurn` в `prepareBrowserVmSession`); тик `browser-runs`
  `inTurn` не ставит. 14.10 все выходы мерились 3–5 с (порог `slowExitLatencyMs`
  3 с), перебор съедал бюджет хода, и поручение уходило в очередь на минуту, а
  модель говорила «браузер занят другим делом»: теперь первый российский выход
  берётся всегда, и медленный (повтор отбросил выход в 5 с и после 500 прокси
  ждал 5 минут; пауза теперь минута), а очередь из-за выхода причины не называет
  (`exitSearchWait` в `agent/lib/browser-use/queue.ts`, решение владельца).
  Выход проверяется и при сообщении человека, после прогрева песочницы
  (`warmBrowserVmExit`): поручение ждёт эту проверку, а не делает вторую рядом —
  две разом направили бы worker на две сессии прокси. Карта проверок — в памяти
  процесса: верно, пока на базу мира один eve.
  Текст сообщений (с 14.10, решение владельца) пишется в журнал eve строкой
  `[message]` (`role`: person/input/bro, `logMessage` в `agent/hooks/turn-log.ts`),
  с фильтром секретов, всегда, без флага; ход ищите и по `[tools]` и
  `durationMs` инструментов в строке `"method":"EVE"`.
- Пилот `ERRAND_AUTONOMY_WORKSPACES` (id или `*`, владелец 14.10): после `NEEDS: captcha`
  ход-отчёт заводит поручение на запасном сайте как поручение человека (`walledErrandFor`
  в `agent/tools/browser_task.ts`: делегирование, данные, бесплатный `submission` того же
  варианта с `boundHost` нового сайта); платное — по-прежнему «Оплачиваю?». Сайт, который
  человек назвал, ловит лишь `namesSite` по латинице и транслиту (`agent/lib/browser-use/autonomy.ts`):
  «Вайлдберриз» он не узнает, держит промпт; госсайты и запуск по разрешению не переносятся.
  Номера СТС и ВУ уходят только на гибдд.рф, gibdd.ru и Госуслуги (`checksFinesOfficially`
  в `public-services.ts`): код отказывает в старте и продолжении на другой сайт, но сам
  запуск на сайте ГИБДД держит лишь строка задачи. Тексты пилота — `autonomyEdits`
  (`agent/lib/skills/autonomy.ts`), без флага промпт прежний байт в байт.
- `ERR_TUNNEL_CONNECTION_FAILED` в отчёте запуска — сбой нашего резидентного прокси
  на CONNECT, а не сайта: 14.10 он отвечал 500/568 на каждый второй запрос, и форма
  productradar.ru дважды сбросилась. Пересыльщик worker (`Forwarder`, ≥ 2026-10-14.1)
  повторяет туннель до 3 раз на 5xx и обрыв (той же sticky-сессией, адрес тот же),
  402/403/407 отдаёт Chrome сразу.
- Запасной прокси (`BROWSER_VM_PROXY_FALLBACK`, NodeMaven `gate.nodemaven.com:8080`,
  логин `<база>-country-ru-sid-{session}-ttl-24h`): нет российского выхода на всех
  ротациях основного или отказ 402/403/407 — воркспейс переезжает на запасной, метка
  `s` в сохранённой сессии (`browserVmProxyPlace` в `agent/lib/browser-vm/proxy.ts`).
  Бюджет хода человека (`searchUntil`) действует и на переезд.
  Антибот-стена (14.10, Ozon закрывал все выходы Geonode): повтор с `freshExit`
  идёт обходом через запасной — сессия `r<ротация основного>w<n>`, только на это
  поручение и его продолжения; новое поручение возвращается на основной
  (`routeThroughRussia`, `detour`/`home`). Переехавший насовсем (`s`) обхода не
  делает. Частичный итог: метка `BLOCKED:` подвала (`composeBrowserTask`,
  `outcome.ts`) у законченного на VM поручения без права действовать — один повтор
  только по этим сайтам с прежним отчётом в задаче (`blockedSitesRetry`). Трафик
  обхода — строка `[browser-vm] a walled errand's run on the fallback proxy`.
- Код из письма в шесть однозначных полей (playerok.com, 10.10): поля react-otp-input
  кладут цифру в ТУ ячейку, что в фокусе, поэтому значения, выставленные всем полям подряд
  (`setValue`), и весь код одним `insertText` в первое поле показывали цифры, а сервер видел
  другой код (`otp_code_mismatch` ×6). Теперь по одной вставке на поле, каждое с фокусом
  заранее, и сверка прочитанного (`insertBoxes` в `cdp.ts`, `enter_one_time_code` worker
  2026-10-10.2, стенд `browser-vm/worker/test_code_boxes.py`, `BRO_CODE_BOXES_CHROME`).
  Ход-отчёт со своим ящиком после отказа кода смотрит письмо новее выданного (без ожидания),
  а не находит -- велит запуску заказать новый код, а не «напиши что угодно»;
  `otp_already_sent` расширяет окно письма до 15 минут (`codeSentEarlier`).
- Обновление worker сразу после пробуждения песочницы из снимка (Firecracker) может
  получить `401 expired token`: часы гостя ещё снимочные (10.10, `prewarmBrowserSandbox`),
  и поручение шло на старом worker. `rollOutBrowserVmWorker` теперь повторяет запрос через
  4 с до 3 раз; другой причины 401 (ключ, окружение) повторы не лечат. Запуск без `done` и без
  ошибки worker с `.3` описывает цифрами (`unfinished_reason`: шаги, `stopped`, последние действия).
- Браузер у каждого человека свой — песочница пула: в проде `BROWSER_BACKEND=pool`,
  и `usesBrowserPool` (`agent/lib/browser-vm/backend.ts`) отдаёт пул всем, список
  `BROWSER_POOL_WORKSPACES` тогда не читается. Хост пула с 10.10 — постоянный
  сервер Selectel (`BROWSER_HOST_CLOUD=static`, `firecracker`,
  `CLOUDRU_PRIVATE_ROUTING=off`); зоны Cloud.ru — история. От Browser Use Cloud
  отказались; 15.10 `BROWSER_USE_API_KEY` убран из env прода: с ним
  `agent/lib/privacy/facts.ts` рассказывал людям про облачный браузер Browser Use.
  Ключ не возвращайте: код Browser Use жив, но в проде не работает (без ключа
  молчит и расписание `browser-sign-ins`).
- В browser-use 0.13.10 обычный file input не имеет `frame_id`: CDP ставит
  его на владеющий HTML-узел. Для проверки origin поля worker ищет ближайшего
  владельца в том же `target_id` и сверяет `Page.getFrameTree.securityOrigin`;
  URL верхней страницы не доказывает принадлежность поля сайту.

- Выделенный сервер Selectel (09.10): `BROWSER_HOST_RUNTIME=firecracker` — третья
  среда `hostd`, песочница — microVM под `jailer`, снимок памяти лежит на диске
  хоста (в набор S3 идёт только профиль, как у `runc`). Устройство и пути —
  `browser-vm/host/README.md`, раздел «Firecracker». На сервер не заходим по SSH:
  новый код хоста — `POST /v1/admin/update`. Токен оператора подписан `updateKey` из
  `host.json` (`BRO_HOST_UPDATE_SIGNING_KEY`, его нет у Бро: утечка env приложения
  не даёт root на хосте), `boot.py token --host-id <id>`; хост без `updateKey` отвечает 403. Хосту, созданному до ключа, его кладёт один бандл с
  `boot.py bundle --enroll-update-key` (`browser-vm/host/README.md`, «Ключ обновлений»).
  `update.sh` проверяет новый код (компиляция, импорт, `Config.load`) до рестарта, а
  сторож `rollback.sh` возвращает `host.old`, если новый `hostd` не отвечает ~90 с: другого
  пути вернуть хост без SSH нет. Образ корня `<версия>.ext4` `hostd` пересобирает сам при смене гостевых
  скриптов. Образ корня и снимки привязаны друг к другу (`image_id`): правка
  `guest/bro-fc-init` делает старые снимки непригодными (холодный старт).
  Лог гостя (консоль, jailer) оператор читает тем же токеном:
  `GET /h/v1/sandboxes/<id>/log`. В госте нет `ip` и udev: `/dev/fd` и обычный
  `resolv.conf` (в Ubuntu это ссылка в `/run`) делает init, `mount` — только
  с `-n`. Гость берёт TSC, `/dev/ptp0` нет: время приходит через MMDS.
- Selectel, выделенный сервер: API хранит `cloud_init_user_data` с
  HTML-экранированием, и `"`, `'`, `>` в скрипте ломали загрузку хоста. Файлы
  кладите в base64 (`scripts/selectel/user_data.py`). API серверов принимает
  только `X-Auth-Token` проекта (`scripts/selectel/api.py`). Ротируемый порт
  9000 Geonode отвечает 403 на логин с сессией: песочнице нужен 10000, как
  делает `sticky_proxy` в `host.py`.
- Managed PostgreSQL Selectel: 5433 — пулер, он отвергает параметры запуска
  («unsupported startup parameter»: `PGOPTIONS` ops-скриптов,
  `statement_timeout`) и ломал бы `LISTEN` и сессионные advisory-замки мира.
  Приложение и ops ходят на 5432, прямо в PostgreSQL (`pg_address` в
  `scripts/selectel/cloud.py`).
- Хост пула в простое выключается (`stopped`), а не удаляется, и его будит
  следующая песочница или сообщение человека (`agent/hooks/browser-prewarm.ts`):
  новый хост в AZ-1 — 5 минут, а 04.10 — 16; включение — 92 с
  (`docs/browser-pool.md`, «Сон хоста»). Старый код спящих хостов не видит:
  слот занят, и поручения ждут до отказа. Перед откатом на релиз до этого —
  `UPDATE browser_hosts SET state = 'deleting'` для `stopped` и `waking`.
- `BROWSER_HOST_MIN_WARM` (часы — `BROWSER_HOST_WARM_HOURS` по Москве) держит
  хосты текущей сборки `ready`: `gen-2-8` — ≈ 3 960 ₽ в месяц за хост. При
  готовом хосте сообщение человека сразу поднимает его песочницу
  (`prewarmBrowserSandbox`, паркуется через 10 минут без поручения). Очередь
  повторяет старт не раньше чем через минуту, поэтому чужой короткий lease
  поручение ждёт в своём вызове до 30 с (`leaseFreed` в `sandbox.ts`).
- Прод с 04.10: `BROWSER_HOST_MIN_WARM=1`, `BROWSER_HOST_FLAVOR=lowcost10-4-8`
  (≈ 2 030 ₽ в месяц с диском и IP) и пилот `EARLY_REPLY_WORKSPACES` — в
  `prod.json`. Квота проекта (8 vCPU) теперь занята: 2 + 2 + 4, а спящая VM
  её тоже держит — пробная VM не влезет, пока владелец не поднимет квоту.
  3 ГБ песочницы на 4-гигабайтном флейворе не помещаются (`hostd` держит
  1 ГБ), а 2,5 ГБ на `lowcost10-2-4` упирались в память на WB и Маркете.
- Пул на своих серверах (`BROWSER_HOST_CLOUD=static`, 09.10, раздел 6
  `docs/browser-pool.md`): в `agent/lib/browser-pool/hosts.ts` режим целиком
  обходит Compute API (вызовы Cloud.ru идут через `browser-pool/cloud.ts`),
  а `hostVmStillThere` в `sandbox.ts` для такого хоста не спрашивает VM.
  Ход человека на таком пуле не ставит поручение в очередь, пока песочница
  поднимается: `ensureForRun` в `agent/lib/browser-vm/runs.ts` ждёт её до
  30 с (восстановление ~1 с), а размещение само записывает и опрашивает
  хосты (`staticHostsUp`). Очередь остаётся для занятого аккаунта и полного
  сервера. Тик пула здесь идёт и без ключей Cloud.ru.
  Скрипту `scripts/browser-pool/static-host-cloud-init.ts` нужен
  `--experimental-transform-types`: граф приложения использует parameter
  properties. Скрытые вызовы Compute API остаются у `private-route.ts`
  (`CLOUDRU_PRIVATE_ROUTING`): на сервере вне Cloud.ru держите `off`.
- Зона `ru.AZ-3` 04.10 снова включена и втрое быстрее AZ-1: новый хост —
  127 с до `ready`, включение — 48 с (AZ-1 — 288–352 и 92–145 с). Пул в неё
  не переведён: доступ VM Бро из AZ-1 к хосту в AZ-3 по приватному адресу
  на 443 не проверен, а 30.09 зону выключали без предупреждения.
- Порядок хостов RouterAI для worker с `require_parameters` молча не
  действует на хостах без `seed`: browser-use шлёт `"seed": null`
  (fireworks, together). 05.10 Together отдавал DeepSeek V4.1 Flash втрое
  быстрее deepinfra (вызов browser-use — медиана 2,2 с против 5,6 с), но
  дороже вдвое; без `require_parameters` его вызовы шли без ошибок
  (`docs/browser-speed.md`).
- Пилот `BROWSER_FAST_WORKSPACES` (05.10): DeepSeek worker на Together без
  `requireParameters`, `llmTimeoutSeconds` 25 (worker ≥ 2026-10-05.6), flash
  для поиска (`agent/lib/browser-vm/pilot.ts`, `docs/browser-speed.md`, раздел
  7). Флейвор хоста (`BROWSER_HOST_FLAVOR`) действует лишь на новый хост.
  Сменить его прогретому хосту — удалить VM хоста через Compute API, не
  трогая адрес: пул сам уберёт запись и адрес и создаст новый (на Cloud.ru, где
  пул жил до 10.10; на Selectel хост постоянный).
- Номер worker (`VERSION`) берите из свежего `origin/bro-next` перед PR и
  сверяйте с открытыми PR: 05.10 две сессии дважды выпустили разные worker под
  одним номером (`.5`, `.6`). Какой worker в корне пула, видно лишь в самом
  архиве (`opt/bro/worker/worker.py` в `pool/rootfs/<корень>.tar.zst`).
- Worker пула сначала приходит из корня песочницы. Пилот файлов
  (`BROWSER_VM_FILES_WORKSPACES`) обновляет его через `BROWSER_VM_WORKER`
  до выдачи песочницы поручению, в том числе после каждого park/wake:
  профильная парковка runc не сохраняет обновлённый код и сессии worker.
  Вне пилота смена корня по-прежнему может поставить поручения в очередь
  на 5–16 минут создания хоста (`docs/browser-speed.md`, раздел 6).
- Узкое место браузерного поручения — LLM шага и число шагов, не VM и профиль:
  Chrome до CDP — 0,2–0,8 с, профиль 178 МБ распаковывается за 0,35 с. Замеры,
  гипотезы и сравнение моделей — `docs/browser-speed.md`.

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
- Хост DeepSeek для worker пула Бро закрепляет так же, как основному агенту
  (`providerRouting`, `deepinfra`): сам RouterAI брал хосты без
  `structured_outputs`, и строгая схема browser-use валила шаги («validation
  error for AgentOutput»). `require_parameters` RouterAI принимает, но не
  фильтрует — такие хосты названы в `ignore` (`runTuning` в
  `agent/lib/browser-vm/runs.ts`); продолжение несёт `tuning` (worker после
  рестарта его забывает), хост ответа — `usage_costs.units.hosts`.
- Пилот `FLASH_SEARCH_WORKSPACES` (04.10): flash mode worker — лишь старт
  поиска без согласия, оплаты, постановки и секретов (`flash.ts`): вход и
  оформление с ним не мерили. Очередь и повтор после стены решают заново по
  строке; продолжение и согласие в живой запуск — полный режим. Старт в ходе
  человека с `site` привязывает его телефон — и идёт полным режимом.
- «accepted» от `attachSession(...).send` — не доставка: итог доставлен, когда
  ход-отчёт отправил сообщение, вызвал `browser_task` или закончился
  (`agent/hooks/browser-run-report.ts`). Аренду итога (10 минут) не
  укорачивайте: каждая передача тратит попытку из трёх.
- Отправить от имени человека запуск может только с `allowSubmit` и
  `submission`; бесплатное, о чём человек попросил своим сообщением, идёт без
  карточки и в продолжении того же поручения после отчёта. Своя постановка
  (`personWants:"done"` в ходе человека) и без `allowSubmit` даёт запуску его
  данные и заполняет форму до последней кнопки: «не нажимать» — только в
  промпте. Вне постановки и согласия код (`withoutOwnContacts` в `facts.ts`)
  вырезает из `task` и `site` модели (адрес — раскодированным, до DNS-проверки
  хоста) и из повтора поручения телефоны из Personal Info (каждый номер поля),
  телефон аккаунта и почту из Personal Info; имена и карточки сейфа — нет.
  Что человек сам набрал в этом ходе (метка выбранного варианта `ask_question`
  не в счёт — её писал Бро), не вырезается нигде (`contactsNotIn`), его
  цитата в строке продолжения — и в следующих продолжениях (`cutRowTask`),
  но только если строку написало продолжение, а не старт
  (`browserRunTaskOrigin`). О вырезанном Бро узнаёт строкой в результате.
- Одна покупка — один текстовый вопрос с точным итогом: согласие не даёт
  запаса сверх суммы и живёт, пока разрешённое не сделано
  (`errandStillAllowed`). Карточка и `execute` решают одной `consentFor`.
- «Да» на оплату спрашивается раз за заказ: согласие держится, пока итог
  запуска не принёс `Order:` (и после сбоя, и после «только проверь»), а
  продолжение сначала проверяет, не прошла ли оплата (`brokeOffPaying`). Заказ
  сверяется по корзине и магазину, не по словам `what`/`when`
  (`sameSubmission`); отчёт со стопом на оплате в пределах «да» не переспрашивает
  (`approvedPaymentInstruction`).
- Постоянные разрешения меняет только ход человека (`startedByPerson`).
  Поручение продолжает свой браузерный отчёт по `delegated_by_person` или
  сохранённому `submission`, только в своём корневом разговоре и по своему
  `browserRunId`: текст страницы нового разрешения не даёт. Фоновые работники
  новых действий и покупок не разрешают.
- Код и согласие уходят в запуск только из слов человека (`said.ts`): ход-отчёт
  сам продолжал запуск с выдуманным кодом. Чей ход, решает открывшее его
  сообщение, а не auth. Исключение — код из письма сайта (`mail-code.ts`).
- Регистрация на почту AgentMail (`signUpWith`, `sign-up.ts`): пароль
  делает код и до старта кладёт в хранилище входов логином сайта; логин сайта с адресом
  Бро и значит «письма сайта — в AgentMail». У AgentMail нет своего
  `Authentication-Results`: письма с проваленным SPF/DKIM/DMARC он
  отбрасывает, без заголовков ставит `unauthenticated`, спам из списка
  прячет — планка ниже Gmail, поэтому код вводится лишь на домене сайта, а
  ссылка берётся только https на его домене. Ссылку трекера рассылки
  (SendGrid, SES…) код проходит сам по `Location` через `fetchPublic`, не
  больше 5 запросов, и берёт, лишь если цепочка привела на домен сайта; сам
  запрос к трекеру и есть «клик». Итог — строка `ACCOUNT:` футера
  (`signUpSettlement`): логин убирается лишь по `ACCOUNT: none`
  первой попытки старта, иначе остаётся. Страницы входов в сейфе нет (10.10):
  пароль Бро виден только запуску, человеку он не показывается; входы идут
  тремя способами (`docs/login-handoff.md`), а забыть вход сайта можно
  просьбой (`site_sign_ins`, `forget_login`). Строки `vault_items` с логинами
  не удаляйте миграциями — ими пользуется Бро.
- Логин и пароль, которые человек прислал сам (текстом или фото письма),
  `browser_task` берёт в `login` и до привязки секретов кладёт в хранилище входов
  сайта поручения (`given-login.ts`, владелец 06.10). Только в ходе человека:
  пароль ищется по хэшам слов его 10 последних сообщений, а с фото в трёх
  последних — без сверки (код фото не читает). Госсайтам со входом через
  Госуслуги — отказ: их логин работает лишь на gosuslugi.ru.
- Телефон для входа — секрет запуска на домене `site`, не текст: текст видят
  все страницы. Российский номер привязан и 10 цифрами (поля с маской «+7»),
  кроме Госуслуг: там одно поле на телефон, почту и СНИЛС.
- Не пишите запуску, что он «уже вошёл»: 04.10 с такой фразой продолжения
  не входили после выхода сайта, а старт на «пароль выслан на почту» вставал
  с NEEDS: password, не пробуя пароль. Вход проверяет и делает сам запуск
  (`accountStateLine`), заказ — только из корзины (`checkoutRouteLine`).
- Карту на пуле вводит действие worker `fill_card`: поля ищет во всех фреймах
  вкладки и проверяет каждое (`card_expiry` в оба окошка срока ЮKassa давал
  01/01). Секретов короче трёх символов не заводите: browser-use прячет
  значение секрета везде на странице, которую видит модель, и «01» калечил
  номер карты. Стенд с Chromium — `browser-vm/worker/test_card_forms.py`
  (`BRO_CARD_FORMS_CHROME`); Chrome browser-use в облачной сессии не берёт CA
  прокси из NSS — `--ignore-certificate-errors-spki-list=<SPKI CA прокси>`.
- Отказы сервера сайта (XHR и fetch со статусом ≥ 400) worker пула пишет сам
  блоком `SITE ERRORS` в начало отчёта (`SiteErrors`, стенд
  `test_site_errors.py`): модель запуска перехват через `evaluate` по просьбе
  не ставила, и причину отказа сайта никто не видел. Отказ записи своего
  сайта (POST/PUT/PATCH/DELETE) worker с 2026-10-05.1 говорит и модели к
  следующему шагу — строкой в результате прошлого шага (`tell_agent`, как
  browser-use сам сообщает о капче), до 3 за запуск; фоновые GET 401/404
  (`/api/user`) — шум, только в отчёт: иначе модель чинила бы вход.
- Любую капчу на своём браузере запуск сначала отдаёт `solve_captcha` worker
  (2Captcha: токен, cookie DataDome, символы или точки на картинке; задача
  через выход запуска, без прокси — если сервис его не принял или не решил)
  и сам в неё не лезет: 05.10 аудиоверсия reCAPTCHA пометила выход
  («Повторите попытку позже»). Простая reCAPTCHA v2 сразу без прокси: через
  помеченный выход 2Captcha отвечал `ERROR_CAPTCHA_UNSOLVABLE`, а токен v2 к
  адресу не привязан. С такого выхода скрипт reCAPTCHA порой не грузится
  вовсе: поле ответа worker тогда сам кладёт в форму виджета и снимает
  `disabled` с её кнопки отправки (её включил бы колбэк виджета). На странице
  с токенной капчей любой вызов `solve_captcha` идёт путём токена: модель
  слала туда плитки reCAPTCHA. Имена задач — только из документации 2Captcha
  API v2. Живая проверка корня — лишь после смены хоста: сторож меняет хост
  со старым корнем, когда тот опустеет, а квота не даёт поднять второй.
  `*.archive.org` в `PROHIBITED_DOMAINS` worker закрывает и сам archive.org.
- След шагов запуска — `trail/<id запуска>/` воркспейса сессии (JPEG и
  `steps.jsonl`, без секретов и введённого текста), не `report/`: всё из
  `report/` Бро шлёт человеку картинками, а листинг режет на 100 файлов.
  Читать — `GET /v1/files?session=…&prefix=trail/` токеном worker.
- Регрессия оформления заказа — стенд `browser-vm/worker/checkout_harness.py`:
  копия кассы PREDUBEZHDAI (`checkout_shop.py`) под https://predubezhdai.ru и
  yoomoney.ru на 127.0.0.2/3:443 (нужен root), настоящий `run_agent` worker,
  тексты и секреты — из `composeBrowserTask` (после правки текста обновите
  `checkout_tasks.json`, как сказано в `tests/agent/tools/checkout-harness-tasks.test.ts`).
  Каждый прогон платный (1–4 ₽). На 127.0.0.1 GPT Luna отказывалась платить «на
  локальном сайте», поэтому — настоящие имена. Предзаполненная корзина стенда —
  «товары до поручения», и модель их убирала: пресеты корзину не наполняют.
- Письмо сайта в Gmail человека (14.10, productradar.ru): сайт прислал ссылку
  «задать пароль» без кода, а `mailCodeFromSite` в Gmail искал только код и каждый
  раз отвечал `not_found` за минуту (журнал: `[browser-use] code from mail`,
  `mailbox: 'person'`, `result: 'not_found'`); модель же видела письмо через
  `gmail-read`, где `key=` и коды замазаны, поэтому ссылку не могла передать и
  просила человека. Теперь Gmail ищет код, затем ссылку на домене сайта (подтверждение,
  задать или сбросить пароль, `actionLinkInLetter`) по HTML и тексту письма, ждёт
  2 минуты, а пароль для такой ссылки делает код и кладёт в сейф входом сайта
  (`savePasswordSetupLogin`, запуск вводит `login_password` по алиасу, прежние входы
  сайта убираются). Нет письма — запуск просит сайт прислать новое, не человека.
  Не возвращайте «пришли ссылку» и не отдавайте ссылку модели: только `mailCodeFromSite`.
  Закрытая страница отвергает лишь код (он её), ссылка из письма идёт и после
  закрытия: 14.10 ссылку «задать пароль» отвергли как старый код.
- Логин Госуслуг вводится только на gosuslugi.ru и дан лишь госсайтам из
  закрытого списка (`public-services.ts`): вход отдаёт сайту профиль человека.
- Статуса «ждёт ввода» у запуска нет: правило «сразу кончай с
  `NEEDS: sms_code`» стоит сразу после текста поручения и главнее бюджета
  (`personStepLine`), иначе запуск ждал код весь бюджет.
- Метки итога (`ITEMS:`, `BOOKING:`, `NEXT:`…) — `outcome.ts`; промпт расписания
  по `NEXT:` — из просьбы человека, не со страницы. Заказ пишется лишь у
  запуска, который мог действовать (`couldHaveActed`).
- Антибот-стену и сетевой сбой поллер повторяет (`captcha-retry.ts`), но запуск,
  который мог действовать, на сетевой ошибке — не как есть: мог нажать «Заказать»
  (сначала проверка, см. ниже).
  На VM повтор идёт в сессии прошлой попытки через новый выход: Avito закрывал
  каждый адрес минут через десять, и попытка с нуля не успевала дальше выдачи.
- Самовосстановление запуска, который мог действовать (14.10, решение владельца:
  сбой прокси или сайта не должен сбивать поручение; productradar.ru кончился
  `failed` посреди формы). Только при `submission` или `paymentAllowed`: запуск
  с сетевой ошибкой или `failed` без `NEEDS:` не повторяется и человеку не
  докладывается, а ставится на проверку (`agent/lib/browser-use/recovery.ts`,
  `networkVerdict` в `completion.ts`). Шаг лежит в `browser_runs.recovery_phase`
  и `recovery_attempt` и едет через `startCaptchaRetry`, то есть с тем же
  резервом (`moveSpendReservation` до внешнего вызова), ссылкой-опознанием
  попытки и сессией прошлой попытки на VM. `verify` — только чтение, без карты
  (`allowPayment: false`), итог в `ACTION: done|not_done|unknown`
  (`outcome.ts`): `done` закрывает поручение отчётом проверки, `not_done` запускает
  `continue` с прежним согласием, всё прочее (`unknown`, нет строки, `NEEDS` не
  `none`) уходит человеку с пометкой «не удалось понять». Потолок —
  `maximumRecoveries` (2) проверок, плюс общий потолок попыток `captchaAttempt`;
  после него прежний отчёт `interrupted`. Запуск с одним лишь резервом без
  согласия (продолжение после кода) по-прежнему идёт человеку. Не вынимайте
  карту из `verify` и не доверяйте `not_done` без прохода `continue`, который
  ещё раз смотрит список перед последним нажатием. Таймаут «run ran out of time»
  (`expireBrowserRun`) пока не восстанавливается.
- История (Browser Use Cloud, в проде не работает с 15.10): POST запуска там не
  повторялся (нет идемпотентности, захват искал начатый запуск в `GET /runs`),
  куки ложились в профиль лишь при чистой остановке браузера (`release.ts`).
- Профиль один на воркспейс, а два поручения на один аккаунт не идут разом
  (`sign-ins.ts`): коды параллельных входов гасили друг друга.
- Входы (`SIGNED_IN:`) продлевало расписание `browser-sign-ins` (только Browser
  Use, без его ключа не идёт). Очередь `queue.ts` на пуле — занятый аккаунт и
  полный сервер; 429/402 Browser Use — история.
- Очередь и антибот-повторы своего браузера (`vm:`) разбирает и live watch
  тика `browser-runs` (`nextOwnBrowserStarts`), с общим на тик лимитом
  стартов; Browser Use (история) — только тики. В тестах поллера watch держат
  выключенным моки `hasLiveBrowserRuns` и `nextOwnBrowserStarts` (`liveWatch`):
  без них тест спит настоящие секунды.
- eve подписывает карточку лишь «Approve tool call: …»: текст собирает
  `shared/chat/approval-card.ts`. В iMessage eve примет ответ текстом, только
  равный id, английской метке или номеру (`channel/resolve-text.js`).

- Тексты о данных: `agent/lib/privacy/facts.ts` (что Бро говорит людям) и
  `app/(public)/privacy` (страница) называют одни и те же сервисы — правьте
  вместе. Хостинг в фактах записан кодом (Selectel, Россия), а не берётся из
  env.

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
  не видят — task-агент пишется сам, реэкспортом хука (`task`).
- Веб-поиск (`web_search`) с 14.10 идёт через Composio Instant: TinyFish (в
  замере $0), при отказе, лимите или пустой выдаче — Tavily ($0,008), потом
  прежний плагин RouterAI `exa`/`perplexity` (2,22 ₽ за поиск). Прямой
  `POST /tools/execute/<slug>` с `user_id` без подключений: ~1 с против 2–6 с
  через сессию. Managed Exa в Instant не отдаёт выдержек — не берите. Откат —
  `WEB_SEARCH_INSTANT=off`; пустой баланс Composio — 402
  `Metering_WalletBalanceExhausted`, поиск уходит в RouterAI. Замер —
  `docs/benchmarks/web-search.md`. В `usage_costs` поиск не пишется.
- Откат на релиз до источника `task` (PR #290): старый `summarizeUsageCosts`
  не знает `source='task'`: у такого воркспейса `bySource.task`,
  `recordedRub` и `totalRub` (и общий `totalRub`) — `NaN`, в JSON
  `/api/usage-costs` — `null`. CHECK шире старого и откату не мешает;
  на время отката чинит отчёт лишь `DELETE … WHERE source = 'task'` (цифры
  task-агента теряются) — решает владелец. Сеть песочниц с файлами человека
  держит только новый роутер: перед таким откатом снимите пилот task-агента
  (`SANDBOX_WORKSPACES`) на всё время отката — снапшоты с файлами
  (`sandbox/workspaces/<id>.snap`) и история ребёнка вернутся при продолжении.

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
  Сообщения «без хода» у eve нет: любой `send` начинает ход. Текст кода без
  модели — ход `browser-notice`, чей `step.started` отдаёт `emptyTurnSelection`
  (окно огромное: иначе eve сожмёт историю этой же «моделью»), а веб-чат
  показывает `backgroundNoticeMessage` как сообщение Бро. Пустой ход — когда
  последнее сообщение — уведомление и без ответа рядом нет отчёта задачи
  (`browserNoticeTurn`; упавшие ходы-отчёты браузера не мешают). Уведомление не
  открывает ход для `startsTurn`, а ход с его вызывающим — не ход человека: eve
  держит вызывающего и для доставки без `auth` (отчёт task-агента). Токены
  шага — неизвестные, не 0: 0 eve запомнил бы размером истории.
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
- Голый 403 Composio (`ComposioError`, не 403 провайдера) `composioProxy` повторяет
  один раз через 3 с лишь для GET и лишь при `retryRefusedRead` (так зовут
  `withGoogleAuth` и `appRequest`; проактивная проверка повторяет сама через
  `onceMore`). Запись не повторяется: документации Composio, что такой 403 значит
  «провайдера не вызывали», нет, а прокси при этом отвечает HTTP 200 на любой
  статус провайдера — только догадка.
- Composio с адреса Cloud.ru изредка отвечает голым 403 (03.10: 5 из 9 ночных
  проверок), а тот же ключ из сессии — 200. Проверка почты спрашивает ещё раз
  через 3 с (`onceMore` в `agent/lib/proactive/probe.ts`); `ComposioError.answer`
  хранит начало чужого тела и `server`, строка `[proactive] check` — `failure`:
  403 Composio отдельно от лимита Google.
- `next_check_at` захваченной проактивной проверки — её аренда: отсрочка
  проходит, лишь пока аренда и `google_state` те же (`deferProactiveWatch`).
- Воркер с сессией без начатого хода сторож ждёт ещё 20 минут: Workflow держит
  ход в очереди (`recoverStuckScheduledAgentRuns`).
- Метка `<eve-empty-delivery/>` где угодно или «передавать нечего» в конце —
  `nothing_to_report` (`agent/lib/schedules/outcome.ts`).
- У воркера и хода-отчёта нет сетевых `web_fetch`/`find_images`/`web_search`:
  письмо не должно увести на чужой адрес (`tests/agent/capabilities.test.ts`).
- Расписания, которые действуют (`BACKGROUND_ACTIONS_WORKSPACES`, id или `*`, 14.10): ход
  человека кладёт в расписание `delegate` (`scheduled_agent_jobs.delegation`): одно бесплатное
  действие на сайте (`submission` с `chargeRub: 0`, сайт) или письмо точным адресатам. Запуск
  читает его из строки расписания на каждом вызове (`agent/lib/schedules/delegation/run.ts`),
  `browser_task` стартует только этот `submission` на этом сайте, `gmail-send`/`mail-send` — только
  этим адресам; оплата, `withinSpendLimit`, другой сайт и `continue` — отказ. Строки промпта меняет
  `delegation/text.ts` только в пилоте: без флага промпт байт в байт прежний. С 14.10 в
  проде `*` (владелец, сразу всем); откат — снять флаг в `prod.json` и `host.py env`.
- Агентный работник (`AGENCY_WORKSPACES`): вид запуска решает `proactiveRunKind`
  (`agent/lib/schedules/identity.ts`), режим читает пилот на каждом шаге.
  Гварды, журнал `agency_actions` и бюджет — `agent/lib/agency/`; повтор того же
  действия блокируют planned до 30 мин и done до 7 дней, failed/undone
  переигрываются. Пауза и откат — `agency_control`, ключ `agency_paused`. Откат:
  снять флаг, и запуски пойдут обычным проактивным воркером. Оплата спрашивает.
- `web_fetch`/`web_search` воркеру не выданы: ссылка из текста письма вынесла бы
  данные. `route_time` выдан (текст места уходит в OSM). Звонок (`phone-call`,
  грант `call`) и поручение браузера (`browser_task`, грант `submit`, только
  старт бесплатного с `allowSubmit` и `submission.chargeRub: 0`) выданы пилоту
  (владелец 12.10). Оплаты не выдаются: `allowPayment`, `withinSpendLimit` и
  платный заказ отказывают, поручение останавливается у «Оплачиваю?» отчёта.
  Ход воркера не читается как ход человека: `agencyWorkerTurn` в
  `agent/lib/phone/policy.ts`, `agencyStartApproval` в `agent/tools/browser_task.ts`;
  отчёты идут в чат задания, а не в сессию воркера. Итог звонка и поручения
  будит воркер (`agent/lib/proactive/follow-up.ts`): очередь хранит только
  запуск, поэтому итог, пришедший при занятом или упорном лимите, не догоняется
  после доставки отчёта.
- Почта агента листается без фильтра по времени: граница по
  `agent_mail_checked_at` в коде, одна страница из 50
  (`agent/lib/proactive/agent-mail.ts`).

## Бенчмарк

- В `eve dev` OpenRouter не отдаёт цену шага: рубли локального прогона
  считайте по токенам `usage_costs` и `shared/costs/prices.ts`. Кэш внутри
  хода отстаёт от промпта на 6–14 тыс. и с флагом `STEP_CONTEXT_WORKSPACES`
  (`docs/agent-costs.md`, 3.2): сравнивайте по видам шагов.
- Драйвер `scripts/bench/` держит курсор сам: `eve/client` двигает `streamIndex`
  только по дочитанному ходу, `session.stream()` сдаётся рано.
- `eve/client` зовёт глобальный `fetch` (свой не передать) и сам повторяет
  лишь открытие потока; POST создания, `send` и `respond` — никогда. Повторы
  драйвера — `scripts/bench/retry.ts`: что угодно, если запрос не ушёл
  (таймаут соединения, errno с `syscall` `connect`/`getaddrinfo`, туннель
  прокси «Proxy response (502–504)…»), чтение — и после обрыва, POST после
  обрыва — никогда (сообщение дважды меняет кейс). Туннель 403/407 и
  сертификат не повторяются вовсе. `read ECONNRESET` во время TLS не
  отличить от обрыва после запроса.
- Ход принятого сообщения после обрыва драйвер дочитывает сам, отбирая
  события по его `deliveryId`, как поток ответа eve: иначе ход-отчёт,
  вклинившийся раньше, сошёл бы за ответ. eve 0.62 этот id не экспортирует —
  драйвер берёт его у `MessageResponse` по символу `acceptedDeliveryId`
  (`conversation.ts`); после обновления eve смотрите тест «past a background
  turn».
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
- Письма с плюс-адресов ящика владельца Gmail считает его собственными, а
  фоновая проверка берёт только `in:inbox -from:me`
  (`agent/lib/proactive/probe.ts`): проактивность их не видит. Поэтому
  отправители, которые пишут первыми (руководитель и друг d11), — с
  зарезервированных доменов (`outsider` в `scripts/bench/account/catalog.ts`).
- Что делала проактивность, видно не в чате: сессии воркеров лежат в «Все
  чаты» как «New chat» с промптом «Proactive check…», исход каждой проверки —
  строка `[proactive] check` в журнале eve на VM. Простаивающий контейнер
  облачной сессии останавливается вместе с `observe`: утром дочитайте
  `--minutes 0`.
- Кейсы «запиши/забронируй» (d15 — барбер, uc_visa — отель и билеты) в ходе
  человека запускают `browser_task` с `personWants:"done"`: подготовка
  вписывает в форму имя и телефон владельца, «не нажимать» — только в
  промпте. На аккаунте владельца такие поручения сразу переводите в поиск
  (`bench send --kind hint`: «ничего не заполняй, только варианты»).
- Прогон оставляет на аккаунте владельца настоящие следы: d12 — утреннюю
  сводку, d15 — событие в календаре и напоминание. Убирайте после прогона
  (`bench send --case <id> --kind cleanup --text "…"`) и сверяйте по логу
  кейса: удаление события Composio с Cloud.ru порой отвечает 403, повтор
  через пару минут проходит. Кейс, оборванный «fetch failed» драйвера,
  `bench follow` не продолжает — только `bench send --kind hint`.
- Драйвер ждёт ответа, лишь если вопрос Бро стоит в конце сообщения; вопрос
  в середине — кейс `completed`, хотя Бро ждёт. Перед сравнением прогонов
  смотрите последние реплики и досылайте `bench send --kind answer`.
- Память аккаунта переживает прогоны: повтор d10 отвечает «уже сохранено»;
  с 03.10 в памяти владельца лежат записи d10 («место у прохода», «без
  свинины») — перед d10 и d13 удалите их в `/workspace/memory`.
  Кейсы памяти (d10, d13) сравнивайте на чистой памяти — d13 гоняли
  локальным Бро на RouterAI. При слепом судействе прячьте в логах только
  имена каталогов, не слова before/after: судьи штрафуют «битый текст».

## Память Бро

- Устройство — `docs/memory.md`; пишет только модель в интерактивных ходах.
- Сообщение ошибки drizzle (`DrizzleQueryError`) — «Failed query: … params:
  …», то есть текст памяти: в лог — только `name` и SQLSTATE из `cause`
  (`agent/schedules/memory-history.ts`), не `{ cause: error }`.
- Удаление явно названной записи из другого разговора в ходе человека идёт
  без карточки (`memoryRemovalApproval` в `agent/lib/memory/profile.ts`): правило по источнику записи, а не «одно
  удаление за ход», — параллельные вызовы шага политика не видит.
- Правила, лимит и разрешения меняет лишь ход человека (`ruleWriteRefusal`).
- Сводка памяти (`agent/lib/memory/digest/`) — расписание без хода и без
  основной модели: субагента зовёт только ход основной модели, а пилоту
  сводка зовёт свою (`MEMORY_DIGEST_MODEL`, без неё — `deepseek-v4-flash`)
  напрямую. Правило владельца: всё, что меняет сохранённое людьми, — только
  за флагом (`MEMORY_DIGEST_WORKSPACES`, без него сводка не идёт ни у кого).
  Записи меняет только через `db/services/memory/records.ts` (замок, ревизия,
  история); код вырезает из записи, а забывает лишь запись, где кроме кода
  ничего нет. Пилот фильтрует список в SQL (`listMemoryDigestWorkspaces`):
  иначе остальные воркспейсы проверялись на каждом тике. Сбой записи «Memory
  changed» — пропуск. Сводка идёт после 04:00 по зоне воркспейса, тиком раз
  в час; классификатор — лишь с прямым провайдером и видит только `fact`,
  `person`, `organization` и `decision`. Ложное срабатывание фильтра кодов в
  сводке стирает прежнюю версию записи безвозвратно
  (`wipeUnsafeMemoryHistory`): правку фильтра гоняйте на сотне образцов (коды
  домофона, телефоны, счета, полисы, СНИЛС — сохраняются).
- В системный промпт профиль не достать: ключ области памяти есть лишь у
  провайдера, а документ профиля eve дописывает в историю лишь при изменении.
- У слотов памяти — явный `namespace`: умолчание eve зависит от проекта Vercel
  или пути сборки (eve вшивает в релиз путь чекаута, на VM 02.10 это были и
  `wt-*` в scratchpad сессии), и на VM вся память до 02.10 пропала. Профиль и
  workstreams закреплены на ключе прода Vercel (превью — своё умолчание),
  записанное релизами VM до этого переносит recall из ключей списка
  `cutoverAppRoots` (`agent/lib/memory/namespace.ts`). На умолчание eve не
  полагайтесь.
- Навыки (`SKILLS_WORKSPACES`, с 15.10 в проде `*`) — записи слота `agent/memory/bro_skills.ts`, а
  не `agent/skills/` eve: статичные навыки входят в ключ песочницы, и каждая
  правка дала бы всем сессиям новую песочницу без вложений. Записи хода eve
  вставляет по имени файла слота: навыки — раньше профиля, чья записка
  меняется с просьбой и иначе выбивала бы блок из кэша. Правка текста
  навыка заменяет старые блоки один раз; старый блок дефузер считает
  подделкой. Динамические инструменты `turn.started` видят записи этого хода.
