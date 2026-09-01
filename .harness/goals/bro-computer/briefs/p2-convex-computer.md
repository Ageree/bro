# P2 — Convex: tenants.computer*, setComputer, wakeup `computer_poll`, кабинет

Контекст: Bro получает «компьютер на человека» на Maritime; eve-тул
`computer_task` (пишется параллельно в P3) будет хранить состояние компьютера в
тенанте и ставить фоновые проверки. Прочитай перед работой: `convex/schema.ts`,
`convex/tenants.ts` (`tenantDoc`, `setBrowser` — образец patch-мутации),
`convex/wakeups.ts` (как валидируется kind и дедуп singleton-kind'ов),
`agent/lib/convex.ts` (обёртки), `agent/tools/cancel_wakeup.ts`,
`convex/cabinet.ts` + `convex/lib/cabinetPolicy.ts` + `cabinet.html` +
`assets/auth.js` (как рендерится snapshot), `scripts/cabinet-check.ts`,
`scripts/wakeups-check.ts`. Спека:
`docs/superpowers/specs/2026-09-01-bro-computer-maritime-design.md`.
Стиль: минимальный код, идиомы репо, validators на args/returns, без новых
зависимостей. Не трогай `vendor/`, `convex/_generated/` (типы подхватятся через
`typeof tenants`), `agent/tools/` кроме `cancel_wakeup.ts`, `agent/channels/`,
`agent/subagents/`.

## Файлы (только эти)

`convex/schema.ts`, `convex/tenants.ts`, `convex/wakeups.ts`,
`convex/cabinet.ts`, `convex/lib/cabinetPolicy.ts`, `agent/lib/convex.ts`,
`agent/tools/cancel_wakeup.ts`, `cabinet.html`, `assets/auth.js`,
`scripts/cabinet-check.ts`, `scripts/wakeups-check.ts`.

## 1. Схема тенанта (`convex/schema.ts` + `tenantDoc` в `convex/tenants.ts`)

Добавить optional-поля (все `v.optional`):

```
computerAgentId: v.string()        // id агента в Maritime
computerProvider: v.string()       // "maritime"
computerStatus: v.string()         // provisioning | ready | sleeping | error | unknown
computerLiveUrl: v.string()        // live view, если сессия браузера активна
computerLiveAt: v.number()         // когда liveUrl обновлён (ms)
computerTask: v.string()           // текущее/последнее задание
computerConversationId: v.string() // conversation_id для /chat
computerProvisionedAt: v.number()
computerStartedAt: v.number()      // старт текущего задания (для «сдаёмся через 30 мин»)
```

## 2. Мутация `setComputer` (`convex/tenants.ts`) — по образцу `setBrowser`

```ts
export const setComputer = mutation({
  args: { secret: v.string(), phoneE164: v.string(),
    computerAgentId: v.optional(v.string()), computerProvider: v.optional(v.string()),
    computerStatus: v.optional(v.string()), computerLiveUrl: v.optional(v.string()),
    computerLiveAt: v.optional(v.number()), computerTask: v.optional(v.string()),
    computerConversationId: v.optional(v.string()), computerProvisionedAt: v.optional(v.number()),
    computerStartedAt: v.optional(v.number()),
    clearLive: v.optional(v.boolean()) },   // true → computerLiveUrl/computerLiveAt = undefined
  returns: v.null(), ... })
```

`assertSecret`, тенант по `by_phone` (если нет — `throw new Error("unknown tenant")`),
patch только переданных полей; `clearLive` снимает live-поля.

Обёртка в `agent/lib/convex.ts` (рядом с `setBrowser`):

```ts
export async function setComputer(phoneE164: string, patch: {
  computerAgentId?: string; computerProvider?: string; computerStatus?: string;
  computerLiveUrl?: string; computerLiveAt?: number; computerTask?: string;
  computerConversationId?: string; computerProvisionedAt?: number;
  computerStartedAt?: number; clearLive?: boolean;
}): Promise<void>
```

## 3. Wakeup kind `computer_poll`

Везде, где перечислен `"job_check"`, добавить `"computer_poll"`:
`convex/schema.ts` (wakeups.kind), `convex/wakeups.ts` (validator и, если есть,
списки singleton-kind'ов — `computer_poll` **singleton per tenant**, как
`browser_poll`: повторный schedule патчит существующий scheduled того же kind),
`agent/lib/convex.ts` (типы в `scheduleWakeup`/`cancelWakeup`),
`agent/tools/cancel_wakeup.ts` (z.enum). `scripts/wakeups-check.ts`: добавь
assert, что `computer_poll` — singleton (по образцу существующих asserts про
`browser_poll`/`job_check`).

## 4. Кабинет: блок «Компьютер»

`convex/cabinet.ts` `snapshotValidator` + `snapshotForTenant` +
`convex/lib/cabinetPolicy.ts` `buildSnapshot`/`CabinetSnapshot`: добавить
optional `computer`:

```ts
computer: v.optional(v.object({
  status: v.string(),                 // из tenant.computerStatus
  task: v.optional(v.string()),
  liveViewUrl: v.optional(v.string()),// только если tenant.computerLiveAt свежий (< 30 мин от now), иначе не отдавать
  updatedAt: v.optional(v.number()),  // computerLiveAt ?? computerStartedAt ?? computerProvisionedAt
}))
```

Решение «свежий ли liveUrl» — чистая функция в `cabinetPolicy.ts`
(`computerView({ status, task, liveUrl, liveAt, startedAt, provisionedAt, now })
→ snapshot.computer | undefined`; `undefined`, если нет `computerAgentId`).
Asserts в `scripts/cabinet-check.ts`: нет компьютера → undefined; свежий
liveAt → liveViewUrl есть; старый (> 30 мин) → нет; status пробрасывается.

`cabinet.html` + `assets/auth.js`: после блока лимитов добавить секцию
«Компьютер»: статус по-русски (`ready` → «готов», `provisioning` →
«поднимается», `sleeping` → «спит», `error` → «ошибка», иначе «—»), строка
«Сейчас: <task>» если есть, и кнопка/ссылка «Вмешаться» (`target=_blank`,
`rel=noopener`) только при `liveViewUrl`. Если `computer` отсутствует — секцию
скрыть. Стиль — как соседние блоки, без новых стилей/скриптов.

## Верификация

```bash
npm run -s types:check
npm run -s cabinet:check
npm run -s wakeups:check
npm run -s access:check
```

НЕ запускай convex-команды (`npx convex …`), `eve build`. НЕ коммить.
В конце — список файлов + вывод команд.
