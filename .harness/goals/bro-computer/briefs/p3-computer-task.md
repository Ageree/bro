# P3 — root-тул `computer_task`, промпт `computer_poll`, инструкции

Контекст: Bro получает «компьютер на человека» на Maritime. Параллельно P1
пишет `agent/lib/maritime.ts` + `agent/lib/computer-policy.ts`, P2 — Convex
(`setComputer`, поля `tenants.computer*`, wakeup kind `computer_poll`). Ты
пишешь тул и промпт **по контрактам ниже** — файлы P1/P2 могут ещё не
существовать, импортируй по именам как написано; Lead интегрирует и прогонит
`tsc`. Прочитай перед работой: `agent/tools/browser_task.ts` (образец:
лимит, persist, follow-through, уведомление), `agent/lib/browser-policy.ts`,
`agent/lib/tenant.ts`, `agent/lib/convex.ts`, `agent/channels/imessage.ts`
(роут `/internal/wakeup`, ветки по kind), `agent/instructions.md`, спеку
`docs/superpowers/specs/2026-09-01-bro-computer-maritime-design.md`.
Стиль: минимальный код, идиомы репо, zod, без новых зависимостей. Не трогай
`vendor/`, `convex/`, `agent/lib/` (кроме чтения), `agent/subagents/`,
`imessage-text.ts`.

## Файлы (только эти)

- `agent/tools/computer_task.ts` — новый.
- `agent/channels/imessage.ts` — только ветка `else if (kind === "computer_poll")` рядом с `browser_poll`.
- `agent/instructions.md` — секция про `computer_task`.

## Контракты, на которые опираешься (реализуют P1/P2)

```ts
// agent/lib/computer-policy.ts
computerBackend(raw?: string): "off" | "maritime"
computerExternalId(phoneE164: string): string
computerAgentName(phoneE164: string): string
computerTemplate(raw?: string): string
computerDesktopWanted(raw?: string): boolean
computerInstructions(): string
mapAgentStatus(status: string | null | undefined): "provisioning" | "ready" | "sleeping" | "error" | "unknown"
liveViewDecision(view: { liveViewUrl: string | null; reason?: string | null }): { url?: string; hint: string }
chatOutcome(reply: string | null | undefined, elapsedMs: number): "done" | "working" | "blocked" | "empty"
computerPollTimedOut(startedAt: number | undefined, now: number): boolean
POLL_INTERVAL_MINUTES: number   // 2

// agent/lib/maritime.ts
class MaritimeError extends Error { status: number; code?: string }
maritimeEnabled(): boolean
provisionAgent(args: { name; templateId; externalId; instructions?; description?; desktop?; idleTtlSeconds?; tier? }, signal?): Promise<{ agent: { id: string; status: string; desktopEnabled: boolean }; created: boolean }>
getAgent(id, signal?): Promise<{ id: string; status: string }>
chat(id, message, opts?: { conversationId?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ response: string | null; error?: string }>
liveView(id, signal?): Promise<{ liveViewUrl: string | null; sessionId: string | null; startedAt: string | null; reason: string | null }>
setDesktop(id, enabled: boolean, signal?): Promise<{ ok: true } | { ok: false; reason: "paid_plan_required" }>

// agent/lib/convex.ts (P2 добавляет)
setComputer(phoneE164, patch: { computerAgentId?; computerProvider?; computerStatus?; computerLiveUrl?; computerLiveAt?; computerTask?; computerConversationId?; computerProvisionedAt?; computerStartedAt?; clearLive?: boolean }): Promise<void>
scheduleWakeup({ tenantPhone, at, kind: "computer_poll", payload, recurMinutes }): Promise<string>
cancelWakeup(tenantPhone, { kind: "computer_poll" }): Promise<number>
// уже есть: upsertTenant(phone) → tenant с полями computer*, countBrowserJobStart(phone), tenantId(ctx)
```

## `agent/tools/computer_task.ts`

`defineTool` из `eve/tools`, как `browser_task`.

description (EN, одна строка): personal cloud computer for the human — a
persistent Maritime micro-VM with its own browser and saved logins; use for
multi-step web errands that should survive between turns or need the human to
watch/take over; starts an assignment or checks the current one; never starts a
second assignment while one is working.

inputSchema: `{ task: z.string().min(1).max(4000), reset: z.boolean().optional() }`.

Алгоритм `execute({task, reset}, ctx)`:

1. `phone = tenantId(ctx)`. Если `computerBackend(process.env.BRO_COMPUTER_BACKEND) !== "maritime"` или `!maritimeEnabled()` → `return { status: "off", hint: "компьютер не подключён на этом хосте — используй browser_task или worker" }`. Никаких сетевых вызовов.
2. `tenant = await upsertTenant(phone)`.
3. **Продолжение**: если `tenant.computerAgentId` и `tenant.computerStatus` не `error`, и `!reset`, и `tenant.computerStartedAt` задан → это опрос: `chat(agentId, "статус", { conversationId: tenant.computerConversationId })`; если `computerPollTimedOut(tenant.computerStartedAt, Date.now())` → `cancelWakeup(kind:"computer_poll")`, `setComputer({clearLive:true, computerStartedAt: undefined…})` — поле снять нельзя через optional, поэтому просто не трогай `computerStartedAt`, а верни `{status:"error", hint:"задание висит слишком долго, скажи человеку и предложи reset"}`. Иначе перейди к шагу 6 с `elapsed`.
   Если `computerStartedAt` не задан (компьютер есть, задания нет) → новое задание: шаг 4.
4. **Лимит**: `countBrowserJobStart(phone)` как в `browser_task` (тот же `browserGateFromResult`); `!allowed` → `{ status: "limit", hint: "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату" }`.
5. **Provision**: если нет `tenant.computerAgentId` или `reset`:
   `provisionAgent({ name: computerAgentName(phone), externalId: computerExternalId(phone), templateId: computerTemplate(), instructions: computerInstructions(), description: "Bro computer", desktop: computerDesktopWanted(), idleTtlSeconds: 900, tier: "smart" }, ctx.abortSignal)`.
   Если бросило `MaritimeError` со `status === 402` и `desktop` был true — повтори без `desktop` и добавь в результат `desktop: "paid_plan_required"`. Сохрани `setComputer(phone, { computerAgentId, computerProvider: "maritime", computerStatus: mapAgentStatus(agent.status), computerProvisionedAt: Date.now() })`. Если `mapAgentStatus` = `provisioning` → верни `{ status: "provisioning", hint: "компьютер поднимается (~1 минута); скажи человеку, что начнёшь через минуту, и поставь себе wakeup через computer_poll" }` **и** сам поставь `scheduleWakeup({ tenantPhone: phone, at: Date.now() + 60_000, kind: "computer_poll", payload: task, recurMinutes: POLL_INTERVAL_MINUTES })`, а `setComputer({ computerTask: task, computerStartedAt: Date.now() })`.
6. **Задание**: `startedAt = Date.now()`; `setComputer({ computerTask: task, computerStartedAt: startedAt })` (для нового задания; для опроса — не трогай). `t0 = Date.now()`; `const { response, error } = await chat(agentId, message, { conversationId: tenant.computerConversationId, signal: ctx.abortSignal })` где `message` для нового задания = `task`, для опроса = `"статус"`. Оберни `chat` в try/catch: `MaritimeError` → `{status:"error", hint: <message>}`; при `error` в ответе — тоже `error`.
   `outcome = chatOutcome(response, Date.now() - t0)`.
7. **Live view**: `view = await liveView(agentId).catch(() => ({ liveViewUrl: null, sessionId: null, startedAt: null, reason: "unavailable" }))`; `decision = liveViewDecision(view)`; если `decision.url` → `setComputer({ computerLiveUrl: decision.url, computerLiveAt: Date.now() })`, иначе `setComputer({ clearLive: true })`.
8. **Исход**:
   - `done` → `cancelWakeup(phone, {kind:"computer_poll"}).catch(()=>{})`; `setComputer({ computerStatus: "ready" })`; вернуть `{ status: "done", reply: response, liveUrl: decision.url, hint: "Передай результат человеку своими словами. Не запускай второе задание." }`.
   - `working` или `empty` → `scheduleWakeup({ tenantPhone: phone, at: Date.now() + POLL_INTERVAL_MINUTES*60_000, kind: "computer_poll", payload: tenant.computerTask ?? task, recurMinutes: POLL_INTERVAL_MINUTES }).catch(err => console.error("computer poll wakeup failed", err))`; вернуть `{ status: "working", reply: response ?? null, liveUrl: decision.url, hint: "Компьютер работает. Bro сам напишет, когда закончит. Не обещай «спроси позже»." + " " + decision.hint }`.
   - `blocked` → `cancelWakeup(kind:"computer_poll")`; вернуть `{ status: "blocked", reply: response, liveUrl: decision.url, hint: decision.url ? "Нужен человек. Пришли ссылку, чтобы он посмотрел и вмешался (CAPTCHA/подтверждение). Никогда не проси вводить пароль по ссылке." : "Нужен человек, но live view нет. Спроси у человека то, что просит компьютер, и повтори computer_task с ответом." }`.
   Всегда прокидывай `agentStatus` (последний известный) в результат.

Никаких `sendBlueIMessage` из тула (уведомление «начал» делает агент сам, как
для `worker`). Секреты: тул никогда не пересылает пароли/коды в `chat` —
если `task` содержит явный пароль-подобный паттерн, не проверяй (это задача
инструкций агента), просто не логируй `task`.

## `agent/channels/imessage.ts` — ветка `computer_poll`

Рядом с `browser_poll`:

```ts
} else if (kind === "computer_poll") {
  prompt = `[background wakeup] Проверь, что делает компьютер человека: вызови тул computer_task с task=${payload}. Если done — передай результат человеку. Если blocked — коротко скажи, что нужно от него, и пришли liveUrl, если он есть (никогда не проси вводить пароль по ссылке). Если working или provisioning — ответь ровно [SILENT]: проверка повторится сама. Если error — коротко скажи и предложи reset.`;
}
```

Ничего больше в роуте не менять.

## `agent/instructions.md`

Добавить короткую секцию (RU, в стиле соседних) после описания `worker`:
когда `computer_task` (многошаговые дела, которые должны жить между ходами;
когда человек хочет видеть процесс или вмешаться; когда сайт помнит логин на
его компьютере), когда по-прежнему `browser_task` (быстрый публичный поиск) и
`worker` (логин/карта из сейфа). Правила: одно задание на человека; `working`
→ Bro сам напишет; `blocked` с `liveUrl` → отправь ссылку как «посмотреть и
вмешаться», без пароля; `off` → не упоминай компьютер, используй другой тул;
`limit` → как у `browser_task`.

## Верификация

```bash
npm run -s types:check   # может падать на импортах из P1/P2, пока Lead не интегрирует — укажи, какие именно ошибки остались
```

НЕ запускай convex-команды, `eve build`, ничего не создавай в Maritime. НЕ коммить.
В конце — список файлов + остаток ошибок tsc (если есть).
