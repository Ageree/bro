# Bro — ChatGPT OAuth + личный компьютер

_Date: 2026-09-07 · computer lock: 2026-09-08_

Утверждено оператором: вход через **Codex OAuth**. Если вход есть —
**весь Bro** (модель eve: корень, worker, otp) думает через этот
Codex. Если входа нет, карантин или квота кончилась — как сейчас,
OpenRouter. Компьютер — как у Companion: постоянный Linux на человека.

Провайдер машины (2026-09-08): **box (ASCII)**, не Vercel Sandbox.
Оператор готов поднять план box до максимального, когда юзеров станет
много. Референс: [box.ascii.dev](https://box.ascii.dev/),
[docs.ascii.dev/box](https://docs.ascii.dev/box/platform-guide).

Референс продукта: [companion.result.dev](https://companion.result.dev/) —
тот же жанр (iMessage-агент), но мозг и инструменты живут на
персональной машине пользователя, а не на общем OpenRouter.

## Решение

Один Bro, две модели. Тулы те же.

1. **Модель хода.** Перед каждым ходом смотрим тенанта. Есть живой
   Codex-токен → eve идёт в
   `chatgpt.com/backend-api/codex/responses` (как `chatgpt()` в eve).
   Нет входа / карантин / 401 / квота → тот же ход на OpenRouter
   (`z-ai/glm-5.3-flash`), как сейчас. Человеку одна короткая строка,
   если только что отвалились с Codex.
2. **Личный компьютер** — один box на тенанта. Файлы, bash, CLI, MCP.
   iMessage и Telegram — одна машина. `boxId` живёт в Convex, не в
   имени сессии eve.

Вход тот же: device-code Codex OAuth с телефона. Токены в Convex как
сейф (AES-256-GCM, subject = tenantId). Тот же токен:

- кормит модель eve (весь Bro: корень, worker, otp);
- кладётся в `~/.codex/auth.json` на resume машины, чтобы CLI/MCP
  на диске человека тоже были «его ChatGPT».

`chatgpt()` из eve читает локальный `codex login` и **в деплое не
работает**. Нам нужен свой `CodexTokenBroker` на тенанта: `getToken`
достаёт/рефрешит из Convex. eve уже принимает `broker` в
`createCodexSubscriptionModel`. Модель — `defineDynamic` на
`turn.started` (есть в eve), fallback в манифесте — OpenRouter.

STT голоса остаётся OpenRouter: это не Codex.

Мозг Bro **не** идёт через `POST /boxes/{id}/prompt`. Это Codex/Claude
ASCII со своими ключами. Bro остаётся в eve. Box — диск, shell, MCP,
CLI. `box prompt` не вызываем.

```
iMessage / Telegram
  └─ eve Bro
       модель: Codex этого человека  или  OpenRouter
       ├─ browser_task / worker / composio / vault  — как сейчас
       └─ computer_*  → box (ASCII)  boxId в Convex
              Ubuntu, /workspace, CLI, MCP, Docker
              + ~/.codex/auth.json если вход есть
```

## Почему не текущий sandbox и не Vercel

Сейчас у Bro нет компьютера человека:

- eve `bash` / `read_file` / `write_file` — эфемерный sandbox
  **сессии** eve, не тенанта. iMessage и Telegram дали бы две машины.
- Composio `COMPOSIO_REMOTE_*` — постпроцессор больших ответов,
  сеть запрещена (`agent/lib/sandbox-policy.ts`).
- Kernel / Browser Use — облачный браузер, не CLI/файлы/MCP.

eve `vercel()` backend умеет named persistent sandbox, но ключ —
`sessionKey` хода, не `principalId`. Это остаётся **сессионным**
sandbox eve, не компьютером человека.

Провайдер компьютера: **box (ASCII)**. Полная Ubuntu VM, свой диск,
SSH, Docker, IPv4, десктоп, Codex CLI из коробки. HTTP API + TS SDK
(`@asciidev/box-sdk`). Паттерн «бокс своим юзерам» уже в доке:
`noEnv`, `TENANT_ID`, fork с шаблона, stop/resume.

Почему не Vercel Sandbox как комп: сессионный контракт eve, нет
Docker/SSH/IP, снапшоты **$0.08/GB-мес** (100 дисков сами по себе
дороже compute), active-CPU + память пока машина жива. Bro уже на
Vercel — eve и деплой там остаются; компьютер — отдельно.

E2B / Daytona / Sprites — запасной путь, если box упрётся в регион
или вендора. На старте не берём: дороже на часе и/или пол $150.

## ChatGPT OAuth

Официального API «третье приложение тратит Plus» нет. Есть
first-party Codex OAuth (`auth.openai.com`, client
`app_EMoamEEZ73f0CkXaXp7hrann`). Так ходят OpenClaw / OpenCode /
Companion. OpenAI это терпит у Codex-клиентов; это не публичный
продукт. Поэтому:

- токены **никогда** не пулим и не реселлим;
- один subject = один tenantId, CAS по `version`;
- Bro без ChatGPT полноценный (OpenRouter);
- при `invalid_grant` / 401 — карантин этого тенанта, этот ход и
  следующие до нового входа — OpenRouter, не чужой ключ.

### Поток

Device-code (телефон, без localhost callback):

1. Кабинет «Подключить ChatGPT» или фраза в чате →
   `POST /me/chatgpt/start` (cabinet session) или tool
   `chatgpt_connect`.
2. Convex action: `POST auth.openai.com/api/accounts/deviceauth/usercode`.
3. Bro пишет в iMessage ссылку `https://auth.openai.com/codex/device`
   и код. Кабинет показывает то же.
4. Поллинг `deviceauth/token` (5s, slow_down +5s, дедлайн ~15 мин).
5. Exchange → access + refresh. Шифруем vault-схемой
   (`BRO_VAULT_KEY`, HKDF на tenant, AAD
   `tenantId\0chatgpt\0oauth`). Метаданные без секрета:
   `planType`, `email`, `connectedAt`, `version`, `quarantinedAt`.
6. Resume компьютера кладёт `~/.codex/auth.json` (mode 600).
   `codex` на машине сам рефрешит; мы рефрешим в Convex, если
   пишем файл заново (singleflight + CAS, margin 120s).

Отключение: кабинет / «отключи chatgpt» → delete row + `codex logout`
на машине. Следующий ход уже OpenRouter.

Модель токен не видит — только broker на сервере.

Free ChatGPT без Plus: connect может пройти, Codex упрётся в квоту.
Этот ход падает на OpenRouter. В чат: «ChatGPT закончился, делаю
как обычно».

## Компьютер

### Провайдер и деньги

Аккаунт Bro в ASCII, ключ `BOX_API_KEY` только на сервере Bro
(Vercel / Convex action). На бокс человека ключ не кладём.

Стартовый план **$20/мес** (555 часов default 4/8, 100 concurrent).
Когда DAU упрётся в старты или часы — апгрейд: $100 / $500 / **$2000**
(до 1500 concurrent). Оператор это принял. Ставка та же:
**$0.036/час** default, **$0.018/час** small. Стоп = $0, последний
снапшот входит (12 / 50 / 70 GB по типу).

Старты (create / fork / resume) лимитированы планом. На $20 —
**150 стартов/день**. Поэтому не resume на каждое сообщение: после
чата держим тёплым **15–30 минут**, потом `stop`. Иначе апгрейд
плана раньше, чем кончатся часы.

Регионы box — только EU (DE / FI / FR). Диск и снапшоты там.

v1 размер: **`small`** (2/4), если не упрёмся. Default — если нужен
Docker/десктоп тяжелее. Не держать флот 24/7.

### Данные

`computers` (один ряд на тенанта):

- `tenantId`, `boxId` (`bx_…`),
  `boxName` (человекочитаемое, `bro-<tenantId>`),
  `size` (`small | default | large`),
  `status` (`missing | provisioning | running | stopped | error`),
  `lastActiveAt`, `createdAt`,
  `chatgpt` (`none | connected | quarantined`).

`chatgptCredentials` (секрет, `"use node"`): ciphertext + version +
quarantine. Не отдаём в `/me` целиком.

`computerMcp` (опционально, пакет 2): `tenantId`, `name`, `command`
или `url`, `envHandle` (секрет в vault). Пишется в
`~/.codex/config.toml` / MCP json на машине.

`/me` +: `{ computer: { status, lastActiveAt }, chatgpt: { status, plan?, email? } }`.
Секретов нет. `boxId` в кабинет не светим как секрет, но и не
отдаём модели.

### Жизненный цикл

- Шаблон Bro (один на аккаунт): ставим утилиты, `codex` CLI если
  нет, рабочий `/workspace`. `stop` — снапшот шаблона.
- Первый компьютер тенанта → `fork` шаблона с
  `{ noEnv: true, ttlSeconds: null, env: { TENANT_ID } }`.
  Имя `bro-<tenantId>`. Пишем `boxId` в Convex.
- Нет шаблона на спайке — `create` с теми же флагами, `onCreate`
  ставит минимум.
- Команда: если `stopped` → `resume` (тоже `noEnv`), poll до
  `ready`/`idle`, затем `POST /commands` или files API.
- Простой 15–30 мин → `stop` (снапшот, compute = 0). Удаление —
  явная команда в кабинете («стереть диск»), не logout ChatGPT
  и не idle-timeout.
- `409 box_starting` — подождать ready, не слать команду вслепую.

`BOX_API_KEY`, `BRO_VAULT_KEY`, Inkbox на машину не попадают.
`noEnv: true` обязателен. На диск — только Codex auth этого
тенанта и его MCP secrets.

### Тулы (v1)

Имя / boxId от `ctx.session.auth.principalId` / `tenantId(ctx)`,
никогда из аргументов модели. Group — `groupPersonalBlock`, как vault.

- `computer_exec` — bash на машине человека (сеть **разрешена**;
  сайты для покупок всё ещё `browser_task`).
- `computer_read` / `computer_write` / `computer_ls` — `/workspace`.
- `chatgpt_connect` / `chatgpt_status` — старт device-flow и статус.
- Не подменять Composio sandbox. Тот остаётся без сети для
  больших JSON.
- Не звать `box.prompt`.

Инструкции: файлы, скрипты, git, MCP/CLI — компьютер. WB/Ozon/врачи —
`browser_task`. «Поставь gh / mcp X» — `computer_exec`, не обещать
из чата, что уже стоит.

### Кабинет

Карточка «Компьютер»: статус, «разбудить», «выключить», «стереть
диск». Карточка «ChatGPT»: подключить / отключить, plan, email.
Статический `cabinet.html`, как оплата и память. Без React.

## Пакеты

Код — тонкие обёртки. Логика в `agent/lib/computer.ts`,
`agent/lib/chatgpt-oauth.ts`, `convex/lib/computerPolicy.ts`,
`shared/chatgptCrypto.ts` (тот же AES конверт, другой AAD).
Клиент box — `agent/lib/boxClient.ts` (обёртка над
`@asciidev/box-sdk` или `fetch` на `https://ascii.dev/api/box/v1`).

**P0 — спайк (обязателен первым).** Один `noEnv` box: create →
write file → stop → resume → read file. Тот же `boxId`, как будто
два хода (iMessage, потом Telegram). Без eve session sandbox.
Check: `npm run computer:spike`. Нужен `BOX_API_KEY` в env агента,
не в репо.

**P1 — компьютер.** Schema `computers`, getOrCreate/fork, три тулы
файлов/exec, cabinet card, group guard, idle-stop 15–30 мин,
billing hook (счётчик computer-минут; цифры отдельным коммитом
когда будут замеры). Check: `npm run computer:check`.

**P2 — ChatGPT connect + модель Bro.** Device-code, шифрование,
iMessage + кабинет, карантин, `~/.codex/auth.json` на resume.
`broModel()` становится динамическим: живой токен тенанта →
`createCodexSubscriptionModel` + tenant broker; иначе сегодняшний
OpenRouter. То же для worker и otp. Check: `npm run chatgpt:check`,
`npm run model:check`.

**P3 — MCP/CLI человека.** `computerMcp` + запись конфига Codex
на машине. Check: `npm run computer-mcp:check`.

## Отвергнуто

- BYOK API key как единственный путь — это не Plus.
- Только Codex без OpenRouter-fallback — ломает Bro без входа.
- eve `chatgpt()` как есть — читает локальный CLI, в Vercel падает.
- Один eve-session sandbox на чат — две машины на iMessage+Telegram.
- **Vercel Sandbox как компьютер человека** — не ноутбук, дорогой
  диск, сессионный ключ eve. Eve sandbox остаётся собой.
- `box.prompt` как мозг Bro — чужие ключи ASCII, не вход юзера.
- Composio workbench как «компьютер» — нет сети, нет persistence
  как продукта, нет Codex.
- Browser-login на chatgpt.com — хрупко, против ToS, пароль в
  Bro-профиле.
- Пул токенов / «наш Plus на всех».
- Флот always-on (~$26/бокс/мес) — только если юзер явно просит
  «не гаси, пусть качается».

## Риски

- Codex OAuth — first-party client_id. OpenAI может сузить.
  Fallback: Bro без ChatGPT. Не строить биллинг на чужой квоте.
- box — молодой вендор, только EU. Запасной путь: Sprites / E2B,
  тот же `computers.boxId` абстрагировать как `provider + remoteId`.
- Лимит стартов. Idle-окно обязательно. На росте — план $100–$2000,
  не always-on.
- Сеть с машины: пользовательский код и MCP. Не класть
  `BRO_VAULT_KEY` / Inkbox / `BOX_API_KEY` в env машины. На машину —
  только Codex auth этого тенанта и его MCP secrets.
- Group chat не должен видеть диск и ChatGPT.
- Stop отказан, если снапшот не пишется. Не `force` из idle-job.

## Вне скоупа v1

Windows/macOS desktop как ОС человека, маркетплейс ChatGPT Apps
внутри Bro, биллинг compute в рублях (сначала структурный счётчик).
STT на Codex. Десктоп/VNC box и `host` URL — можно позже, не блокер
P0–P2.
