# Юнит W3: экраны `/workspace` и `/workspace/admin`, лендинг `/`

Ты исполнитель. Сначала прочитай `.claude/plan/PROTOCOL.md` (этой же служебной ветки
`origin/claude/speedup-plan`), `AGENTS.md`, `docs/dev-notes.md`. Ветка юнита —
`claude/speed-workspace` от свежего `origin/bro-next`. Параллельно: W1 (`/chat/history`,
`db/services/chats.ts`, `/workspace/memory`, чтение списка расписаний в `db/services`) и W2
(`/chat/**`, `web/components/ai-elements/**`) — их файлы не трогай. Твои:
`app/(authenticated)/workspace/(overview)/**`, `app/(authenticated)/workspace/admin/**`,
`app/(public)/**` (лендинг), `web/trpc/**`, `db/services`, которые читают только эти
страницы, `app/(authenticated)/_components/**`.

## Что нашёл координатор (прод, 18.10)

- JS: `/workspace` — 1,39 МБ (400 КБ сжато), 20 скриптов; `/` — 0,75 МБ (234 КБ), HTML
  141 КБ. TTFB снаружи ≈ 0,5 с — это сеть прокси сессии, а не сервер.
- `/workspace/admin` зовёт процедуры через `createCaller` (`admin/_lib/caller.ts`), охрана —
  `adminProcedure` в `web/trpc/router.ts`.

## Что сделать

1. Обзор `/workspace`: какие данные грузятся последовательно (await подряд → `Promise.all`
   или параллельные `Suspense`-границы со стримингом), какие секции клиентские без нужды,
   сколько запросов делает страница после гидратации (tRPC на клиенте, которые можно
   отдать сервером в первом HTML). Замер — число и время запросов к базе на рендер
   (логируй запросы drizzle локально), байты JS маршрута.
2. `/workspace/admin`: то же; тяжёлые агрегаты — с индексами, без N+1; текст хода
   остаётся по клику (`admin.transcript`).
3. Лендинг `/`: байты JS и HTML, картинки (`next/image`, размеры, `priority` только у
   первого экрана), шрифты (subset, `display`), — без изменения вида: правила дизайна в
   `docs/dev-notes.md` («Дизайн», «Публичный лендинг»).
4. Общий бандл: что тянут все страницы (провайдеры в `app/_providers`, tRPC-клиент,
   иконки) — вынести лишнее из общего чанка, если замер это подтверждает.

## Ограничения

- Вид страниц не меняется. `package.json` `name` не трогать.
- `agent/**` не трогать (правило слоёв: `app/` не импортирует `agent/`).

## Результат

Черновой PR в `bro-next` с таблицей замеров, проверкой для прода, откатом. Затем
остановись.
