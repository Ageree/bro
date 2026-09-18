# Bro на ядре OpenInstinct: архитектурная оценка перехода

Дата: 2026-09-18. Статус: оценка и план, код не менялся.

Сравнивались `ageree/bro` (ветка `claude/inspiring-franklin-wo0z92`, коммит `a60271f`)
и `Merit-Systems/OpenInstinct` (коммит `b8b4799`, 15 сентября 2026, eve 0.55.0).

## Вердикт в одном абзаце

Переход реален и заметно проще, чем выглядит со стороны. `bro` не «похож» на
OpenInstinct, он из него вырос: тот же фреймворк eve, worker-субагент с теми же
файлами (`autofill/native.ts`, `fill_from_vault`, `manage_browsers`), тот же формат
шифрования vault (`v1.iv.tag.body` с AAD `tenant\0vault\0handle`). Всё, что `bro`
нарастил сверху, это Convex-бэкенд, два самописных канала и стек Browser Use Cloud.
Из трёх «наслоений», которые нужны, два (Photon iMessage и Telegram) уже встроены
в eve 0.55 как готовые каналы, третье (Browser Use Cloud) сводится к одному тонкому
инструменту, потому что у Browser Use есть вебхуки и `secretBindings`. Пользовательская
схема переносится в Postgres одним скриптом. Реалистичный объём: 3-4 недели работы
агентов с ревью, против бесконечного латания текущего кода.

## Что есть на двух сторонах

| | bro | OpenInstinct |
|---|---|---|
| Фреймворк | eve 0.47.6 | eve 0.55.0 |
| Объём кода | agent 21k + convex 14k + scripts 33k строк | ~36k строк включая Next.js UI, тесты и линт-плагины |
| Бэкенд | Convex (tenants god-row на ~90 полей, workflow, crons, rate-limiter, storage) | Postgres (Neon) через Drizzle, 14 миграций, 17 таблиц |
| Auth | свой: `loginChallenges` + `sessions` по телефону | Better Auth, вход по телефону с OTP, `phoneNumberVerified` |
| iMessage | Photon Spectrum через gRPC, `defineChannel` руками, 1014 строк | Linq через `linqChannel` (372 строки); в eve есть готовый `photonIMessageChannel` |
| Telegram | Bot API руками, 512 + 352 + 409 строк | в eve есть готовый `telegramChannel` с HITL-кнопками и вложениями |
| Браузер | Browser Use Cloud hosted-агент (~8.4k строк) плюс legacy Kernel worker (2.3k) | Kernel напрямую: browser-agent субагент, CDP + `@onkernel/browser-loop` |
| Vault | AES-256-GCM, HKDF на тенанта, Convex | AES-256-GCM, тот же формат, Postgres, UI на Next.js |
| Память | Supermemory (обязателен, платный) | profile (Blob), personal_info и workstreams (Postgres) |
| Расписания | Convex wakeups + crons, 6 видов | `scheduled_agent_jobs` с лизами, cron раз в минуту, отчёт в канал |
| Web | 3 статических HTML (landing, cabinet, vault) | Next.js 16: чат, vault, tasks с трейсами браузера, personal-info, sign-in |
| Тесты | 63 самописных `*-check.ts` без раннера | 77 vitest-файлов, 13k строк |
| Линт | tsc | oxlint с anti-slop плагином, knip, turbo, `pnpm check` |
| Лицензия и живость | | MIT, 443 коммита, 3 активных автора, 5-7 коммитов в день |

Важная оговорка про OpenInstinct: README прямо говорит «not intended for production
use», а eve в preview. За сентябрь OI трижды мигрировал eve. Это не блокер, но
означает, что fork должен жить с `upstream` remote и еженедельным merge, а весь
код Bro лежать в отдельных файлах, а не правках upstream-файлов.

## Четыре слоя поверх OpenInstinct

### 1. Photon iMessage вместо Linq

Готовое в eve: `eve/channels/photon` экспортирует `photonIMessageChannel({credentials,
onMessage, events, route, turnPolicy, webhookSecret})`. Форма один в один как у
`linqChannel`. Credentials либо через Vercel Connect (`connectPhotonCredentials`),
либо portable: `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET`, `IMESSAGE_WEBHOOK_SECRET`.
Это те же значения, что сейчас в `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` /
`SPECTRUM_WEBHOOK_SECRET`. Никакого gRPC, никаких `externalDependencies` в `agent.ts`.

Что писать:
- `agent/channels/photon.ts`: копия `agent/channels/linq.ts` с заменой фабрики.
  Логика `onMessage` (телефон отправителя, поиск verified-пользователя, `accessScopeForUser`,
  `auth.attributes.conversationChannel = "photon"`) переносится дословно.
- Автоонбординг. OI роняет сообщение от незнакомого номера (`linq.ts:299-310`).
  Bro создаёт тенанта по первому сообщению. Решение: в `onMessage` создавать Better
  Auth пользователя с `phoneNumberVerified: true`, потому что Photon уже доказал
  владение номером фактом доставки. Это одна функция рядом с `signUpOnVerification`.
- Landing `POST /access` (Inkbox identity + Photon shared user + `sms:` deep link):
  становится одним route handler в Next.js. Клиент Photon REST это 57 строк.
- Форматирование под iMessage (`imessage-text.ts`, 306 строк, чистый модуль): переносится
  как есть, подключается в `events["message.completed"]` канала.
- Linq-специфика, которую надо обобщить: префикс `linq:` в `agent/lib/reply-targets.ts`,
  enum `conversationChannel` в `db/schema/schedules.ts:24-26` (миграция: добавить
  `photon`, `telegram`), доставка картинок `agent/lib/linq-image-artifact/*`.

Не переносить сразу: fast-ack (401 строка) и early-deliver (714 строк). Это
оптимизации задержки под конкретную архитектуру bro (вебхук и turn в разных
функциях Vercel). Сначала измерить задержку на новом ядре, потом решать. Fast-ack
чистый и при необходимости встанет в `onMessage` через `waitUntil` за день.

### 2. Telegram

Готовое в eve: `telegramChannel({botUsername, credentials, onMessage, events,
uploadPolicy})`. Проверка `X-Telegram-Bot-Api-Secret-Token`, HITL через inline-кнопки,
входящие фото и документы, разбиение на 4096 символов, проактивные отправки
`to(telegram, {chatId}).send(...)`.

Что писать:
- `agent/channels/telegram.ts`: `onMessage` резолвит Better Auth пользователя по
  `telegram user id`. Нужна таблица привязок `channel_identities (workspace_id,
  channel, external_id, chat_id, bound_at)`, одна миграция.
- Bind-flow (`t.me/<bot>?start=bind_<token>`): `convex/lib/telegramPolicy.ts` (251
  строка, чистый) переносится почти без изменений, токен хранится в новой таблице.
- Форматирование: eve шлёт plain text без `parse_mode`. `telegram-text.ts` (409 строк,
  чистый) подключается в кастомный `message.completed` и шлёт HTML через `channel.telegram`.
- `lastChannel` для проактивных сообщений: в OI это `reply-targets` и отчёт расписаний.
  Обобщить target с `linq:` на `photon:` / `telegram:` и хранить последний канал в
  `channel_identities`.

### 3. Browser Use Cloud

Здесь единственная настоящая архитектурная развилка. У OpenInstinct браузер это
Kernel как инфраструктура: модель сама водит браузер по шагам через CDP и
`@onkernel/browser-loop`. У bro браузер это Browser Use Cloud как hosted-агент:
задача уходит целиком, наша сторона ждёт исход. Оба варианта возможны на Browser Use:

Вариант A, «Browser Use как инфраструктура». `POST /api/v4/browsers` отдаёт `cdpUrl`,
`profileId` и `proxyCountryCode` (профили и прокси есть), live view URL приходит
в событии `browser.ready`. Тогда browser-agent субагент OI остаётся, меняется
только `lib/kernel.ts` и 6 файлов, которые импортируют `@onkernel/*`. Vault-автозаполнение
OI уже работает поверх голого CDP WebSocket (`autofill/native.ts`) и не зависит от
Kernel. Проблема: `@onkernel/browser-loop` (semantic snapshot/find/act) привязан к
Kernel, его нужно либо проверить на чужом CDP, либо заменить на `computer_action`
поверх CDP (`Page.captureScreenshot`, `Input.dispatchMouseEvent`). Плюсы: трейсы,
UI `/tasks`, масштабирование скриншотов с маской секретов, всё из коробки. Минусы:
каждый шаг это вызов модели с нашей стороны, а bro уже проходил этот путь с Kernel
worker и ушёл от него.

Вариант B, «Browser Use как hosted-агент», рекомендуемый. Один инструмент
`browser_task` у корневого агента:
- `POST /api/v4/runs` с `sessionId`, `profileId` на пользователя, `proxyCountryCode: ru`,
  моделью и `secretBindings` из vault OI (карта и логин привязаны к `allowedDomains`,
  модель значений не видит). Это ровно то, что bro делает в `browser-pay.ts`.
- Вебхук Browser Use (`agent.task.status_update` / `session.status.update`, подпись
  HMAC-SHA256 в `X-Browser-Use-Signature`) принимается custom-каналом `defineChannel`
  и через `to(photon | telegram, target).send(...)` будит агента с исходом. Это убирает
  весь `convex/browserFollow.ts` (1208 строк) и `@convex-dev/workflow`: polling
  был нужен только потому, что bro не использовал вебхуки.
- Follow-up человека в живой run: `POST /sessions/{id}/queue` (bro уже так делает).
- Ожидание кода или решения («НУЖНО: sms_code»): run останавливается на чекпоинте,
  человеку уходит live view URL, продолжение новым run в той же `sessionId`.
  Это документированный примитив Browser Use для HITL.
- Оценка объёма: тонкий клиент ~300 строк (у bro он сейчас продублирован в eve и
  Convex, 983 + 246), вебхук-канал ~150, инструмент ~300, миграция для таблицы
  `browser_runs` (run id, session id, profile id, статус, исход). Прогресс-заметки
  и парсер исхода (`browserOutcomePolicy.ts`, 251 строка, чистый) переносятся.
- Не переносить: `browserInjectPolicy.ts` (1013 строк prompt-as-code с историей
  инцидентов), `errand-brief.ts` (376). Заменяются одним коротким файлом инструкций
  для задачи и структурированным контрактом вывода. Kernel worker (2331 строка)
  и таблица `browserSessions` удаляются.

При варианте B browser-agent OI удаляется из fork, а не оставляется «на всякий
случай»: две браузерные стопки одновременно это ровно та причина, по которой bro
раздулся.

### 4. Пользовательская схема и уход с Convex

Рекомендация: уходить с Convex полностью, а не держать рядом. Две среды исполнения
(eve на Vercel плюс Convex) породили в bro дублирование клиентов и `/internal/*`
маршруты для перекрёстных вызовов. Реактивные запросы Convex в bro не используются
(cabinet и vault это plain fetch), так что уникальной ценности Convex не осталось.

Маппинг `tenants` в схему OI:

| Поле bro | Куда в OI |
|---|---|
| `phoneE164`, `displayName`, `status` | `user` (Better Auth, `phoneNumberVerified = true`) плюс `workspaces` через `ensureScope` |
| `photonUserId`, `photonConversationId`, `photonAssignedNumber`, `telegram*`, `lastChannel` | новая `channel_identities` |
| `paidUntil`, таблица `payments` | новая `billing` (paid_until) и `payments`, route `/api/yookassa` в Next.js; `billing.ts` (130 строк) переносится как есть, он чистый |
| `tz` | `user_profiles` (уже есть адрес и контакты) |
| `browser*` (30 полей) | `browser_runs`, только то, что нужно варианту B |
| `vaultItems` + `vaultSecrets` | `vault_items` + `encrypted_secrets`: скрипт расшифровывает `BRO_VAULT_KEY` с HKDF, шифрует ключом OI, AAD `workspaceId\0vault\0itemId` |
| `wakeups` (6 видов), `jobs` | `scheduled_agent_jobs` (timing jsonb, лизы, отчёт в канал) |
| `orders` | новая таблица `orders`, инструмент `list_orders` |
| `files` (`_storage`) | Vercel Blob (OI уже хранит там картинки) |
| `sessions`, `loginChallenges` | Better Auth OTP (уже есть `/sign-in`); код логина шлётся через Photon вместо Linq |
| rate-limiter | счётчики в Postgres, одна таблица |
| `watchers`, `composioEvents` | Composio не переносится: у OI Gmail, Calendar и Contacts нативно через Vercel Connect с одобрением на отправку |
| `testTranscript` | vitest с моком адаптера канала |

Cabinet и vault HTML не переносятся: у OI это `/vault`, `/personal-info`, `/sign-in`.
Landing это одна страница Next.js.

## Что из bro не брать вообще

- Kernel worker и `convex/browsers*` (2.5k строк): вторая браузерная стопка.
- `browserInjectPolicy.ts`, `errand-brief.ts`, `fast-ack.ts`, `early-deliver.ts`: 2.5k
  строк оптимизаций и prompt-as-code. Возвращать по одной, если метрики попросят.
- Inkbox (legacy `/webhooks/imessage`, dedicated line, mail-only identity) и
  OTP-субагент по почте: у OI есть Gmail; входящий OTP ищется там. Отдельный ящик
  на человека можно вернуть позже, если Gmail-подключение окажется барьером.
- Composio и watchers: заменяются Google Workspace OI.
- TinyFish: у OI свои `web_search` / `web_fetch`.
- Supermemory как обязательная зависимость: у OI три слота памяти на Postgres и Blob.
  `@supermemory/eve` можно подключить как четвёртый слот позже.
- `sandbox_run` через `@vercel/sandbox`: у eve есть встроенный sandbox.
- 63 `*-check.ts`: переносятся только тесты чистых policy-модулей, которые выжили,
  и переписываются под vitest.

Переносится маленькое и чистое: `imessage-text.ts`, `telegram-text.ts`,
`telegramPolicy.ts`, `browserOutcomePolicy.ts`, `browser-pay.ts` (расширение хостов
оплаты), `billing.ts`, `voice.ts` (STT через OpenRouter, 259 строк), русские
инструкции корневого агента (468 строк, сократить).

## Риски и открытые решения

1. Провайдер модели. OI ходит через Vercel AI Gateway (`openai/gpt-5.6-sol-fast`
   по умолчанию, выбор модели в UI). Bro сидит на OpenRouter с DeepSeek. Проверить,
   есть ли нужная модель в AI Gateway, иначе задать custom provider в `agent.ts`.
2. Vercel-связанность OI: Blob (ключи установки, картинки, память profile), OIDC
   для вебхуков и внутренних вызовов, Vercel Connect для Google и Photon. Раз проект
   и так на Vercel, это плюс, а не минус. Уйти с Vercel потом будет дороже, чем сейчас.
3. `onMessage` OI требует verified-пользователя. Автосоздание по первому сообщению
   это осознанное ослабление: телефон становится единственным фактором, как и в bro.
4. Строгий линт OI (anti-slop, knip, `--deny-warnings`). Для дешёвых агентов это
   ограждение, а не помеха: `pnpm check` становится автоматическим ревьюером.
5. Preview-статус eve и OI. Fork с `upstream`, merge раз в неделю, Bro-код только
   в новых файлах. Каждое отступление от upstream записывать в `docs/fork-notes.md`.
6. `@onkernel/browser-loop` не нужен при варианте B. При варианте A проверять
   работу поверх чужого CDP до начала работ.

## План по фазам

Фаза 0, полдня. Новый репозиторий `bro-next` как fork OpenInstinct, remote `upstream`.
Деплой ванильного OI на Vercel с Neon, Blob и Photon через `eve add channel/photon-imessage`.
Критерий: eve web-чат и `/vault` работают на проде.

Фаза 1, 2-3 дня. Photon канал, автоонбординг, `imessage-text`, landing и `/access`.
Критерий: новый номер пишет в iMessage и получает ответ, vault виден в кабинете.

Фаза 2, 2-3 дня. Telegram канал, bind-flow, HTML-форматирование, `channel_identities`,
проактивная доставка в последний канал.

Фаза 3, 5-7 дней. `browser_task` на hosted runs Browser Use, вебхук-канал,
`secretBindings` из vault, live view для входа, `browser_runs`, парсер исхода.
Удаление browser-agent и Kernel. Критерий: заказ на WB с оплатой картой из vault
проходит с iPhone без участия оператора.

Фаза 4, 3-5 дней. YooKassa, `orders`, `tz`, лимиты, скрипт миграции данных из
Convex (тенанты, vault, оплаты). Прогон миграции на копии, затем cutover: вебхук
Photon переключается на новый хост, Convex выключается.

Фаза 5, по потребности. Voice STT, русские инструкции, proactive-сканы как
`scheduled_agent_jobs`, Supermemory как слот памяти, fast-ack если задержка требует.

Итого 3-4 недели календарных при работе агентами. Каждая фаза это отдельная ветка
и PR с зелёным `pnpm check`, Sonnet-класс на реализацию, Haiku-класс на механику
(миграция данных, перенос тестов), проектирование и ревью на старшей модели.

## Что нужно решить владельцу до старта

1. Вариант браузера: B (hosted-агент Browser Use, рекомендация) или A (Browser Use
   как CDP-инфраструктура под browser-agent OI).
2. Новый репозиторий как fork OI (рекомендация) или переписывание `bro` на месте.
3. Полный уход с Convex (рекомендация) или Convex остаётся для чего-то конкретного.
4. Провайдер модели: AI Gateway или OpenRouter.
5. Обязательный набор на день cutover: из fast-ack, voice, orders, YooKassa,
   proactive, Composio-watchers выбрать то, без чего нельзя выключать старого Bro.
