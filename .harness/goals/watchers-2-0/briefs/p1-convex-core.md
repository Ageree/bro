# P1 — Convex core: схема, policy, watchers.ts, /composio, крон

Прочитай `briefs/contract.md` разделы 1, 2, 5 и файлы для стиля:
`convex/wakeups.ts`, `convex/lib/wakeupPolicy.ts`, `convex/http.ts`,
`convex/schema.ts`, `convex/crons.ts`, `convex/secret.ts`, `convex/archive.ts`.

Файлы этого пакета (только они):

1. `convex/lib/watcherPolicy.ts` — новый, ровно контракт §1. Чистые функции,
   без импортов Convex-рантайма кроме `timingSafeEqual` из `../secret`.
   Web Crypto через `globalThis.crypto.subtle`. Base64 без Buffer
   (`btoa(String.fromCharCode(...bytes))`), файл импортируется и Node-скриптами
   и Convex-рантаймом.
2. `convex/schema.ts` — таблицы `watchers`, `composioEvents` (контракт §2),
   с комментариями в стиле файла.
3. `convex/watchers.ts` — новый, функции контракта §2. `assertSecret` в
   public-функциях, `args`+`returns` у всех, `await` у всех промисов,
   индексы вместо `.filter()`. `wakeupDoc`-подобный `watcherDoc` валидатор.
4. `convex/http.ts` — маршрут `POST /composio` (контракт §2), импорты из
   `./lib/watcherPolicy`.
5. `convex/crons.ts` — `prune composio events` раз в 24 ч.

НЕ трогай `convex/_generated/` (Lead регенерирует), `agent/**`, `scripts/**`,
`package.json`. НЕ запускай convex-команды, НЕ коммить.

В конце: список файлов + `npx tsc --noEmit` может ругаться только на
`internal.watchers.*` / `api.watchers.*` (нет codegen) — остальное чисто.
