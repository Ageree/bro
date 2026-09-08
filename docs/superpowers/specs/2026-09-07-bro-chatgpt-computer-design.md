# Bro — ChatGPT OAuth + личный компьютер

_Date: 2026-09-07 · computer: box 2026-09-08 · уточнение: Fable 5.1 + eve 0.47.6_

Утверждено оператором: вход через **Codex OAuth**. Если вход есть —
**весь Bro** (корень, worker, otp) думает через этот Codex. Если входа
нет, карантин или квота кончилась — OpenRouter как сейчас. Компьютер —
постоянный Linux на человека, провайдер **box (ASCII)**.

Референс продукта: [companion.result.dev](https://companion.result.dev/).
Референс машины: [box.ascii.dev](https://box.ascii.dev/),
[docs.ascii.dev/box](https://docs.ascii.dev/box/platform-guide).

## Решение

Один Bro, две модели. Тулы те же.

1. **Модель хода.** На каждом `step.started` смотрим тенанта. Есть живой
   Codex-токен и ход не групповой → свой Codex-транспорт в
   `chatgpt.com/backend-api/codex/responses`. Нет входа / карантин /
   401 / квота / группа → OpenRouter (`z-ai/glm-5.3-flash`). Человеку
   одна короткая строка, если только что отвалились с Codex.
2. **Личный компьютер** — один box на Convex-тенанта. `boxId` в Convex.
   iMessage и Telegram — одна машина. Мозг Bro **не** через
   `POST /boxes/{id}/prompt`.

Имена не путать:

- `phoneE164` — principal eve (`tenantId(ctx)` в `agent/lib/tenant.ts`).
- `tenantId` — `Id<"tenants">` в Convex. HKDF, AAD, имя бокса, `TENANT_ID`
  в ASCII — только это. Телефон в ASCII не уходит.

Вход: device-code Codex OAuth с телефона. Токены в Convex тем же AES, что
сейф (`encryptVaultSecret`, handle `chatgpt:oauth`). Тот же access-токен:

- кормит модель eve через `CodexTokenBroker`;
- на resume машины пишется в `~/.codex/auth.json` **без `refresh_token`**.

STT голоса остаётся OpenRouter.

```
iMessage / Telegram
  └─ eve Bro
       модель: Codex этого человека  или  OpenRouter
       ├─ browser_task / worker / composio / vault  — как сейчас
       └─ computer_*  → box (ASCII)  boxId в Convex
              /home/user, CLI, MCP, Docker
              + ~/.codex/auth.json без refresh, если вход есть
```

## Почему не текущий sandbox и не Vercel

Сейчас у Bro нет компьютера человека:

- eve `bash` / `read_file` / `write_file` — эфемерный sandbox **сессии**.
  iMessage и Telegram уже делят `inkboxConversationId`, но это не продукт.
- Composio remote — постобработка, сеть запрещена
  (`agent/lib/sandbox-policy.ts`).
- Kernel / Browser Use — браузер, не CLI/файлы/MCP.

Провайдер компьютера: **box**. Eve и деплой остаются на Vercel. E2B /
Daytona / Sprites — запасной путь (`provider + remoteId`), на старте нет.

## Модель Bro (eve 0.47.6)

`chatgpt()` из `eve/models/openai` читает локальный CLI. `eve deploy`
такое блокирует. Внутри пакета есть `createCodexSubscriptionModel` +
`broker` (`CodexTransportOptions`), но **из `exports` не торчит** — только
`chatgpt()`. Deep-import в `eve/dist` режет exports map.

Делаем `agent/lib/codex-model.ts`: тот же транспорт (переписать
`/v1/responses` → Codex endpoint, заголовки Bearer / Account-Id,
повтор на 401 через `getToken({ reason: "rejected" })`). Интерфейс
брокера как в eve `token-broker.d.ts`.

`defineDynamic` модели: **только `step.started`**. Session/turn
selections в eve — строки id; живой `LanguageModel` (OpenRouter wrap и
Codex) можно вернуть лишь с шага. Fallback в манифесте нет — резолвер
каждый шаг возвращает модель. В результате всегда
`modelContextWindowTokens` (иначе eve лезет в каталог Gateway).

Группа (`isGroupTurn`) → всегда OpenRouter. Иначе чужой Plus.

401 / 402 / 429 **до первого чанка** → карантин тенанта, тот же вызов
на OpenRouter (`withFallback`). После старта стрима не переключаемся.

`BRO_CODEX_MODEL` default = eve `gpt-5.6-sol`, окно 200k.
`outputCapMiddleware` — только OpenRouter-ветка. Корень держит
`DEFAULT_ROOT_CONTEXT_TOKENS`.

`worker` — статический сабагент, та же динамическая модель на
`step.started`. `otp` сегодня `defineDynamic(turn.started)` +
`...broModel()` (живой объект). eve пишет: у динамического сабагента
модель — строка id, вложенный `defineDynamic` нельзя. Перед P2: сделать
otp статическим, group-guard оставить в тулах; если `eve build` не
съест динамическую модель у сабагентов — worker/otp остаются на
OpenRouter, корень на Codex.

## ChatGPT OAuth

Нет официального API «третье приложение тратит Plus». First-party Codex
OAuth (`auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann`). Токены
не пулим. Один subject = один Convex tenant, CAS по `version`. Bro без
входа полноценный.

Поток (как `codex-rs` device_code_auth):

1. Кабинет или `chatgpt_connect` → `POST /me/chatgpt/start`.
2. Convex: `POST …/deviceauth/usercode { client_id }` →
   `device_auth_id`, `user_code`, `interval`.
3. В чат: `https://auth.openai.com/codex/device` + код.
4. Поллинг `deviceauth/token` цепочкой `ctx.scheduler` (action ~10 мин,
   дедлайн 15). 403/404 = ещё не подтвердил, спать `interval`.
5. Успех → `authorization_code` + PKCE → `POST …/oauth/token`.
   `account_id` из access JWT, `planType` из id_token.
6. Шифруем `encryptVaultSecret(master, tenantId, "chatgpt:oauth", json)`.
   Отдельный `chatgptCrypto.ts` не заводим.

Отключение: кабинет / тул → delete row + на живом боксе `codex logout`
и стереть `auth.json`. Следующий ход — OpenRouter.

Два рефрешера на один refresh-token нельзя: CLI ротирует refresh.
На бокс — `id_token`, `access_token`, `account_id`, без refresh.
Единственный рефрешер — Convex (singleflight + CAS, margin 120 с).

Модель токен не видит. `BOX_API_KEY` и `BRO_VAULT_KEY` на машину не
идут. OAuth HTTP живёт в Convex actions; агент только брокер
`tokenForAgent`.

## Компьютер

### Деньги и TTL

`BOX_API_KEY` и `BOX_ORG_ID` только на Vercel (eve). Кабинет и Convex
ходят в `POST /internal/computer` с `BRO_INTERNAL_SECRET`, как wakeup.
Convex ключ ASCII не хранит. Биллинг на org (`X-Box-Org`), не на
Personal — без org header `POST /boxes` даёт 402.

Старт **$20/мес** (555 ч default, 100 concurrent, **150 стартов/день**).
Рост — $100 / $500 / $2000. Оператор принял максимум. Ставка
$0.036/ч default, $0.018/ч small. Стоп = $0.

Старты (create / fork / resume) лимитированы сильнее, чем часы.
Поэтому idle-stop — **нативный `ttlSeconds`**, default **900**.
Таймер от старта машины: после `computer_*`, если
`archiveAfter - now < TTL/2`, `PATCH { ttlSeconds: TTL }`. Своего
крона на стоп нет. Перед resume: `GET /limits` (`canStart`,
`starts.day.remaining`).

v1 размер: **`small`**. Регионы box — EU. Always-on только если человек
сказал «не гаси».

Тенантный лимит стартов (поверх ASCII): free **3**/день, paid **20**,
env `BRO_FREE_COMPUTER_STARTS_PER_DAY` / `BRO_PAID_…`. Резерв аккаунта
ASCII: 10 стартов.

### Данные

`computers` — один ряд на `Id<"tenants">`: `boxId`, `size`, `lastState`,
`lastStateAt`, `lastActiveAt`, `resumedAt`, `createdAt`. Индексы
`by_tenant`, `by_box`. Колонки chatgpt нет.

`chatgptAccounts` — мета без секрета: `accountId`, `email?`, `planType?`,
`connectedAt`, `version`, `accessExpiresAt`, `quarantinedAt?`.

`chatgptSecrets` (`"use node"`): ciphertext + version.

`chatgptLogins` — device-flow: `deviceAuthId`, `userCode`, `interval`,
`expiresAt`, `status`.

`computerMcp` — P3.

`/me` +: `{ computer: { state, lastActiveAt, archiveAfter? }, chatgpt: { status: none|pending|connected|quarantined, planType?, email? } }`.
Ни `boxId`, ни `userCode` в снапшоте (`userCode` только у `/me/chatgpt/start`).

Статус в Convex — кэш. Истина: `GET /boxes/{id}`. `archived` → resume;
`archiving` / `provisioning` / `cloning` → ждать; `ready|idle|running` →
команда. `409 box_starting` — не слать вслепую.

### Жизненный цикл

- Шаблон аккаунта (`BOX_TEMPLATE_ID`): утилиты, `codex` CLI, `gh`,
  node, python. Собрать скриптом `computer:template`, не в рантайме.
- Первый комп → `fork` шаблона
  `{ noEnv: true, ttlSeconds: 900, env: { TENANT_ID: <convexId> } }`
  + `Idempotency-Key: bro:<tenantId>:v1`. Имя — `PATCH` после создания
  (`bro-<convexId>`). Нет шаблона на спайке — `create` с теми же флагами.
- Файлы: корень **`/home/user`** (не `/workspace`). `chmod 600` на
  `auth.json` отдельной командой.
- Удаление — кабинет «стереть диск» (`DELETE` + строка Convex), не
  logout ChatGPT и не TTL.

`noEnv: true` обязателен.

### Тулы v1

Principal только из ctx. `groupPersonalBlock`, как vault. Отказ на
`local-dev` / shared.

- `computer_exec` — bash, сеть разрешена; `cwd?`, `timeoutSeconds` ≤ 240,
  `detached?` / `processId?`.
- `computer_read` / `computer_write` — `/home/user`, read ≤ 64 КБ.
- `computer_screenshot` — PNG рабочего стола (X/ffmpeg), картинка модели,
  файл в `/home/user/screens`.
- `computer_record` — mp4 1–60 с в `/home/user/recordings`, путь в ответ,
  не гонять ролик в модель.
- `computer_power` — `status | stop`. Стереть диск — только кабинет.
- `chatgpt_connect` / `chatgpt_status` / `chatgpt_disconnect`.
- `ls` через exec. `box.prompt` не звать.

### Маршрутизация

| Нужно | Тул |
|---|---|
| Файлы, скрипты, git, CLI, MCP, скачать и сохранить | `computer_*` |
| Экран машины: кадр / короткое видео | `computer_screenshot` / `computer_record` |
| Сайты: покупки, брони, врачи | `browser_task` |
| Один экран / 3-D Secure / OTP, если browser_task не дожал | `worker` |
| Временные вычисления хода | eve `bash` / files — не диск человека |
| Постобработка больших ответов Composio | Composio sandbox, без сети |
| Группа | `computer_*` / `chatgpt_*` блок; модель OpenRouter |
| Wakeup | как сейчас `browser_task`; computer из wakeup — P3 |

Браузер на боксе для сайтов в v1 не используем — третий браузер.

### Кабинет

Карточка «Компьютер»: state, разбудить / выключить / стереть диск.
Карточка «ChatGPT»: подключить / отключить, plan, email.
Статический `cabinet.html`. Bearer → `tenantId` из сессии → eve
`/internal/computer`.

## Пакеты

Тонкие обёртки. Логика: `agent/lib/computer.ts`,
`agent/lib/boxClient.ts` (fetch на `https://ascii.dev/api/box/v1`),
`agent/lib/codex-model.ts`, `agent/lib/chatgpt-oauth.ts` (только
брокер), `convex/lib/computerPolicy.ts`, `convex/lib/chatgptPolicy.ts`,
`convex/computers.ts`, `convex/chatgpt.ts`, `convex/chatgptSecrets.ts`.
Крипта — существующий `shared/vaultCrypto.ts`.

**P0 — спайк.** С ключом: `scripts/computer-spike.ts` — create small
`noEnv` ttl 900 → write → cat → PATCH ttl → stop → resume → cat тот же
файл → `GET /limits`. Без ключа заранее: клиент + `computerPolicy` +
`scripts/lib/fake-box.ts` + `npm run computer:check`.

**P1 — компьютер.** Schema `computers`, `ensureRunning`, тулы, кабинет,
`/internal/computer`, шаблон, лимит стартов. Check: один resume на два
параллельных вызова; TTL продлевается только при остатке < TTL/2;
group / local-dev отказ. Acceptance: iMessage пишет файл, Telegram
через 20 мин читает после автостопа.

**P2 — ChatGPT + модель.** Device-code + scheduler, шифрование,
карантин, `resolveBroModel` на `step.started`, `auth.json` без refresh.
Checks: `chatgpt:check`, `model:check`, `eve build` / `eve dev` с
динамической моделью. Acceptance: Plus оператора → лог `codex`;
disconnect → OpenRouter; голос без изменений.

**P3 — MCP/CLI.** `computerMcp`, `~/.codex/config.toml`, wakeup
`computer_poll`.

## Отвергнуто

- BYOK API key как единственный путь.
- Только Codex без OpenRouter-fallback.
- eve `chatgpt()` как есть; deep-import `createCodexSubscriptionModel`.
- `defineDynamic` модели на `session.started` / `turn.started`.
- Один eve-session sandbox как комп человека.
- Vercel Sandbox как комп; `@asciidev/eve-box` как backend Bro
  (ключ — sessionKey).
- `box.prompt` как мозг Bro.
- Composio workbench как компьютер.
- Browser-login на chatgpt.com; пул токенов.
- Флот always-on.
- `refresh_token` на боксе; `BOX_API_KEY` в Convex.
- `/workspace` как корень файлов.
- `computers.chatgpt`; отдельный `chatgptCrypto.ts`.
- Крон на idle-stop; `computer_ls` как отдельный тул.
- Браузер/десктоп бокса для сайтов в v1.

## Риски

- Codex OAuth — first-party client_id. Не строить биллинг на чужой квоте.
- box — молодой вендор, только EU.
- Лимит стартов важнее часов. Длинный TTL дешевле апгрейда плана.
- Сеть с машины. На диск — только Codex access этого тенанта и его MCP.
- Group chat не видит диск и ChatGPT.
- Stop отказан, если снапшот не пишется. Не `force` из idle.
- eve может не принять динамическую модель у сабагентов — тогда Codex
  только в корне.

## Вне скоупа v1

Windows/macOS как ОС человека, ChatGPT Apps внутри Bro, биллинг compute
в рублях, STT на Codex, VNC/`host` URL как продуктовая фича.

## Дефолты (оператору решать не надо)

TTL 900 с, `small`, free 3 / paid 20 стартов в день, резерв ASCII 10,
`BRO_CODEX_MODEL` = eve default.
