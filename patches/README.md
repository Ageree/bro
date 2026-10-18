# Eve patches

Eve is pinned to the npm release `0.62.0`. The lockfile records both the
package integrity and the patch hash, so bumping the version means
regenerating the patch below against the new dist.

## Remaining patches

`eve@0.62.0.patch` carries eight independent hunks:

- The declaration bridge redirects Eve's incomplete bundled Chat SDK
  declaration exports to the explicitly installed `chat` package. Eve's runtime
  still uses its bundled Chat SDK. `dist/src/compiled/chat/index.d.ts` still
  imports from a `messages-*.js` sibling that the published package omits.
- The inbound `message` override lets the `onMessage` hook of the Telegram and
  Photon channels return an optional `message?: string | UserContent` (the AI
  SDK `UserContent` from `ai`) that replaces the turn message Eve would build.
  `telegram/telegramChannel.js` `dispatchMessage` reads
  `r.message ?? buildTelegramTurnMessage(e.message, i)` and keeps the context
  block and reply input responses; `photon/photonIMessageChannel.js`
  `dispatchMessage` reads `i.message ?? photonInboundContent(r)`. The matching
  `TelegramInboundResult` and `PhotonInboundResult` declarations gain the field.
  `agent/lib/inbound-media` uses it to hand the model photo bytes it resolved
  itself and voice-note transcripts, because Eve's own Telegram resolver drops
  a photo the Bot API serves without an image content type, its Telegram parser
  ignores `voice`, `audio` and `video_note`, and the Photon adapter exposes no
  URL for an attachment. Drop the hunk once Eve's inbound hooks accept a turn
  message override natively.
- The schedule session handle gives a schedule's `run` handler the same
  `attachSession(sessionId)` a route handler gets. `channel/schedule.js`
  `ScheduleDispatcher.triggerInScope` adds
  `attachSession:e=>createSession(e,this.runtime)` to the handler args, and
  `public/definitions/schedule.d.ts` declares it on `ScheduleHandlerArgs`. An
  eve web chat has no channel continuation address, so `to(...)` cannot reach
  it, and the app's own channel routes (`/webhooks/*`, `/internal/*`) are not
  routed to the eve service on Vercel. Without the handle,
  `agent/schedules/browser-runs.ts` could not report a finished browser errand
  back into the web chat. Drop the hunk once `ScheduleHandlerArgs` carries
  `attachSession` itself.
- The approval-safe memory recall keeps an approved tool call executable.
  `shared/memory-state.js` `applyMemoryRecallBatches` appended new or changed
  recalled records after the whole history. On the turn that answers an
  approval, the history ends with the `tool` message carrying the
  `tool-approval-response`, and the AI SDK runs approved calls only when the
  prompt's last message is that `tool` message. A recall that changed while
  the approval waited (any memory saved meanwhile, in any conversation of the
  workspace) put a `memory.load` user message last, so the approved call was
  silently skipped and the model asked for approval again. The hunk adds
  `insertBeforeApprovalTail`, which places the records before the last
  assistant message when the history ends with an approval response.
  `tests/agent/approval-memory-recall.test.ts` covers it. Drop the hunk once
  eve keeps the approval tail last on its own.
- A replayed approved call that throws still reports its result.
  `harness/emission.js` emitted `action.result` for a `tool-error` only when
  the call was requested in the same model step, so a failed replay vanished
  from the stream and from the eval facts. The added branch emits it for a call
  that did not appear in the step. `evals/agent/integrations.eval.ts` relies on
  it. Drop the hunk once eve emits replayed tool errors on its own.
- Turn tools survive a fresh process. Dynamic tool callbacks live in an
  in-process registry, while their metadata persists with the session, so a
  step that runs after a deploy or a cold start rebinds them first.
  `context/dynamic-tool-lifecycle.js` `rebindMissingCompiledDynamicToolCallbacks`
  re-ran only resolvers marked for rebinding (eve's memory provider tools) yet
  counted every ordinary turn tool that was still unbound as a failed rebind,
  and threw `Dynamic tool callback rebind did not restore`. The step failed
  before `turn.started` could resolve the tools again, so every later message
  failed the same way and the session died. The hunk never throws: a step in
  the middle of a turn (`execution/session/turn-step.js` passes
  `turnInProgress`) rebuilds ordinary turn resolvers from scratch too, a tool
  that still cannot be restored stays in the turn and fails only its own call,
  and `context/build-dynamic-tools.js` `missingCallbackError` tells the model
  that the call did not run. `tests/agent/dynamic-tool-rebind.test.ts` covers
  it. Drop the hunk once eve restores or fails closed per call on its own.
- Memory tools survive a photo in the conversation. `context/memory-tools.js`
  `createProviderToolCallbacks` put the whole memory tools context, history
  (`messages`) and turn input (`turn.input`) included, into the durable
  closure of every memory provider tool through `parseJsonObject`. eve stages
  every inbound attachment in the sandbox before the turn starts, and the
  history then holds its `eve-sandbox:` reference as a `URL` instance, which is
  not JSON: each memory slot's `turn.started` resolver failed with
  `Expected a JSON-serializable value.`, and `profile__*`,
  `personal_info__update` and `workstreams__*` were gone on every turn whose
  history still held a photo, in every channel. The added
  `durableMemoryToolsContext` keeps both lists empty in the closure, so the
  provider's `tools()` gets them empty when a call rebuilds its tool; Bro's
  providers read neither. The closure no longer copies the whole conversation
  into each memory tool's persisted metadata either.
  `tests/agent/memory-tools-attachments.test.ts` covers it. Drop the hunk once
  eve keeps non-JSON history out of that closure on its own.
- A tool call that never got a result leaves the prompt. The AI SDK refuses a
  history in which a call has no `tool-result` before the next user message or
  at the end (`AI_MissingToolResultsError` in `convertToLanguageModelPrompt`),
  and it does so before any model middleware runs, so one such call recorded
  in a session failed every later turn of it (16.10: `task_cancel`, which eve
  never ran, see `docs/dev-notes.md`). `harness/messages.js`
  `normalizeModelMessages`, which eve applies to each step's projected history
  on its way to the model, also drops the calls the AI SDK would refuse, by the
  AI SDK's own rule (answered by a later `tool-result`, approved or declined on
  a card, or run by the provider are kept), their approval requests, the
  results a later turn may still bring for them, and an assistant message the
  drop leaves with nothing but reasoning. Untouched messages stay the
  same objects; the session history keeps the call. Only the prompt that
  would have failed changes. `tests/agent/unanswered-tool-call.test.ts`
  covers it. Drop the hunk once eve never records a call without its result.

To change the patch, run `pnpm patch eve@0.62.0`, edit the files in the
reported directory, and `pnpm patch-commit <dir>` so every hunk and the
lockfile hash stay consistent. When upgrading Eve, first check the new dist:
the bridge goes away once `dist/src/compiled/chat/index.d.ts` resolves on its
own, the override once `TelegramInboundResult` and `PhotonInboundResult`
declare `message` themselves, the schedule handle once
`ScheduleHandlerArgs` declares `attachSession`, the approval hunks once
`tests/agent/approval-memory-recall.test.ts` and the approval eval in
`evals/agent/integrations.eval.ts` pass without them, the rebind hunk once
`tests/agent/dynamic-tool-rebind.test.ts` passes without it, the memory
tools hunk once `tests/agent/memory-tools-attachments.test.ts` does, and the
unanswered call hunk once `tests/agent/unanswered-tool-call.test.ts` does.

Photon's iMessage adapter posts into a conversation without a reply anchor, so
no provider reply option is patched in any more.

The old Eve patches for `ask_question` and `task_cancel` exports are no longer
needed: both now have public entry points. A re-exported `task_cancel` does not
work in 0.62, though: eve gives the `task-control` dispatch only to a
framework-owned module, and a re-export under `agent/tools/` is
application-owned (`createRegisteredHarnessToolDefinition` in
`execution/node-step.js`), so its calls never ran. Bro has no `task_cancel`
(`tests/agent/tools/executable.test.ts`). Callback authorization is composed
in `agent/channels/eve.ts` using public `defineChannel` and `routeAuth` APIs.

Apart from the memory recall placement, the replayed tool error, the dynamic
tool rebind and the unanswered tool call above, no task-loop or
prompt-placement patch is applied locally.

# Workflow world patch

`@workflow__world-postgres@5.0.0-beta.44.patch` changes how the Postgres
world recovers active runs when eve starts. The stock `start()` awaited
`reenqueueActiveRuns`, which queues every pending or running run as a job due
at once; eve's world plugin awaits `start()` before it serves. On 18.10 that
was 1124 parked sessions per restart, and a person's first turn after a
deploy waited 36–58 s behind them (`ops/world-queue.sh` shows the backlog).
The patched `start()` returns after the queue starts and queues the same runs
in the background, with Graphile priority 10 (new work has 0, and Graphile
runs smaller numbers first) and three per second; `close()` stops it.
`queue()` passes an optional `priority` to `addJob`.
`tests/agent/world-recovery.test.ts` covers both, and `vitest.config.ts`
inlines the package so the test can stand in for Graphile and storage.

To change it, run `pnpm patch @workflow/world-postgres@5.0.0-beta.44`, edit,
and `pnpm patch-commit <dir>`. Drop it once the world queues its start-up
recovery behind new work itself.
