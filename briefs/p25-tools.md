**ITEM 25: one tool set per kind of turn, with byte-stable schemas (design brief)**

Repo: /home/user/bro at e7e3a1f. I read the code and docs only and ran no builds or evals. I checked eve facts in node_modules/eve/dist and node_modules/eve/docs.

---

## 1. CURRENT STATE

**What sets the tools for each step (`agent/agent.ts`, `step.started` model resolver, lines 82–330)**

The resolver computes these values from the step's state:
- `reportRunId`, `staleReport`, `pastAnswer = turnMustEnd`, `reportPastAnswer`, `cardsHeld`, `owedSteps`, `reportTurn`
- `heldForAnswer = turnAwaitsAnswer` (line 243)
- `taskAgent = taskAgentPilot(scope)`
- `stableContext = stepContextPilot(scope)`

It then calls `modelSelection` (`agent/lib/model/selection.ts:24`) with:
- **`withheldTools` (lines 304–312):**
  - `ask_question` when `reportTurn || turnAskedQuestion(messages)`
  - `react_to_message` and `send_message` when `reportPastAnswer`
  - `actionsHeldForAnswer` (`agent/lib/delivery/questions.ts:16`: `calendar-delete-event`, `calendar-update-event`, `profile__forget_all`, `profile__remove_memory`, `schedules-update`, `workstreams__forget`, `workstreams__forget_all`) when `heldForAnswer`
  - `cardToolsBeforeOutcome` (`agent/lib/delivery/browser-report.ts:124`, 22 card tools) when `cardsHeld`
  - `task` unless the task-agent pilot is on.
- **`offeredTools` (lines 317–329):**
  - `backgroundTaskTurnTools` (`react_to_message`, `send_message`, `task`, `task_cancel`) for a turn opened by a background task (`turnOpenedByBackgroundTask`).
  - Under the pilot only: `reportToolsAfterOutcome` (`browser-report.ts:185`: `browser_task`, `connect_google`, `list_orders`, `send_message`, `calendar-create-event`, `schedules-create`) once a browser report's message is out (`reportToolsOnly`, line 246).
- **`toolChoice`:**
  - `none` when the report is stale, the turn is past its answer, or `readsMustEnd`.
  - `required` when `requireToolCall`.
  - `auto` otherwise.

**Middleware order in `agent/lib/model/direct.ts:1053–1077`**

AI SDK runs `transformParams` from the outermost middleware first. The order is:
1. `stepCostMiddleware`
2. `toolSchemaMiddleware` (`hostSchema`: discriminators first, search `pattern` stripped, `type: object` added to a `oneOf` root)
3. `forcedReplyTextMiddleware` (line 377, **only when `toolChoice === "required"`**). It makes `text` required in `send_message`'s message branch, so **the schema differs between forced and unforced steps**.
4. `withheldToolsMiddleware` (398), which filters tools out.
5. `offeredToolsMiddleware` (435), which filters tools in.
6. `replyToolLastMiddleware` (455, pilot only), which moves `send_message` to the end.
7. `toolChoiceMiddleware`
8. `stepNoteMiddleware` (609, pilot: a `<bro-step-note>` user message after the history) or `replyNoteMiddleware` (a last system message)
9. `silentEndMiddleware` or `quietEndMiddleware`
10. `outputCapMiddleware`
11. `uniqueToolCallIdsMiddleware`
12. `noToolCallsMiddleware`

**Tools whose resolvers run per step or per turn, and whether their bytes stay the same**

Step-scoped:
- `messaging.ts:96`: description and schema are constant. Only the closure changes (`turnSends`). The reaction schema depends on the channel ("add" or "toggle"), so it is stable within a session.
- `gmail.ts:472`:
  - `gmail-read-thread`'s description depends on `voice` being non-null. That is decided by the mode, so it is stable for a kind of turn.
  - **`gmail-draft`'s description changes mid-turn** after a declined `gmail-send` card (`afterDeclinedSend`, line 450). This is a within-turn breaker.
- `drive.ts:212`, `browser_task.ts:4084` and `form_of_address.ts:141`: description and schema are constant; only the closure changes.

Turn-scoped, with descriptions that change between turns (these break the cache across turns of a long Telegram session):
- **`generate_image.ts:90`** is present only when `startedByPerson && pictureRequested`. Its description embeds `describeDrawnPictures` and `describePhotos`, which change from turn to turn.
- **`schedules.ts:227`**: `schedules-answer` exists only when `answerableScheduledQuestions` is not empty.
- `site_sign_ins`: present only when `startedByPerson`, which is a difference of turn kind, so it is fine.
- `telegram_link`: depends on the channel, stable per session.

The other turn-scoped resolvers (apps, notion, slack, calendar, contacts, etc.) have constant descriptions; only their closures vary. Memory provider tools (`profile__*`, `workstreams__*`, `personal_info__*`) are turn-scoped by eve and have constant descriptions.

**Tests that pin the current behaviour**
- `tests/agent/agent.test.ts`:
  - "offers ask_question no more once the turn asked the person" (231)
  - "holds what a question asked about until the person answers" (387)
  - "gives a report turn its cards only after the outcome went out" (583)
  - "keeps a booked report's turn going until its calendar card came" (639)
  - "lets a report turn past its answer still act on the errand" (879)
  - "delivers the task agent's report after a browser report, with delivery tools only" (779)
  - the worker test at about line 956 with `withheldTools: ["task"]`
- `tests/agent/step-context.test.ts:182–243` ("gives a browser report's turn only its few tools…", "keeps a person's turn on every tool after its reply").
- `agent/lib/model/tests/selection.test.ts`:
  - :258 "takes a withheld tool out…"
  - :721 "…requires its text when forced" (asserts that the free branch does *not* require `text`)
- `agent/lib/model/tests/step-context.test.ts:155` and `:173`.
- `tests/agent/capabilities.test.ts` (per-mode tool sets).
- `tests/agent/tools/schedules.test.ts:199–257` (`schedules-answer` is offered only when answerable).
- `tests/agent/tools/generate_image.test.ts:131` and `:164` ("offered only when…").
- `agent/lib/delivery/tests/questions.test.ts`.

**Measured cost, from `docs/agent-costs.md` 3.2**
- The pilot's first step of a turn reads 97–99% from the cache in prod.
- The step after delivery re-reads 110–120 thousand tokens at about 30% cache, costing 0.75–0.87 ₽ (up to a third of the d03 case).
- My reading of the code is that, in a person's turn, this break comes from `forcedReplyTextMiddleware`: steps are forced until delivery and unforced after it, so `send_message`'s schema flips. Because the tools come before the history, the whole history is re-read. `withheldTools` changes the set mainly in report turns and after questions.

## 2. FRAMEWORK FACTS (eve 0.62 plus our patch)

- **Tool order sent to the model.** In `dist/src/harness/tool-loop.js` (prepareModelTools), static or authored tools come first (`buildToolSetWithProviderTools`). Dynamic tools are then assigned with `s[name]=tool`. `context/build-dynamic-tools.js` puts dynamic tools in the order step-scoped, then turn-scoped, then session-scoped, and drops duplicates keeping the first.
  - A dynamic tool that overrides an *authored* one keeps the authored tool's position.
  - A step-scoped override of a *turn-scoped* tool moves earlier in the list, so the bytes change.
- **Resolver order and failures** (`context/dynamic-tool-lifecycle.js`). Resolvers for one event run with `Promise.allSettled` in a fixed order, so the order is deterministic. A resolver that throws is logged and **its whole result is skipped**, which silently changes the tool set; `generate_image` does a database read here. A name collision throws only between resolvers of the same event.
- **No `toolChoice` or `activeTools` in eve.** Our middleware is the only lever. In `@openrouter/ai-sdk-provider` 3.0.0 (`dist/index.js:3343–3353`), a named choice `{type:"tool",toolName}` maps to `{type:"function",function:{name}}`. Tools are always sent in array order as `{name, description, parameters}`, including when `tool_choice` is `none` (3649–3673). **Unverified:**
  - whether RouterAI or DeepInfra honour a named `tool_choice` for `deepseek/deepseek-v4.1-flash`;
  - whether any host leaves the tools out of the prompt under `none`.
- **`ask_question` cannot be masked through execute.** It is eve's native tool (`tools/framework/ask-question.js`, behaviour `request-input`, no execute). `harness/input-extraction.js` `extractQuestionRequests` looks the handling up in `e.coordinationTools`, which `tool-loop.js` builds from the authored tools only, not the dynamic ones. So a call named `ask_question` becomes a question card even if a dynamic tool overrides it. A dynamic override with an execute that refuses would therefore not work, or would behave unpredictably.
- **Hooks cannot block a call** (`docs/guides/hooks.md`: return values are ignored). Approval callbacks do not see the messages. Tools do not see the history; they get only `ctx.session` (including `turn.id`, per `docs/guides/session-context.md`) and their JSON closure.
- **`defineState`** (`docs/concepts/state.md`) is durable per session and can be read and written from tools and hooks; `agent/lib/reply-targets.ts` already writes it from a hook. Whether `get()` works inside approval callbacks and inside memory-provider tool executes is **unverified**.
- **Dynamic tool rules** (`docs/guides/dynamic-capabilities.md`):
  - Callbacks go inline in `defineTool()` or by module-level reference.
  - Closures are JSON only.
  - Schemas must be inline or module-level.
  - A parked call replays with the closure captured when the call was made.
  - Step-scoped and turn-scoped tools are not rebound; the patch rebinds turn resolvers mid-turn.
- **Memory provider tools** are turn-scoped (`context/memory-tools.js`), and the patch's `durableMemoryToolsContext` empties `messages`, so they cannot get step state through a closure.

## 3. DESIGN

**A. New module `agent/lib/turn-kind/` (lower-case folder)**
- `kind.ts`: `turnKind(ctx)` returns one of `person | browser-report | background-task | scheduled-worker | proactive-worker | scheduled-report`. It is derived from auth plus the turn's opening message (`reportedBrowserRunId(auth.current)`, `turnOpenedByBackgroundTask`, `resolveModeValue`), so it is constant for the whole turn.
  - It is not a new `mode` (`docs/agent-costs.md` 3.2 item 4 explains why a mode breaks the `resolveModeValue` tables).
  - Item 24 should reuse it. Note that 0.62 instruction resolvers do not see the incoming message, so a background-task turn cannot be detected there.
- `sets.ts`: the fixed set for each kind (below). It replaces `reportToolsAfterOutcome` and `backgroundTaskTurnTools` as the single source.

**B. Fixed set per kind, applied through the existing `offeredToolsMiddleware`, constant for the turn**

| Kind | Fixed set | Masked within the turn |
|---|---|---|
| **person** (web, Telegram, iMessage) | Today's interactive set, plus `generate_image` (when configured) and `schedules-answer` always present. `task` only for the pilot workspace. `link_telegram` and the reaction schema vary per channel (stable per session). | `ask_question` after a question; the 7 destructive tools while held for an answer; `generate_image` unless a picture was requested; `schedules-answer` unless answerable (the execute already throws); the existing `browser_task` start limit and Google read limits |
| **browser-report** | `reportToolsAfterOutcome`, plus read helpers to confirm from prod tool-call data before narrowing: `find_images`, `calculate`, `calendar-list-events`, `schedules-list` (candidates; whether `web_search` and `web_fetch` are used before the message is unverified). No `ask_question`, no memory tools, no other card tools. | `calendar-create-event`, `schedules-create` and `connect_google` until a message is out; `send_message` and `react_to_message` when the report is past its answer (`reportPastAnswer`) |
| **background-task** | `backgroundTaskTurnTools` (unchanged) | none |
| **scheduled-worker** | As resolved by mode today, plus native `ask_question` and `task_cancel` (`scheduled-worker.md:31` uses `ask_question`) | none |
| **proactive-worker** | `calendar-list-events`, `gmail-read-thread`, `gmail-search`. Optional hardening: drop `ask_question` and `task_cancel` (`proactive-worker.md:36` already forbids `ask_question`). | none |
| **scheduled-report** | `send_message`, `request_vault_setup`, `task_cancel` | none |

**C. How each current rule maps to masking**
1. **`ask_question` withheld in report turns and scheduled reports**: becomes membership of the kind's set; it does not change within the turn.
2. **`ask_question` withheld after `turnAskedQuestion` (person turn)**: this stays the one remaining in-turn removal, because it cannot be masked (section 2). Generalise `replyToolLastMiddleware` to `volatileToolsLast(["ask_question","send_message"])`, so only the history after it is re-read.
   - Rejected: a dynamic override (eve extracts the question anyway); rewriting the output into `send_message` (changes the "act on the answer" rule); invalidating the input (the model loops).
   - Measure how often it fires, then consider dropping the rule and relying on the description, judged by evals.
3. **`reportPastAnswer` (react and send)**: masked in `messaging.ts`'s step closure. Add a past-answer verdict (reported run id from `ctx.session.auth.current`, `turnMustEnd`, `workAfterSkip`) and return `sendRefusal` "skipped" (with `skippedSendNotice`) before delivery. The same applies to `react_to_message`.
4. **`heldForAnswer`**:
   - `calendar-delete-event`, `calendar-update-event` and `schedules-update`: convert `calendar.ts:117` and `schedules.ts:227` from `turn.started` to **`step.started`** (factories, inline callbacks). The closure carries `held: turnAwaitsAnswer(messages)`; execute returns `{status:"held", note: heldForAnswerNote}`.
   - Why a step closure rather than live state: approval and execute must read **one snapshot**. Live state can flip between approval returning "not-applicable" and execute (a parallel send in the same step), and a card tool would then run without consent.
   - Memory forget tools (4): their closures cannot carry step state. Use a `defineState` slot `turn-holds` {`turnId`, `held`}, written by `send_message`'s execute (closure: `personAskedForHeldAction`). The approval reads it and **returns `user-approval` (a card) when held**. This fails closed: the card is the person's answer, and it needs no execute-side race handling. Verify in eve dev that state is readable in approvals; this is unverified.
5. **`cardsHeld` (report turn before its message)**: most card tools leave the report set. `calendar-create-event`, `schedules-create` and `connect_google` become step-scoped. Their closure carries `messageOut` (from the report run id and `turnSends(messages).delivered.length`). The approval is inline: when masked, return `"not-applicable"` and the execute refuses with the text of `cardToolsBeforeOutcomeNote`. Both read the same closure, so the outcome is consistent. Hold back `connect_google` (a card) the same way.
6. **`!taskAgent`**: membership by workspace. Remember a failed pilot lookup per turn, because today a failed lookup flips `task` for one step.
7. **`forcedReplyTextMiddleware`**: apply `forcedReplySchema` in **every** step, folded into `hostSchema` for `send_message`. Keep `toolChoice` as it is. `send_message` is then byte-identical forced or not.
   - Cost: a message carrying only attachments must now have a caption (`text` has `min(1)`).
   - This is the single biggest within-turn fix, and it also fixes the step after delivery.
8. **Cross-turn stability**:
   - `generate_image`: a constant description in the person set. Keep `photos` and `pictureRequested` in the closure; the execute refuses when no picture was requested (the paid tool stays gated, fail-closed). The photo and drawn-picture lists go into the step note in turns where a picture was requested.
   - `gmail-draft`: a constant description; the "just declined `gmail-send`" sentence becomes a step note (`turnDeclinedGmailSend`).
   - `schedules-answer`: always present in the person set.
9. **Notes**: change `heldForAnswerNote`, `cardToolsBeforeOutcomeNote` and `owedStepsNote` from "not available / not among your tools" to "will be refused until …".
10. **Diagnostics**: `agent.ts` passes `{sessionId, turnId, stepIndex}` (from `step.started` event data) into `directModelSelection`. The innermost transform logs `[tools] <sha256 of JSON(params.tools)>`. Extend `scripts/costs/step-context.ts` to check that each kind's digest is identical across simulated steps.

**D. Flag and rollout.** Masks in execute and approval apply everywhere: they are harmless next to removal and they also protect the Gateway path. The fixed sets, and dropping `withheldTools` except rule 2, apply only under `stableContext` (`STEP_CONTEXT_WORKSPACES`). After evals and prod data, set `*`, then delete the legacy `withheldTools` path.

**E. Named `tool_choice`**: optional. Add `{type:"tool"}` to `StepToolChoice` only after a host probe with N tries per host, as was done for `brokenHosts`. It cannot replace `required` in a person's turn (the model may act before replying) or the first step of a report (a quiet `continue` is allowed). Possible later use: forcing an owed `calendar-create-event`.

**Rejected alternatives**
- Removing tools per step: this is the problem being fixed.
- A canonical sort by name plus generic step-scoped overrides of turn-scoped and memory tools: copying the memory-provider descriptions byte for byte is fragile.
- A new agent mode: breaks the `resolveModeValue` tables.
- Masking through hooks: hooks cannot block a call.

## 4. RISKS AND GOTCHAS

- **Behaviour.** A masked tool can now be called and refused, which costs a step and lets the model claim "done". Each refusal must say "not done; do not say it is done", in line with dev-notes "repeat the rule in the tool result". Check the RU d02 case ("остановить или оставить?").
- **`said.ts` and approvals must not change.** Codes and consent come only from the person's words (`personWordsThisTurn`), and `ownTurnApproval` gives `user-approval` in turns Bro opened.
  - A mask must never turn "not-applicable" into a real execute: approval and execute must share one closure snapshot.
  - Memory masks fail closed with a card.
  - `backgroundTaskTurn` must still throw on the Gateway (agent.ts:129).
- **Cards in report turns.** A card before the outcome parks the turn and leaves the report undelivered until its lease runs out (`agent/hooks/browser-run-report.ts`). The three remaining cards must stay masked until the message is out. Keep the 10-minute lease.
- **Approval after a card.** The approved call runs after `step.started` and uses the closure from when the call was made, which is consistent. Check that the patch's rebind covers newly step-scoped tools with approvals (`tests/agent/dynamic-tool-rebind.test.ts`); unverified.
- **Silent set changes.** A resolver that throws drops its tools for the step. Keep resolvers in the fixed sets free of throws; `generate_image` should catch and mask instead.
- **Cache.** Each kind has its own prefix. Alternating report and person turns in one Telegram session re-reads only the other kind's new messages. Whether DeepInfra drops tools from the prompt under `none` is unverified; the step digest plus `cachedInputTokens` of `none` steps will show it. DeepSeek caches in blocks (6–14 thousand tokens of lag), which caps the reachable share. The first turn after a deploy is cold.
- **`forcedReplySchema` always on.** Watch messages that only carry attachments (generated pictures go in the text, so the risk is low).
- **Tests to update:** the ones listed in section 1, plus the "When its tool is not among your tools…" wording in `owedStepsNote`.

## 5. TEST AND ACCEPTANCE PLAN

**Unit tests**
- `direct.ts`: `send_message` host schema is identical for `required`, `auto` and `none`; `ask_question` and `send_message` stay at the tail.
- A per-kind digest test: resolve every tool module, as `capabilities.test.ts` does, for each kind across simulated steps (before and after the message, after a question, after a declined `gmail-send`, held for an answer). Serialise through `hostSchema` and assert the bytes are identical within the turn.
- Mask tests:
  - calendar and schedules execute refuse when `held`; their approvals do not ask when masked.
  - In a report turn, `calendar-create-event`, `schedules-create` and `connect_google` refuse before the message and ask on a card after it.
  - `send_message` and `react_to_message` refuse past the answer.
  - Memory forget tools ask on a card when held.
  - `generate_image` refuses without a picture request; `schedules-answer` refuses when not answerable.
- `agent.test.ts`: under the pilot, `offeredTools` equals the kind's set and `withheldTools` is only `["ask_question"]` after a question.

**Evals (with the flag)**: `eve eval agent --tag reply`, `schedules`, `delivery`, `conversation`, `approval`, `standing-permission` (dev-notes asks for `reply` and `schedules` before widening the flag).

**Bench**: RU d02 (question then delete), d03, d04, d05 (browser report with calendar and schedule cards), d13 and d14 (memory and permissions), uc-sh-compare. Compare cost, steps and both judges' scores with the 3.2 rule: no judge's average down by more than 0.5, no case down by more than 1.5 for both.

**Done on prod**
- From `usage_costs`: `sum(units.cachedInputTokens) / sum(units.inputTokens)` by `source` (`chat`, `browser-report`, `background`), and by step index (`split_part(idempotency_key, ':', 4)`), over 7 days for the pilot and then for everyone. Target: above 80%.
- Add the cache share to `summarizeUsageCosts` (`db/services/usage-costs.ts`) or the usage-stats script. The Cloud.ru database is reachable only through the VM ops scripts.
- `[tools]` digests in the runtime logs must not change within a turn, except after `ask_question`.

## 6. SIZE

About 4–5 PRs:
1. Constant `send_message` schema, volatile tools last, digest log (small: `direct.ts`, selection and step-context tests). This is the biggest win.
2. `agent/lib/turn-kind/` plus the masks (calendar and schedules moved to step scope, `google_connect`, `messaging.ts`, memory approvals in `agent/lib/memory/profile.ts` and `agent/memory/workstreams.ts`, `defineState` holds, `agent.ts` rewiring, notes in `delivery/questions.ts` and `delivery/browser-report.ts`) (large).
3. Cross-turn stability for `generate_image`, `gmail-draft` and `schedules-answer` (medium).
4. Cache share in the usage summary, rollout to `*`, removal of the legacy path, updates to `docs/agent-costs.md` 3.2, `docs/dev-notes.md` and `docs/roadmap.md` (small).
5. Optional: a named `tool_choice` host probe.

No `db/schema` migration is needed (`defineState` takes none).

Files shared with other items:
- `agent/agent.ts`: items 24, 28, 34.
- `agent/lib/mode.ts` and the new `turn-kind`: item 24 (instructions per kind) should share `turnKind`.
- `agent/lib/model/direct.ts`: item 28 if history trimming becomes middleware; step-note work under item 22.
- `agent/instructions/*`: wording only (references to `ask_question` and withheld tools), shared with item 24's core rewrite.
- `agent/tools/messaging.ts` and `agent/lib/delivery/*`: item 34 (background-task turn).