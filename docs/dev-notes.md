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
  коммит).
- Правьте или удаляйте записи, которые перестали быть верными.
- Не пересказывайте историю задач и то, что и так видно из кода или
  `AGENTS.md`.
- Никаких секретов, токенов, внутренних адресов и личных данных пользователей.
- Держите файл коротким (ориентир — до 150 строк): он загружается целиком в
  каждую сессию.

## Процесс

- Основная ветка — `bro-next`; PR открываются в неё. CI (`.github/workflows/checks.yml`)
  гоняет проверки на каждом PR и на пушах в `bro-next`.
- На PR бывает ревью бота cubic; его замечания исправлялись отдельными
  коммитами «По ревью cubic: …».
- Сообщения коммитов и заголовки PR обычно пишутся по-русски и описывают
  изменение с точки зрения пользователя.
- В свежей облачной сессии нет `node_modules`: перед `pnpm check` и
  `pnpm build` нужен `pnpm install`.
- Проекту нужен Node 24, а в облачном контейнере по умолчанию Node 22: на нём
  `pnpm check` валит ~12 наборов тестов с «SyntaxError: Unexpected identifier
  'r'», и на чистой ветке тоже. Бинарь ставится без root:
  `npm pack node-linux-x64@24` в scratchpad, распаковать, добавить его `bin` в
  начало `PATH`.
- `pnpm build` без `.env.local` падает на сборе данных страниц: нужны
  `DATABASE_URL`, `BETTER_AUTH_URL` и `BETTER_AUTH_SECRET`. Для локальной
  проверки хватает заглушек, к базе сборка не подключается.
- `pnpm check` включает knip: новый каталог с точками входа (как
  `agent/instrumentation/`) надо добавить в `knip.config.ts`, иначе его файлы
  считаются неиспользуемыми.

## eve

- eve закреплён на `0.62.0` с патчем `patches/eve@0.62.0.patch`. Обновление
  версии означает перевыпуск патча; порядок описан в `patches/README.md`.
- `pnpm build` собирает только Next.js. Агента eve собирает `pnpm build:eve`:
  только он проверяет durable-замыкания динамических инструментов.
- Инструмент не видит историю сообщений: в `ToolContext` её нет. Фото
  человека `generate_image` берёт в резолвере `turn.started` из
  `ctx.messages` и кладёт в замыкание только ссылки: путь `eve-sandbox:`,
  если eve уже положил вложение в песочницу, иначе копию в приватном Blob,
  сделанную один раз в ходе, где фото пришло (`agent/tools/generate_image.ts`).
- Веб-чат (канал eve) достижим только через `attachSession(sessionId)`: адреса
  продолжения у него нет, и `to(...)` из расписания туда не доставит. Хендлер
  расписания получает `attachSession` из нашего патча eve; им пользуется
  `agent/schedules/browser-runs.ts`.
- Всё, что попадает в историю сообщений, должно сериализоваться в JSON. Сырой
  `Uint8Array` в `FilePart` ломал durable-замыкание динамических инструментов:
  `save_memory`, `update` и `workstreams` молча пропадали до конца сессии
  («Dynamic tool resolver failed — Expected a JSON-serializable value»). Байты
  файлов кладутся base64-строкой (коммит `2ed484c`).
- Текст поручения Browser Use собирается в `agent/tools/browser_task.ts`
  (`composeBrowserTask`) и проверяется юнит-тестами по дословным фразам. Evals
  на `browser_task` нет: инструмент появляется только с `BROWSER_USE_API_KEY`,
  и каждый кейс запускал бы настоящий платный прогон.

- Колбэки динамических инструментов (`execute`, `approval` и др.) пишите
  инлайн в `defineTool()` или ссылкой на идентификатор: сборка eve ставит
  durable-дескриптор только им. Вызов фабрики вида `approval: policy("x")`
  ломает резолвер в рантайме («callback 'approvalRequest' does not have a
  durable descriptor»), а юнит-тесты этого не ловят; нужно
  `approval: (ctx) => policy(ctx, "x")`. Проверить можно
  `transformDynamicToolExecute(file, code)` из
  `eve/dist/src/internal/workflow-bundle/dynamic-tool-transform.js`.
- В eve нет настройки `toolChoice`. Доставку через `send_message` в
  интерактивных ходах форсирует резолвер модели на `step.started`
  (`agent/agent.ts`): пока последнее сообщение человека без ответа, модель
  OpenRouter оборачивается middleware с `toolChoice: required`
  (`agent/lib/model/openrouter.ts`). `ctx.messages` там несут eve-поле `kind`:
  `user` у человека, `execution.background_task` у фонового пробуждения,
  которое по инструкциям может промолчать (`agent/lib/delivery/pending.ts`).
  Не форсируются: ходы `browser-result` (антибот-проверку модель продолжает
  молча), шаги после десятого без ответа, `anthropic/*` с reasoning (Anthropic
  отвергает принудительный инструмент при extended thinking). Строковый id
  Gateway не оборачивается: в `eve dev` eve подставляет свою авторизацию
  Gateway только для строк.
- `eve info` в 0.62 не печатает подключения ни в тексте, ни в `--json`. Что
  подключения собрались, видно в `.eve/compile/compiled-agent-manifest.json`
  (ключ `connections`), который `eve info` пишет при компиляции.
- MCP-подключение отдаёт список инструментов только с токеном пользователя:
  `connection_search` без подключённого аккаунта паркует ход на авторизации.
  OpenAPI-подключение строит инструменты из спецификации без токена, и
  подтверждение спрашивается до входа. Поэтому Notion и Slack сделаны
  OpenAPI-подключениями (`agent/connections/`), а записи идут через
  `notion-add-task` и `slack-send-message`, которые сами находят базу и адресата.
- Агентские эвалы в облачной сессии: `pnpm eval:agent` требует ключ Gateway
  и Docker. Хватает `OPENROUTER_API_KEY`, локального Postgres (`initdb` от
  не-root пользователя), `pnpm db:migrate` и прямого
  `eve eval agent --tag <тег>` с `DATABASE_URL`, `BETTER_AUTH_URL=http://127.0.0.1:9`
  и `NODE_ENV=development`. Кейсы с `t.judge` без Gateway не оценятся.

## Notion и Slack

- Коннекторы Vercel Connect задаются `NOTION_CONNECTOR_UID` и
  `SLACK_CONNECTOR_UID` (по умолчанию `notion` и `slack`). Настройка Notion:
  `eve link`, затем `eve add connection/notion --non-interactive --skip-install`.
  Готового `connection/slack` в реестре eve нет (`channel/slack` делает бота,
  а не пишет от имени человека); коннектор Slack создаётся вручную с
  user-скоупами из `agent/lib/connected-apps/auth.ts`.

- `POST /eve/v1/session` отвечает `202` с id, как только Workflow принял
  запуск, а `session.started` приходит только с первым сообщением. Поэтому
  владельца сессии записывает обёртка этого маршрута в `agent/channels/eve.ts`,
  а не только хук `agent/hooks/session-owner.ts`: иначе ранний `GET …/stream`
  получал `403 Session not found`.
- Пометку `first-contact` решает `workspaces.introduced_at`, которое канал
  занимает условным UPDATE в `onMessage` (`claimWorkspaceIntroduction`), а не
  таблица `chats`: переезд из Convex строк `chats` не пишет. Занимать метку можно
  только для сообщения, которое точно запустит ход.
- Любой сбой вызова модели приходит в канал как `turn.failed` с
  `code: "MODEL_CALL_FAILED"`, включая переполнение контекста; «скоро вернусь»
  говорим только при статусе 402/429/5xx из `details`.

## OpenRouter

- `GET /api/v1/credits` принимает только management-ключ, обычный ключ
  инференса получает 403. Поэтому проверка баланса
  (`agent/lib/model/credits.ts`) ждёт отдельный `OPENROUTER_MANAGEMENT_KEY`.

## Vercel

- Не публикуйте свои маршруты каналов eve (`/webhooks`,
  `/internal/scheduled-run`) в Build Output: вебхуки отвечали 200, но Vercel
  Workflow переставал вызывать `/.well-known/workflow/v1/flow`, и ни один ход
  не запускался. Откачено в `bb5b1a0`. Следствие: в продакшене до eve доходит
  только `/eve/v1/*`, а `/webhooks/browser-use` и `/internal/scheduled-run/*`
  не работают. Не стройте доставку на вызове своих маршрутов: вебхук Browser
  Use заменяет поллер раз в минуту.

## Браузерные поручения

- Итог поручения хранится в `browser_runs.report` и доставляется отдельно от
  завершения под арендой (`report_claimed_at`): сбой доставки не теряет итог,
  поллер повторяет её, а `browser_task status` отдаёт недоставленный итог.

## Google

- Уровень доступа Google (`full` / `read_only`) хранится в `settings` под
  ключом `google_workspace_access`; нет записи — `full`. Смена уровня сначала
  отзывает грант (`revokeGoogleWorkspaceGrant`), иначе у Google остаются широкие
  scopes старого гранта. Запись в режиме только чтения отсекается политикой
  подтверждения `googleWriteApproval` до карточки, а не ошибкой Google.
- Google выдаёт refresh-токен, только если в запросе авторизации есть
  `access_type=offline`, и только когда экран согласия реально показан.
  `prompt: "consent"` шлют оба пути авторизации: кабинет/`connect_google` и
  карточка входа eve (через `connectOptions`). `access_type` SDK не
  передаёт: кабинет шлёт его в поле `additionalParams` эндпоинта authorize, а
  карточке eve нужен `authorizationUrlParams` коннектора. Одного `prompt`
  мало: после #174 грант всё равно пропал. Если грант онлайн, проверка
  tokeninfo пишет в лог `grant has no offline access`; она идёт без ожидания
  при чтении подключения и после входа из чата
  (`shared/google-workspace/connection.ts`). Кроме явного отключения и смены
  уровня доступа, код гранты не отзывает: `evict` из eve без `revoke` только
  чистит кэш.
- Ответ на письмо строится из Gmail `id` исходного письма (`replyToMessageId`):
  инструмент сам читает Message-ID/References/Subject и `threadId`. Поле
  `messageId` в выдаче чтения переименовано в `rfcMessageId`, чтобы модель не
  путала его с Gmail `id`, который берут остальные `gmail-*`.

- Превью-деплои получают те же `DATABASE_URL*`, что и продакшен (переменные
  интеграции Neon выставлены на все окружения, веток БД на превью нет). Пока
  сборка превью запускала `db:migrate`, миграции неслитых PR применялись к
  продовой базе, а drizzle потом молча пропускал миграции bro-next с более
  ранним `when`. Теперь сборка зовёт `db:migrate:deploy`, который на превью
  ничего не делает. Миграцию PR перед слиянием генерируйте заново поверх
  bro-next, чтобы её `when` был новее всех уже применённых.

## Память Бро

- Устройство памяти описано в `docs/memory.md`. Запись в неё идёт только через
  вызовы инструментов моделью в интерактивных ходах; фонового извлечения фактов
  нет, а в `scheduled-worker` память доступна только на чтение.
