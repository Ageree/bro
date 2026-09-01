# Goal: Bro Computer — per-tenant компьютер на Maritime (фаза 1)

Bro (eve + Convex + Inkbox + Kernel worker + Browser Use) получает третий
исполнитель веб-дел: **персистентный компьютер на человека** на Maritime
(YC F26, managed cloud для агентов: microVM per agent, sleep/wake, $1/агент/мес).

## Что строим (утверждено оператором 2026-09-01, «частично перейти»)

За флагом `BRO_COMPUTER_BACKEND=maritime` + `MARITIME_TOKEN`:

1. **Клиент + политика** — `agent/lib/maritime.ts` (REST на fetch),
   `agent/lib/computer-policy.ts` (чистые функции), `scripts/computer-check.ts`.
2. **Convex** — `tenants.computer*` (agentId, provider, status, liveUrl,
   liveAt, task, conversationId, provisionedAt) + `setComputer`; wakeup kind
   `computer_poll`; кабинет показывает «что сейчас делает Bro» и кнопку
   «Вмешаться» (live view).
3. **Тул `computer_task`** — lazy-provision компьютера (idempotent по хэшу
   E.164), `/chat` с `conversation_id`, live view, follow-through через
   `computer_poll`; промпт-ветка в `/internal/wakeup`; инструкции агента.

Мозг (eve на Vercel), control plane (Convex), касса (ЮKassa), кабинет, vault,
Kernel-`worker` и Inkbox — **не трогаем**.

## Ограничения

- Ponytail: минимальный код, `fetch` вместо SDK, без новых зависимостей.
- КОД ПИШУТ grok-субагенты пакетами (P1/P2/P3 параллельно, файлы не
  пересекаются), Lead (Claude) планирует, интегрирует, верифицирует, коммитит.
- Не трогать: `vendor/`, `convex/_generated/`, `imessage-text.ts`,
  `agent/subagents/worker/**`, `index.html`.
- Телефон никогда не уходит в Maritime (externalId/name — sha256-хэш).
- В VM не кладём секреты Bro. Live view — только для CAPTCHA/3DS/takeover.
- Без флага и токена всё работает как раньше; `computer_task` отвечает `off`.
- Не запускать convex-команды и `eve deploy`; проверка — `tsc --noEmit` +
  `*:check` скрипты + `MARITIME_LIVE=1 npm run computer:check` у Lead.

## Факты спайка (см. спеку `docs/superpowers/specs/2026-09-01-bro-computer-maritime-design.md`)

- `desktop` — только платный план (402 `seat_limit`), поэтому фаза 1 идёт на
  `openclaw_browser` + Browserbase live view; desktop за env-гейтом.
- `identity` (Inkbox через Maritime) — 503, их лимит; используем свою Inkbox.
- `/chat` — окно ~30 с; длинное задание = `computer_poll`.
