# Bro — ChatGPT OAuth + личный компьютер

_Date: 2026-09-07_

Утверждено оператором: вход через **Codex OAuth**. Если вход есть —
**весь Bro** (модель eve: корень, worker, otp) думает через этот
Codex. Если входа нет, карантин или квота кончилась — как сейчас,
OpenRouter. Компьютер — как у Companion: постоянный Linux на человека.

Референс: [companion.result.dev](https://companion.result.dev/) — тот же
жанр (iMessage-агент), но мозг и инструменты живут на персональной
машине пользователя, а не на общем OpenRouter.

## Решение

Один Bro, две модели. Тулы те же.

1. **Модель хода.** Перед каждым ходом смотрим тенанта. Есть живой
   Codex-токен → eve идёт в
   `chatgpt.com/backend-api/codex/responses` (как `chatgpt()` в eve).
   Нет входа / карантин / 401 / квота → тот же ход на OpenRouter
   (`z-ai/glm-5.3-flash`), как сейчас. Человеку одна короткая строка,
   если только что отвалились с Codex.
2. **Личный компьютер** — один persistent Vercel Sandbox на тенанта
   (`bro-computer-<tenantId>`). Файлы, bash, CLI, MCP. iMessage и
   Telegram — одна машина.

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

```
iMessage / Telegram
  └─ eve Bro
       модель: Codex этого человека  или  OpenRouter
       ├─ browser_task / worker / composio / vault  — как сейчас
       └─ computer_*  → Vercel Sandbox bro-computer-<tenant>
              /workspace, CLI, MCP
              + ~/.codex/auth.json если вход есть
```

## Почему не текущий sandbox

Сейчас у Bro нет компьютера человека:

- eve `bash` / `read_file` / `write_file` — эфемерный sandbox
  **сессии** eve, не тенанта. iMessage и Telegram дали бы две машины.
- Composio `COMPOSIO_REMOTE_*` — постпроцессор больших ответов,
  сеть запрещена (`agent/lib/sandbox-policy.ts`).
- Kernel / Browser Use — облачный браузер, не CLI/файлы/MCP.

eve `vercel()` backend уже умеет named persistent sandbox и
resume, но ключ — `sessionKey` хода, не `principalId`. Для
«один комп на человека» имя машины задаём сами.

Провайдер: **Vercel Sandbox**. Bro уже на Vercel; eve имеет
`eve/sandbox/vercel`; persistence GA; idle → snapshot, resume
автоматический; active-CPU billing. E2B / Daytona — запасной путь,
если named-sandbox на тенанта упрётся в лимит eve.

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

### Данные

`computers` (один ряд на тенанта):

- `tenantId`, `vercelName` (`bro-computer-<tenantId>`),
  `status` (`missing | running | stopped | error`),
  `lastActiveAt`, `createdAt`,
  `chatgpt` (`none | connected | quarantined`).

`chatgptCredentials` (секрет, `"use node"`): ciphertext + version +
quarantine. Не отдаём в `/me` целиком.

`computerMcp` (опционально, пакет 2): `tenantId`, `name`, `command`
или `url`, `envHandle` (секрет в vault). Пишется в
`~/.codex/config.toml` / MCP json на машине.

`/me` +: `{ computer: { status, lastActiveAt }, chatgpt: { status, plan?, email? } }`.
Секретов нет.

### Жизненный цикл

- Первый `computer_*` или «подготовь комп» →
  `Sandbox.getOrCreate({ name })`. `onCreate`: node/python, `codex`
  CLI, базовые утилиты. Snapshot.
- Простой → `stop()` (snapshot, compute ≈ 0). Следующая команда
  resume.
- Snapshot expiration 30 дней, `keepLastSnapshots: 1`. Иначе Vercel
  снесёт машину через 14 дней без snapshot.
- Имя стабильное. Удаление компьютера — явная команда в кабинете
  («стереть диск»), не при logout ChatGPT.

### Тулы (v1)

Имя от `ctx.session.auth.principalId` / `tenantId(ctx)`, никогда из
аргументов модели. Group — `groupPersonalBlock`, как vault.

- `computer_exec` — bash на машине человека (сеть **разрешена**;
  сайты для покупок всё ещё `browser_task`).
- `computer_read` / `computer_write` / `computer_ls` — `/workspace`.
- `chatgpt_connect` / `chatgpt_status` — старт device-flow и статус.
- Не подменять Composio sandbox. Тот остаётся без сети для
  больших JSON.

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

**P0 — спайк (обязателен первым).** Named Vercel Sandbox
`bro-computer-<id>`: create → write file → stop → get → read file
с другого «хода». Если eve `vercel()` нельзя ключить по
`principalId` — свой `@vercel/sandbox` клиент, eve default sandbox
не выдаём за компьютер человека. Check: `npm run computer:spike`.

**P1 — компьютер.** Schema `computers`, getOrCreate, три тулы
файлов/exec, cabinet card, group guard, billing hook
(счётчик computer-минут, лимит рядом с browser jobs; цифры
отдельным коммитом когда будут замеры). Check:
`npm run computer:check`.

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
- Composio workbench как «компьютер» — нет сети, нет persistence
  как продукта, нет Codex.
- Browser-login на chatgpt.com — хрупко, против ToS, пароль в
  Bro-профиле.
- Пул токенов / «наш Plus на всех».

## Риски

- Codex OAuth — first-party client_id. OpenAI может сузить.
  Fallback: Bro без ChatGPT. Не строить биллинг на чужой квоте.
- Vercel Sandbox region / Hobby timeout. Продакшен — Pro, timeout
  сессии часами, не 5 минут; persistence отдельно от timeout.
- Сеть с машины: пользовательский код и MCP. Не класть
  `BRO_VAULT_KEY` / Inkbox в env машины. На машину — только
  Codex auth этого тенанта и его MCP secrets.
- Group chat не должен видеть диск и ChatGPT.

## Вне скоупа v1

Windows/macOS desktop, VNC, установка произвольных GUI-приложений,
маркетплейс ChatGPT Apps внутри Bro, биллинг compute в рублях
(сначала структурный счётчик). STT на Codex.
