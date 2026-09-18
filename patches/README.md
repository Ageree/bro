# Eve patches

Eve is pinned to the official, immutable `pkg.eve.dev` build at
`59ec96cc99f65a80f7a2daf4ca5e2a0ad95455f2` (`0.52.2+main.59ec96cc99f65a80`).
It includes the merged turn-context placement fix in
[vercel/eve#3089](https://github.com/vercel/eve/pull/3089), which is absent from
npm's `0.52.2` release. Return to a registry version once a release contains this
commit and the patches below have been checked against it.

The tarball SHA-256 is
`633c0d9ebf5d0d5733d8cc2fdc5315952a7ccca8cb7902c31f550dc8ab0750a9`.
The lockfile also records its package integrity. pnpm matches URL dependency
patches by package name, so keep the immutable dependency pin when changing the
Eve patch.

## Remaining patches

`eve@0.55.0.patch` carries two independent hunks:

- The declaration bridge redirects Eve's incomplete bundled Chat SDK
  declaration exports to the explicitly installed `chat` package. Eve's runtime
  still uses its bundled Chat SDK.
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

To change the patch, run `pnpm patch eve@0.55.0`, edit the files in the
reported directory, and `pnpm patch-commit <dir>` so both hunks and the
lockfile hash stay consistent.

Remove the declaration bridge when the published declaration files resolve
without it. Photon's iMessage adapter posts into a conversation without a reply
anchor, so no provider reply option is patched in any more.

The old Eve patches for `ask_question` and `task_cancel` exports are no longer
needed: both now have public entry points. Callback authorization is composed
in `agent/channels/eve.ts` using public `defineChannel` and `routeAuth` APIs.

No task-loop or prompt-placement patch is applied locally.
