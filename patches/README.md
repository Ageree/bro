# Eve patches

Eve is pinned to the npm release `0.62.0`. The lockfile records both the
package integrity and the patch hash, so bumping the version means
regenerating the patch below against the new dist.

## Remaining patches

`eve@0.62.0.patch` carries five independent hunks:

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

To change the patch, run `pnpm patch eve@0.62.0`, edit the files in the
reported directory, and `pnpm patch-commit <dir>` so every hunk and the
lockfile hash stay consistent. When upgrading Eve, first check the new dist:
the bridge goes away once `dist/src/compiled/chat/index.d.ts` resolves on its
own, the override once `TelegramInboundResult` and `PhotonInboundResult`
declare `message` themselves, the schedule handle once
`ScheduleHandlerArgs` declares `attachSession`, and the approval hunks once
`tests/agent/approval-memory-recall.test.ts` and the approval eval in
`evals/agent/integrations.eval.ts` pass without them.

Photon's iMessage adapter posts into a conversation without a reply anchor, so
no provider reply option is patched in any more.

The old Eve patches for `ask_question` and `task_cancel` exports are no longer
needed: both now have public entry points. Callback authorization is composed
in `agent/channels/eve.ts` using public `defineChannel` and `routeAuth` APIs.

Apart from the memory recall placement and the replayed tool error above, no
task-loop or prompt-placement patch is applied locally.
