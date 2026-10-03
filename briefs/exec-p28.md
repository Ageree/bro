ultracode

Ты — исполнитель в работах над Бро (личный ассистент в мессенджерах), репозиторий `Ageree/bro`, основная ветка `bro-next`, прод https://brobro.tech. Работу ведёт сессия-оркестратор: она ревьюит, сливает твои PR и выкатывает их на прод. Владелец пишет оркестратору; ты владельцу не пишешь и вопросов не задаёшь — решай сам, а то, что может сделать только владелец, записывай в описание PR.

## Как работать

1. Сначала: `AGENTS.md` и `docs/dev-notes.md` (подключены через `CLAUDE.md`), свой пункт в `docs/roadmap.md`, `docs/instinct.md` (разделы 4–5 и 7). Ниже — разбор кода по твоему пункту, который сделал исследователь оркестратора: это сильная отправная точка, но проверяй утверждения в коде.
2. Окружение свежей облачной сессии: `pnpm install`; Node 24 по `docs/dev-notes.md`, раздел «Процесс» (`npm pack node-linux-x64@24` в scratchpad, `bin` — в начало `PATH`); vitest — через `env -u TELEGRAM_BOT_USERNAME`; для сборок заглушки `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (не короче 32 знаков). Локальный Postgres для миграций — от не-root, данные вне `/tmp/claude-0` (`setpriv --reuid=postgres`).
3. Ultracode включён: на каждую содержательную часть запускай workflow с подагентами (модель opus 5.5, effort high): проект решения с независимыми вариантами, реализация, состязательное ревью (корректность, безопасность и правила fail-closed, кэш промпта, правила `AGENTS.md`) до пуша. Токены не экономь.
4. Поведение, меняющее ответы Бро или фоновые действия, — только за флагом-списком воркспейсов (образец: `STEP_CONTEXT_WORKSPACES`, `agent/lib/workspace-list.ts`, переменная — в `shared/environment/env.ts`). Оркестратор включит флаг владельцу, прогонит бенчмарк и потом включит всем.
5. Перед каждым пушем — все четыре зелёные: `pnpm types:generate && pnpm check --concurrency=1`, `pnpm build`, `pnpm build:eve` (с заглушками env). Видимое человеку (страница, форма) — с браузерным тестом в `e2e/` и закоммиченным `.e2e/cache/` (`docs/e2e.md`). Миграции генерируй поверх свежего `bro-next` прямо перед просьбой о слиянии (dev-notes: превью и прод делят базу, порядок `when` важен), делай их идемпотентными.
6. PR — в `bro-next`, НЕ в черновике (cubic ревьюит только готовые). Коммиты и заголовки PR — по-русски, с точки зрения пользователя. Каждый PR — законченный кусок со своими тестами; большой пункт — несколько PR по порядку. Сразу подпишись на свой PR (`subscribe_pr_activity`) и доводи до зелёного CI. Находки cubic — баг-репорты: исправь или ответь в треде с причиной и закрой тред.
7. Когда PR зелёный, конфликтов нет и треды cubic закрыты — оставь в PR комментарий «Готово к слиянию» и список «Что проверить на проде после выката» (команды, SQL только агрегатами, ожидаемый результат). Сам НЕ сливай, НЕ выкатывай, env прода не трогай. Следующий PR пункта начинай от `bro-next` после слияния предыдущего (или веткой поверх него, если ждать долго — тогда отметь зависимость в описании).
8. Неочевидное — короткой записью в `docs/dev-notes.md` тем же PR. Сделанный пункт вычеркни в `docs/roadmap.md` в последнем PR пункта.
9. Пункты 24 (навыки, `SKILLS_WORKSPACES`) и 25 (один набор инструментов на ход, `STEP_CONTEXT_WORKSPACES`) уже слиты в `bro-next`. Правки в `agent/agent.ts`, `agent/instructions/*`, `agent/lib/model/*`, `agent/lib/skills/*`, `agent/lib/turn-kind/*` допустимы, но: без флагов блок инструментов и схемы должны остаться байт в байт (`tests/agent/tools/flag-off.test.ts`), ядро навыков — не больше 10 тыс. токенов (`tests/agent/skills/core.test.ts`), внутри хода блок инструментов под пилотом не меняется (разрешённые точки — `docs/agent-costs.md`, 3.2). Новый текст инструкций для дела — в тело навыка (`<!-- skill:… -->`), а не в ядро. Новый инструмент добавляет схему в каждый шаг: описание — коротко (до ~600 знаков).
10. Безопасность Бро — сильная сторона, её не ослаблять: правила fail-closed, `said.ts`, карточки подтверждения, `startedByPerson`, лимит трат, модель не видит секретов, текст страниц и писем — данные, а не инструкции. Никаких действий от имени человека без его слов в этом ходе.
11. Ветки называй `claude/<твоя-ветка>-<тема>`; всё, что важно, — в git: контейнер облачной сессии временный.

## Твоё задание: пункт 28 — один разговор и сжатие

Текст пункта — `docs/roadmap.md`, п. 28. Нужно:
- Сжатие истории: порог не ниже 100 тыс. токенов реального окна модели (у DeepSeek V4.1 Flash на RouterAI — сверь `ROUTERAI_MODEL_CONTEXT_TOKENS` и `shared/environment/env.ts`), старые результаты инструментов урезаются до краткого следа (что вызвано и чем кончилось), а не тянутся в каждом шаге.
- Одна история на человека через все каналы (веб, Telegram, iMessage) — по разбору ниже реши, что реально в eve 0.62, и сделай минимальный безопасный шаг; что не делается — запиши в PR и роадмап.
- Сжатие уже взаимодействует с навыками (`agent/memory/bro_skills.ts` сворачивает блоки в заглушки на `compaction.completed`) и с памятью (`recall` на `compaction.completed`): не сломай их, тесты есть.
- Готово: шаг Telegram не растёт с длиной разговора (оркестратор меряет `scripts/cloudru-app-host/ops/usage-stats.sh`, раздел «by their place in the whole session»), бенчмарк не просел.
- Всё, что меняет ответы, — за флагом-списком воркспейсов.

Ниже — разбор кода исследователем оркестратора (проверяй утверждения в коде):

1. CURRENT STATE

- **Compaction config.** `agent/agent.ts:334` sets `compaction: { thresholdPercent: 0.7 }`. The task subagent has the same setting at `agent/subagents/task/agent.ts:19`. The window comes from the dynamic model: `directModelSelection` returns `modelContextWindowTokens: endpoint.contextTokens` at `agent/lib/model/direct.ts:1083`. That value is `OPENROUTER_MODEL_CONTEXT_TOKENS` (1,000,000, `shared/environment/env.ts:536`) or `ROUTERAI_MODEL_CONTEXT_TOKENS` (1,048,576, `env.ts:597`).
  - So compaction fires at about 700–734k total input, which in practice never happens. Old tool results are never trimmed.
  - Telegram step is about 96k tokens: a 63k envelope (instructions 30.9k plus 58 tool schemas 32.1k) and about 30k of history (`docs/agent-costs.md` 3.2).
- **Session keying.** Every channel has its own durable eve session, and each lives for eve's default 30 days. `limits` is not set in `agent/agent.ts`.
  - Telegram: one session per private chat, continuation token `<chatId>::` (`agent/channels/telegram.ts:300-316`, parsed in `agent/lib/telegram-conversation.ts`).
  - iMessage: one per Photon thread (`agent/channels/photon.ts:271-282`, `conversationId = context.thread.id`).
  - Web: one per chat session (`agent/channels/eve.ts`).
  - `chats.channel` is filled from `ctx.channel.kind` in `agent/hooks/session-owner.ts`.
  - The only cross-channel continuity today is memory (`personal_info`, the `workstreams` index, `agent/lib/memory/profile.ts`) and report routing (`reportConversations` in `db/services/scheduled-agent-jobs.ts`).
- **Large items in history:**
  - The browser report is a user-role turn opener, not a tool result: `agent/lib/browser-use/completion.ts:729-760`, delivered at `:845-879`. Its links JSON can reach 16k characters (`outcome.ts:65`).
  - The `browser_task` call input can be up to 8,000 characters (`agent/tools/browser_task.ts:265`). This sits in the assistant `tool-call` part.
  - `gmail-read-thread` returns up to 12,000 characters per message (`agent/lib/google-workspace/gmail.ts:1135`).
- **Readers of history.** The `step.started` resolver in `agent/agent.ts` (roughly lines 82–330) reads `ctx.messages`, which is eve's history, not the provider prompt. It uses:
  - `turnOpenedByBackgroundTask`, `startsTurn` and `currentTurnMessages` (`agent/lib/delivery/turn-sends.ts:461-500`)
  - `turnSends`, `turnDelivered`, `awaitsDelivery`, `turnAwaitsAnswer`, `outcomeToldEarlier`, `personLanguage`
  - `personWordsThisTurn`, `codesNotFromPerson` and `quotedFromPerson` (`agent/lib/browser-use/said.ts:168`)

  `startedByPerson` (`agent/lib/mode.ts:69`) uses auth only.
- **Existing per-step prompt rewriting.** AI SDK middleware in `direct.ts` (around lines 1052–1075) already rewrites the prompt every step. `stepNoteMiddleware` and `defuseStepNoteTag` run under `STEP_CONTEXT_WORKSPACES` (`agent/lib/step-context/pilot.ts`). This is deterministic rewriting of history bytes, so there is a precedent for a trimming middleware.
- **Cost rows.** `agent/hooks/usage-costs.ts` writes one `usage_costs` row per `step.completed`, with `idempotency_key = step:<sessionId>:<turnId>:<stepIndex>` and `units.inputTokens/cachedInputTokens`. There is no channel column; join `chats` on `session_id`. `GET /api/usage-costs` only reports by month or run, not by session.

2. FRAMEWORK FACTS (eve 0.62, checked in dist)

- **Threshold.** `createCompactionConfig` in `execution/session.js` sets the threshold to `contextWindowTokens × thresholdPercent` (100k if the window is unknown). `recentWindowSize` is hard-coded to 10 messages, not turns, and cannot be configured.
  - At each step, `updateCompactionThresholdForModelReference` (`harness/tool-loop.js`) recomputes the threshold from the dynamic model's `contextWindowTokens`. The window is therefore runtime; the percent is static.
  - `thresholdPercent` is stored in the compiled manifest (`compiler/manifest.js`, `compiledAgentCompactionDefinitionSchema`), so it is fixed at build time. Whether agent.ts is re-evaluated at runtime: unverified.
- **Trigger.** `shouldCompact` adds three things: the last provider-reported `inputTokens`, an estimate of new messages, and growth in the envelope (instructions plus tools). It compares the sum, including the envelope, against the threshold. The check runs after `step.started` (`docs/concepts/context-control.md`).
- **What compaction does** (`harness/compaction.js`):
  - First it tries `capToolResults`, which caps only `role:"tool"` results in older messages to 2,000 characters (`TRANSCRIPT_PAYLOAD_LIMIT=2e3`, `compaction-prompt.js`). It does not cap tool-call inputs or user messages, so browser reports are not capped.
  - Otherwise it calls `generateText` with no tools at temperature 0, using the turn model (our wrapped model) or `compaction.model`. The result is a marker (`context.compaction`), a summary, and the last 10 messages.
  - `withResumptionGuard` appends the last real user message (string content, not a framework message) after a tool tail, or appends "Continue." (`execution.continuation`).
  - Recalled memory is excluded from the summary and recalled again on `compaction.completed`; profile.ts and workstreams.ts already handle this.
- **No custom strategy.** There is no history-projector or compaction hook we can author: `historyProjector` is internal memory projection (`execution/history-view.js`). The only way to change what the model sees per step without patching is our model middleware.
- **Compaction cost is not recorded.** Compaction emits only `compaction.requested`/`compaction.completed`, with no usage and no `step.completed`, so its cost never reaches `usage_costs`.
- **Manual compaction** is possible from routes and schedule handlers: `attachSession(id).compact()`, or `from(addr).compact()`. It is queued until the running turn settles (`docs/concepts/default-harness.md`, `channels/custom.mdx`). Hooks do not get `attachSession`.
- **Session token budget.** The default root `maxInputTokensPerSession` is 40,000,000 (`DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION`). After that, eve pauses with an "Approve/Stop" prompt (`docs/agent-config.md` "Runtime limits"). At about 96k per step, a Telegram session reaches it after about 420 steps. The repo does not set or handle `limits`.
- **No cross-channel session.** Sessions are channel-bound. `continuation.alias()` keeps the current channel namespace and is limited to 256 addresses (`channels/custom.mdx` "Continuation tokens"), so one eve session cannot own both a Telegram and an iMessage address. `to(channel, target).send()` starts or resumes a session on the target channel.
- **Channel context strings.** `context` returned from `onMessage` becomes `context.instruction` user messages placed before the person's message (`createTurnInputMessages`). They are appended to history and `startsTurn` ignores them.
- **Event payloads.** `message.received` carries `message` text and `kind?: "execution.background_task"` (`protocol/message.d.ts:163`).

3. DESIGN (5 parts, in order)

**A. Measurement first, plus fixing the budget (small).**
- Add `scripts/costs/history-growth.ts`, an SQL script run through the VM `db-*.sh` ops scripts, because prod Postgres is only reachable from the VM subnet. Optionally add a `?channel=` mode to `app/api/usage-costs/route.ts`.
- The query:
  - takes `usage_costs` joined to `chats` where `chats.channel='telegram'`, `source IN ('chat','browser-report')`;
  - parses `turnId` and `stepIndex` from `idempotency_key` with the regex `^step:(.+):([^:]+):(\d+)$`, because the session id may contain colons (unverified);
  - numbers turns per session with `dense_rank` over each turn's first `occurred_at`;
  - reports median and p95 of `units.inputTokens` for first steps of person turns (`stepIndex=0`, source `chat`), bucketed by turn number (1–10, 11–20, 21–50, 51+).
- Set `limits: { maxInputTokensPerSession: false }`, or a large value, in `agent/agent.ts` so a long Telegram chat never hits the Approve/Stop prompt.

**B. Make turn classification survive compaction (security prerequisite; must ship before the threshold is lowered).**
- Today, if compaction happens mid-turn, a task-agent turn whose `execution.background_task` opener was summarized away is no longer detected by `turnOpenedByBackgroundTask`. It then gets the full tool set on untrusted web text, which is fail-open.
- Also, the re-appended person message after the tool tail looks like a new turn. `turnSends` resets, a second forced `send_message` produces a duplicate reply, and the `insertBeforeApprovalTail` assumption (approval response last) breaks.
- Fix:
  - In `message.received`, record `{turnId, openerKind, browserRunId}` in `defineState` (`agent/lib/delivery/turn-opening.ts`).
  - Have `turnOpenedByBackgroundTask` and `currentTurnMessages` prefer that state.
  - Fail closed: if the history starts with a `context.compaction` marker and the opener cannot be proven to be the person, restrict to `backgroundTaskTurnTools`.
  - Whether `defineState.get()` works inside the dynamic-model `step.started` resolver: unverified. The docs list tools, hooks and channels. If it does not, the hook writes and the resolver reads a DB row keyed by `(sessionId, turnId)`.

**C. Deterministic trimming of old tool results in a model middleware, behind `HISTORY_TRIM_WORKSPACES`.** This is the core of the item.
- New `agent/lib/history/trim.ts`: a pure function of the prompt plus an eligible set.
- In `step.started`, compute the eligible set from `ctx.messages`, which has kinds; the provider prompt loses `kind` (unverified, so do not rely on it):
  - T = number of turn openers (`startsTurn`).
  - Watermark W = floor((T − 4) / 8) × 8, so the last 4 or more turns are kept whole and the watermark moves in 8-turn blocks.
  - Eligible = toolCallIds, plus browser-report opener run ids, from turns with ordinal < W.
- Pass this to `directModelSelection` as a new option. It goes only under the flag, because `tests/agent/agent.test.ts` compares options exactly.
- The middleware sits early in the list, before `stepNoteMiddleware` so its stubs are defused, and before `uniqueToolCallIdsMiddleware` so it sees the original ids. It skips calls without tools (compaction).
- Stubs are a pure function of the original content, so a trimmed message is byte-identical on every later step:
  - **gmail-read-thread:** keep ids, subject, from and date; replace bodies with `[trimmed: call gmail-read-thread <threadId>]`.
  - **browser_task call `task` input:** first 400 characters plus `…`.
  - **Browser report opener:** keep `backgroundTurnMarker`, `Browser run <id> finished.`, the untrusted-data line, and the first 600 characters of the outcome, plus `browser_task status <id>` / `list_orders`.
  - **Generic:** any tool result over 1,500 characters becomes its first 1,200 characters plus a re-run pointer. Never trim `send_message`, `ask_question`, approval or `standing_permission` results.
- Cache effect: bytes before the old watermark never change. Once every 8 turns, the segment after the old watermark is re-read at full price. Within a block the history stays append-only, which is the Manus-style rule.
- eve's durable history keeps the full text. The compaction summary still sees it, and every `ctx.messages` reader (said.ts, turn-sends, declined-cards) is unaffected.
- Rejected:
  - Trimming results when their own turn ends: this breaks the cache at every turn.
  - Patching eve's history: larger patch surface, irreversible, and the summary loses data.
  - Relying on `capToolResults`: it only runs at compaction and ignores reports and call inputs.
  - A lower auto threshold alone: each compaction is a model call plus a full cache miss.

**D. Compaction as a backstop at about 150k, done between turns.**
- Set the auto threshold to about 200k total input: `thresholdPercent` computed at module load as `max(100k, COMPACTION_INPUT_TOKENS) / contextTokens`, capped at 0.9, with a new env value defaulting to 200,000. It is fixed at build, so it must go into `build_env` in `scripts/cloudru-app-host/host.py`; see the dev-notes `web_search` lesson.
- Add a schedule `agent/schedules/history-compaction.ts` (respects `EVE_SCHEDULES`). Every 15 minutes it picks sessions whose last step's `inputTokens` minus the envelope is above about 60k, and whose last step was at least 2 minutes ago, and calls `attachSession(id).compact()`. Compaction then normally happens between turns, never mid-turn.
- Record compaction cost: a `wrapGenerate` in the middleware records the usage of tool-less calls into `usage_costs` (source `background`, `units.flavor:"compaction"`). The workspace and session come from the step's closure.
- Leave the summary model as the turn model. A Gateway `compaction.model` conflicts with the move to Cloud.ru.

**E. One history across channels: a cross-channel recap, not one session.**
- New table `conversation_log`: `workspace_id`, `session_id`, `channel`, `role`, `text` up to 1,000 characters, `at`, kept 30 days, plus a migration generated on top of bro-next.
- Written by a hook: person text from `message.received` (skipping background-marker and `kind` messages), and Bro text from completed `send_message` (`action.result`).
- In the `onMessage` of telegram.ts, photon.ts and eve.ts, if the workspace's latest log row is from another session and is newer than this session's last turn, add a `context` string: "Meanwhile in <channel>: …", at most about 1.5k tokens. It is appended, so it is cache-safe, and it gets compacted later.
- Rejected: one person-level session behind a custom channel. It would replace eve's Telegram and Photon adapters (HITL keyboards, uploads, outbound files, `to()` reports), and alias cannot cross namespaces.

4. RISKS AND GOTCHAS

- **Mid-turn compaction is fail-open** for task-agent turns, duplicates replies and breaks the approval tail. Ship B before D.
- **Pinned behavior.** `withResumptionGuard` re-appends only string user messages. A photo plus text drops out, and said.ts then finds no words. This fails closed, which is acceptable, but the tests must pin it.
- **Lost details after trimming.** The model loses old order numbers and links, so stubs must keep ids and re-fetch tools. `outcomeToldEarlier` reads eve history, so it is unaffected; `browserRunReportDelivered` covers the DB side.
- **Untrusted text in stubs.** Trimmed report stubs must keep the untrusted-browser-data line and stay subject to `defuseStepNoteTag`. Do not lift any page text out of its untrusted framing.
- **Cache.** One block break every 8 turns; measure it. Item 25 (`withheldTools` changes the start of the schema block) still breaks the prefix independently, so the done metric is size, not cache share.
- **Gateway path.** The middleware does not apply there. Only the direct provider counts, which is the same limitation as `STEP_CONTEXT`.
- **Hard-coded recent window.** `recentWindowSize=10` messages may hold fewer than one turn of a long browser turn.
- **Tests that pin current behavior:**
  - `agent/lib/model/tests/selection.test.ts` ("Compaction calls carry no tools", "takes a withheld tool out of the step and leaves compaction alone")
  - `agent/lib/model/tests/step-context.test.ts:173` ("…none to compaction")
  - `agent/lib/delivery/tests/pending.test.ts:164` (`context.compaction` summary is not awaiting delivery)
  - `tests/agent/workstreams.test.ts:461` (`compaction.completed` recall)
  - `tests/agent/approval-memory-recall.test.ts`, which covers the approval tail
  - `tests/agent/agent.test.ts` (exact `modelSelection` options)
  - `tests/agent/capabilities.test.ts`
  - `tests/agent/memory-tools-attachments.test.ts`

5. TEST AND ACCEPTANCE PLAN

- **Unit tests:**
  - `trim.ts`: same input gives byte-identical output; the watermark moves only at multiples of 8; current and recent turns are untouched; tool-call/result pairing is preserved; tool-less calls are a no-op; the stub is defused.
  - Step resolver: an eligible set computed from a compacted history.
  - B: build a history shaped like `compactMessages` output (marker, summary, 10 messages, re-appended user or "Continue.") and assert background-task restriction, no second forced send, and an approval tail kept last.
  - D: sweep selection SQL against PGlite; compaction cost row written once (idempotent).
  - E: recap only when another channel is newer; capped length.
- **e2e:** recap visible in the web chat after a "Telegram" log row (required by AGENTS.md for chat-visible behavior).
- **Evals:** `reply`, `schedules`, `delivery` and `memory` with the flag (`eve eval agent --tag …`).
- **Bench:** a long-chat case (scripted 40+ turns with gmail reads and browser reports) before and after, plus d09, d13 and d18 for recall of old results.
- **Prod acceptance (owner pilot first):** run the A query weekly on Telegram sessions.
  - Done when the median first-step input for turns 51+ is no more than the median for turns 11–20 plus 5k, p95 stays below the compaction trigger, and the regression slope of input on turn number is about 0 (under 50 tokens per turn).
  - Also track the cache share of first steps and compaction count and cost per session.

6. SIZE

About 5 PRs: A (small), B (medium, security), C (medium-large), D (medium), E (medium, with migration and e2e).

Overlaps with other items:
- `agent/agent.ts` `step.started`, `limits` and compaction: items 24, 25, 34.
- `agent/lib/model/direct.ts` middleware list and `selection.ts` options: item 25 and the step-context pilot.
- `shared/environment/env.ts` flags.
- `agent/channels/telegram.ts`, `photon.ts`, `eve.ts` `onMessage`: items 30 and 32.
- `db/schema` gains a new `conversation-log.ts`: item 31 memory may want the same log.
- `agent/lib/delivery/turn-sends.ts`: item 34 (`turnOpenedByBackgroundTask`).
- `agent/schedules/`: item 27.

The `agent/instructions/*` files are untouched, apart from optional wording about stubs.