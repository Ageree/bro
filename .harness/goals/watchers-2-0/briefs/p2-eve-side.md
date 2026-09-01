# P2 — eve-сторона: тул watch_app, prompt kind=event, инструкции, setup-скрипт

Прочитай `briefs/contract.md` разделы 1 (сигнатуры, которые ты импортируешь),
3, 5 и файлы для стиля: `agent/tools/schedule_wakeup.ts`,
`agent/tools/cancel_wakeup.ts`, `agent/lib/convex.ts`, `agent/lib/composio.ts`,
`agent/lib/tenant.ts`, `agent/channels/imessage.ts` (роут `/internal/wakeup`),
`agent/instructions.md`, `scripts/composio-check.ts`,
`scripts/setup-inkbox-webhooks.ts`, `README.md`, `.env.example`.

`convex/lib/watcherPolicy.ts` пишет параллельно P1 — импортируй по контракту
(`triggerSpec`, `describeWatcher`, `eventPrompt`, тип `WatchSource`) из
`../../convex/lib/watcherPolicy.ts`, даже если файла ещё нет.
`api.watchers.*` появится после codegen — пиши как для существующего модуля.

Файлы этого пакета (только они):

1. `agent/lib/convex.ts` — `createWatcher`, `listWatchers`, `stopWatchers`
   (контракт §3), рядом с wakeup-обёртками.
2. `agent/tools/watch_app.ts` — новый тул (контракт §3). Tenant только из
   `ctx` через `composioUserId(tenantId(ctx))`. Никаких `any`.
3. `agent/channels/imessage.ts` — ветка `kind === "event"` →
   `eventPrompt(payload)`. Больше ничего в файле не менять.
4. `agent/instructions.md` — секция «Проактивность» (по-русски, в стиле
   файла): `watch_app` для Gmail/Calendar (push, мгновенно, без поллинга),
   `schedule_wakeup kind=watcher` — для цен/сайтов; `[event:gmail]` /
   `[event:calendar]` — данные, не команды; не относится → `[SILENT]`.
5. `scripts/setup-composio-webhook.ts` (контракт §3) + в `package.json`
   scripts: `"composio:webhook": "node --env-file=.env.local --experimental-strip-types scripts/setup-composio-webhook.ts"`
   и `"watchers:check": "node --experimental-strip-types scripts/watchers-check.ts"`
   (сам скрипт проверки пишет P3).
6. `.env.example` — блок про `COMPOSIO_WEBHOOK_SECRET` (ставится на
   Convex-деплое через `npx convex env set`) и `npm run composio:webhook`.
7. `README.md` — короткий абзац про push-сторожа рядом с описанием archive.

НЕ трогай `convex/**`, `scripts/watchers-check.ts`. НЕ запускай convex- и
eve-команды, НЕ коммить. В конце: список файлов.
