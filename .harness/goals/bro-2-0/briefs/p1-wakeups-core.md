# P1 — Wakeups core (Convex + eve + тулы)

Ты — исполнитель одного пакета работ в репо Bro (личный iMessage-консьерж:
eve-агент + Convex + Inkbox). Пиши МИНИМАЛЬНЫЙ код в стиле репо (читай соседние
файлы: convex/tenants.ts, agent/channels/imessage.ts, agent/tools/browser_task.ts —
и повторяй их идиомы). Никаких новых npm-зависимостей. Комментарии — только
там, где код сам не объясняет ограничение; в стиле существующих `// ponytail:`.

## Что строим

Примитив «wakeups»: отложенные/повторяющиеся фоновые пробуждения агента
per-tenant. Convex хранит и диспетчеризует; eve-роут исполняет ход агента;
агент может ответить человеку в iMessage или промолчать.

## Файлы (только эти; НЕ трогай vendor/, convex/_generated/, index.html)

### 1. convex/schema.ts — добавь таблицу

```ts
wakeups: defineTable({
  tenantPhone: v.string(),          // phoneE164 тенанта
  at: v.number(),                   // epoch ms
  kind: v.union(v.literal("reminder"), v.literal("browser_poll"), v.literal("brief"), v.literal("watcher")),
  payload: v.string(),              // что сделать/проверить (текст для агента)
  status: v.union(v.literal("scheduled"), v.literal("running"), v.literal("done"), v.literal("cancelled"), v.literal("failed")),
  recurMinutes: v.optional(v.number()), // повтор каждые N минут
  recurDailyHour: v.optional(v.number()), // ежедневный в этот час (tz тенанта)
  tz: v.optional(v.string()),       // IANA, default Europe/Moscow
  lastSeen: v.optional(v.string()), // для watchers: последнее увиденное состояние
  attempts: v.optional(v.number()),
})
  .index("by_status_at", ["status", "at"])
  .index("by_tenant", ["tenantPhone"])
```

### 2. convex/lib/wakeupPolicy.ts — ЧИСТЫЕ функции (без Convex-импортов)

- `parseWhen(input: { atIso?: string; inMinutes?: number }, now: number): number | null`
  — валидирует и возвращает epoch ms (null если мусор/прошлое дальше чем на 2 мин).
- `nextDailyAt(hour: number, tz: string, now: number): number` — следующее
  наступление hour:00 в tz. Реализуй через Intl.DateTimeFormat (стдлиб, без
  зависимостей): найди смещение tz и вычисли ближайший будущий момент.
- `backoffAt(attempts: number, now: number): number` — now + 5 мин * 2^attempts.
- `giveUp(attempts: number): boolean` — attempts >= 4.
- `nextAfterRun(w: { recurMinutes?: number; recurDailyHour?: number; tz?: string }, now: number): number | null`
  — когда планировать следующий запуск (null = одноразовый).

### 3. convex/wakeups.ts

Все публичные функции secret-gated через `assertSecret` (см. tenants.ts).

- `schedule` (mutation, public+secret): args {secret, tenantPhone, at, kind, payload, recurMinutes?, recurDailyHour?, tz?} → id. Если для tenant+kind==="brief" уже есть scheduled brief — замени (patch), не плоди дубли.
- `cancel` (mutation, public+secret): args {secret, tenantPhone, id? , kind?} — по id ИЛИ все scheduled данного kind у тенанта → count.
- `listForTenant` (query, public+secret): scheduled/running wakeups тенанта (для тула и отладки).
- `claimDue` (internalMutation): взять до 10 wakeups где status=="scheduled" и at<=now (by_status_at), каждому status="running", вернуть массив doc'ов. Атомарность: это ОДНА мутация — Convex сериализует.
- `finish` (internalMutation): args {id, ok}. ok → если nextAfterRun даёт время: status="scheduled", at=next, attempts=0; иначе status="done". !ok → attempts+1; giveUp ? status="failed" : status="scheduled", at=backoffAt.
- `dispatchDue` (internalAction): читает process.env.EVE_URL и process.env.BRO_INTERNAL_SECRET; если EVE_URL пуст — return (тихий no-op, ponytail-коммент). runMutation(claimDue). Для каждого: runQuery(internal.tenants.getByPhoneInternal, {phoneE164}) — ДОБАВЬ этот internalQuery в convex/tenants.ts (копия getByPhone без secret-аргумента). Если нет тенанта или нет inkboxConversationId → finish(ok:false). Иначе POST `${EVE_URL}/internal/wakeup` JSON {secret, wakeupId, tenantPhone, conversationId, inkboxHandle, kind, payload, lastSeen} c AbortSignal.timeout(60_000); 2xx → finish(ok:true), не-2xx/throw → finish(ok:false). Ответ роута может содержать {lastSeen} — если да, patch wakeup.lastSeen через отдельную internalMutation `setLastSeen`.

### 4. convex/crons.ts (новый)

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval("dispatch wakeups", { seconds: 60 }, internal.wakeups.dispatchDue, {});
export default crons;
```

### 5. agent/channels/imessage.ts — добавь POST("/internal/wakeup")

По образцу существующего POST webhooks/imessage. Логика:
- парсь JSON; если body.secret !== process.env.BRO_INTERNAL_SECRET → 401.
- Собери промпт фонового хода, например:
  `[background wakeup] kind=${kind}. Задание: ${payload}. Сейчас ${new Date().toISOString()}. Если сказать человеку нечего или задание неактуально — ответь ровно [SILENT].` (для watcher добавь lastSeen в текст).
- `await from(conversationId).send(prompt, { auth: { authenticator: "inkbox", issuer: "inkbox", principalType: "user", principalId: tenantPhone, attributes: { conversationId, inkboxHandle } } })` — ровно та же форма auth, что во входящем вебхуке.
- Верни 200 JSON {ok:true}.

В обработчике `message.completed`: если текст после trim начинается с `[SILENT]` — не отправлять ничего (return до нарезки на bubbles).

### 6. agent/lib/convex.ts — клиентские обёртки

`scheduleWakeup`, `cancelWakeup`, `listWakeups` — как существующие обёртки, НО:
`convex/_generated/api` не знает новых модулей до codegen, поэтому для wakeups
используй `anyApi` из "convex/server": `anyApi.wakeups.schedule` и т.д.
`// ponytail: anyApi до codegen; после convex deploy можно вернуть typed api`.

### 7. agent/tools/schedule_wakeup.ts и agent/tools/cancel_wakeup.ts

По образцу agent/tools/memo_note.ts (defineTool + zod + tenantId(ctx)).
- schedule_wakeup: { payload: string (что сделать/о чём напомнить, на языке
  человека), atIso?: string, inMinutes?: number, dailyHour?: number,
  everyMinutes?: number } → парси время через wakeupPolicy.parseWhen /
  nextDailyAt (импортируй из "../../convex/lib/wakeupPolicy" — это чистый
  модуль, можно). kind: dailyHour ⇒ "brief" если payload про бриф — НЕТ,
  проще: тул принимает kind: z.enum(["reminder","brief","watcher"]).default("reminder").
  Верни человекочитаемое подтверждение со временем.
- cancel_wakeup: { id?: string, kind?: enum } → cancelWakeup → "cancelled N".
- Описания тулов — короткие, английские, в стиле memo_note ("Schedule a future
  wake-up for this person…"). tenant ТОЛЬКО из ctx.

### 8. scripts/wakeups-check.ts + package.json

Оффлайн-проверка ЧИСТЫХ функций wakeupPolicy (стиль scripts/access-policy-check.ts:
голые assert, никаких фреймворков):
- parseWhen: ISO в будущем ок; прошлое → null; мусор → null; inMinutes=5 ок.
- nextDailyAt: для tz "Europe/Moscow" результат в будущем, разница с now < 24h+1мин, и в 
  этот момент в tz именно указанный час (проверь через Intl.DateTimeFormat hourCycle h23).
- backoffAt растёт; giveUp(4)===true, giveUp(3)===false.
- nextAfterRun: {recurMinutes:30} → now+30мин; {recurDailyHour:8,tz} → будущее; {} → null.
Заверши `console.log("wakeups-check ok")`. В package.json добавь
`"wakeups:check": "node --experimental-strip-types scripts/wakeups-check.ts"`.

### 9. .env.example — добавь

```
# eve base URL for background wakeups (set on the CONVEX deployment env)
# EVE_URL=https://bro-agent.vercel.app
```

## Верификация (обязана быть зелёной перед завершением)

```bash
source ~/.nvm/nvm.sh && nvm use 24
npx eve build           # exit 0, затем в .eve/agent-summary.json diagnostics.errors==0
npm run -s wakeups:check
npm run -s access:check && npm run -s browser:check && npm run -s connect-link:check && npm run -s imessage:check
```

НЕ запускай `convex dev/deploy/codegen` (деплой делает Lead). НЕ коммить.
В конце выведи список изменённых файлов и результаты проверок.
