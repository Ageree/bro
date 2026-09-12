# Bro

Personal iMessage concierge. **eve** runs the agent. **Convex** holds tenants, orders, and long-term memory (one store per person). **Photon Spectrum Pro** is the iMessage chat transport (shared pool, blue only — never SMS/RCS). **Inkbox** is mail-only: Bro mailbox, OTP, `[event:mail]`. **Supermemory** (optional, paid) adds automatic conversation memory.

Outbound replies are compiled to iMessage text: markdown is stripped, `**latin**` becomes Unicode math-bold (looks bold on iPhone), Russian field labels get a `▸` mark, long numbered dumps become one bubble per item. Photon Pro has no native iOS 18 cards or groups.

Telegram is a **second channel on the same tenant** (same phone, Bro mailbox, Gmail/Calendar, eve session). The human texts «телеграм» in iMessage, opens `t.me/<bot>?start=bind_…`, and later replies follow `lastChannel`. Markdown becomes Telegram HTML (`**привет**` is real bold; `++u++`, `||spoiler||`, `>` / `>!` quotes, `!![alt](url)` hidden media). Structured cards (`#` headings, lists, `:::rich`) go out as `sendRichMessage` and fall back to classic HTML if the method is missing. Optional `:::buttons` inline keyboards, photos, voice STT, and reactions. Outbound photos are real attachments on both channels: `send_photo` uploads a computer file or a public https image, and `![alt](https://…)` in a reply becomes `sendPhoto` on Telegram and Photon attachments on iMessage. Check: `npm run photo:check`. Unbound Telegram users are told to start from iMessage — no second identity. Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. `npm run telegram:webhooks` once. Check: `npm run telegram:check`. Inbound photos reach the model as image parts (`deepseek/deepseek-v4.1-flash` has vision): bytes are downloaded up to 3 MB and sent as a plain `data:` base64 string so the picture survives the signed URL — never a `Uint8Array`/`URL` object, because eve serialises the turn input into memory-tool closures as JSON and those types break that; larger or failed downloads become the plain URL string instead. The URL also stays in the text for `browser_task`. Other attachments stay URLs. Check: `npm run imessage:check`, `npm run image:check`.

Voice notes: inbound audio is transcribed via OpenRouter STT (`/audio/transcriptions`) before the model sees it (`[voice] …`). Default `qwen/qwen3-asr-flash-2026-02-10` (best digit/time/brand accuracy on Russian in our bake-off, ~1.5 s, ~$0.001 per 30 s), fallback `openai/gpt-4o-transcribe`, language hint `ru`. iPhone CAF Opus is remuxed to Ogg in TypeScript — no provider accepts CAF and there is no ffmpeg on Vercel. If transcription fails and there is no other text, Bro sends a short Russian retry line and skips the agent. Override with `BRO_STT_MODEL` / `BRO_STT_FALLBACK_MODEL` / `BRO_STT_LANGUAGE`. Check: `npm run voice:check`.

## Needs

- Node 24 (`nvm use`)
- Inkbox API key, OpenRouter (`deepseek/deepseek-v4.1-flash`, override with `BRO_MODEL` / `BRO_MODEL_CONTEXT_TOKENS`) or Vercel AI Gateway
- TinyFish API key (optional; `web_search` / `web_fetch` for public facts). Without it those tools say they are unset. Interactive shops stay on Browser Use.

## Run

```bash
cp .env.example .env.local
# fill INKBOX_*, OPENROUTER_API_KEY (or AI_GATEWAY_API_KEY), ALLOWED_SENDERS
npm run memory:check
npm run provision:inkbox    # once — mail-only identity
npm run webhooks            # once: Inkbox mail signing key
npm run photon:webhooks     # once: Photon inbound URL + SPECTRUM_WEBHOOK_SECRET
npm run dev:local           # eve :2000
```

Production: Convex cloud + `eve deploy` on Vercel. Photon webhook is `https://<host>/webhooks/photon`. Inkbox mail webhook stays `/webhooks/mail`.

`npm run dev` is TUI-only (no public URL).

Onboard: landing «Получить своего бро» asks for the iPhone number, creates a Photon shared user, and opens Messages to the assigned +1. Blue iMessage only. iPhone Settings → Messages → Send as SMS = off. Do not text `connect @handle`.

iMessage groups are paused on Photon Pro. `group_chat` explains that Bro is 1:1 until Business. Check: `npm run group:check`.

Inkbox identities are mail-only (`imessage_enabled: false`). `BRO_DEDICATED_LINE` does not claim a chat line. Check: `npm run dedicated:check`. Photon env: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `SPECTRUM_WEBHOOK_SECRET`. Check: `npm run photon:check`.

Memory is three eve slots, all keyed by the person's E.164. `memo` (always on) is curated facts in the Convex `memories` table: recalled every turn, maintained by the model via `memo__remember` / `memo__search` / `memo__forget`, deduped and capped at 400 lines per person. `recall` mounts only when `SUPERMEMORY_API_KEY` is set: [Supermemory](https://supermemory.ai) then captures completed turns automatically, recalls relevant context before each turn, and adds `recall__search` and friends — no extra setup. Without the key both Supermemory slots are disabled and nothing breaks. Check: `npm run memory:check`.

`archive` is the Instinct-style layer (also Supermemory-gated): a Convex cron POSTs `/internal/memory-sync` hourly per active tenant, the eve route copies fresh Gmail and upcoming Calendar items via Composio into one Supermemory container per person (`bro_archive_<E.164>`, upserts by `customId`), and the slot semantically searches that archive with the current request before every turn. Archived copies survive app disconnects — deletion is the explicit `archive__forget` tool. Check: `npm run archive:check`.

Push watchers (`watch_app`): Composio triggers POST Convex `/composio`, then one agent turn per event. Subscribe once with `npm run composio:webhook https://<deployment>.convex.site/composio`. Prices/websites still poll via `schedule_wakeup kind=watcher`. Check: `npm run watchers:check`.

Public facts use TinyFish Search + Fetch (`web_search`, `web_fetch`) — free, even at a $0 wallet; rate limits only (PAYG: 30 searches/min, 150 fetch URLs/min). Set `TINYFISH_API_KEY` (from [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys)) on eve / Vercel. Interactive shops, bookings, and logins stay on `browser_task`. Check: `npm run tinyfish:check`.

Sandbox tools (`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL`) have no web access by policy; facts go through TinyFish, shops through `browser_task`. Check: `npm run sandbox:check`.

Landing CTA creates a mail-only Inkbox identity plus a Photon shared user, then opens Messages (`sms:` to the assigned +1).
`assets/config.js` holds the Convex HTTP site URL (`https://<deployment>.convex.site`).
Set `INKBOX_API_KEY`, `INKBOX_WEBHOOK_URL`, and the `SPECTRUM_*` keys on the Convex deployment.
Cap is `BRO_IDENTITY_CAP` (default 100).

Billing is a one-shot YooKassa month. Set `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` on the Convex deployment; webhook URL is `https://<deployment>.convex.site/yookassa`. Empty keys keep the free beta, with daily message and monthly browser-job limits.

The landing «Войти» button opens a cabinet. First access still goes through «Запросить доступ». Later logins send a one-time code to the bound iMessage thread. Cabinet reads (`GET /me`) take a session token, never a tenant id. Check: `npm run cabinet:check`.

Operator board is `/ops.html` — not linked from the landing. It asks for `BRO_INTERNAL_SECRET` and reads `GET /ops` / `GET /ops/person`. You see who signed up, who wrote, who is stuck, and a short event log. No chat bodies. Check: `npm run ops:check`.

Site logins: if they already sent a password in chat, Bro types it (one short security warning, no lecture). On a new service Bro asks them for the password first and does not invent one. If they will not send a password, Bro texts a link; they sign in or register themselves, and cookies stay on their Browser Use Cloud profile. If a session expires and there is no password in the thread, Bro sends another link. Check: `npm run profile:check`.

The vault holds per-tenant cards, addresses, and contacts — not site passwords. AES-256-GCM keys are derived from `BRO_VAULT_KEY` (set on the Convex deployment; `openssl rand -base64 32`). Losing or rotating it makes existing items undecryptable. The model only ever receives opaque handles; secrets are injected into the page over CDP and masked in screenshots. The human types them at `/vault.html` behind the cabinet login. Vault links use `BRO_CABINET_BASE`. The `worker` subagent needs `KERNEL_API_KEY` (Kernel cloud browsers); without it `worker` fails with a clear error and `browser_task` keeps working. Proxy: `BRO_KERNEL_PROXY_COUNTRY` (default `ru`, `none` disables) or `BRO_KERNEL_PROXY_ID`; `BRO_KERNEL_REGION` moves the browser VM off Kernel's `us-east` default. One `worker` assignment costs one browser job however many browsers it opens. Check: `npm run vault:check`, `npm run worker:check`, `npm run types:check`.

Bro can also pay with the vault card inside a `browser_task` run itself, via Browser Use Cloud `secretBindings`: the server types the card into the focused field on the allowed hosts, the model never sees the value, and the bindings die with the run. A buy request or a «купи когда…» watcher pays without a second confirmation of shop/item/qty/total; `maxRub` is only a named budget. 3-D Secure, SMS codes, and bank-app confirmation still go to the human via live URL. Check: `npm run pay:check`, `npm run purchase:check`.

Bro's Inkbox mailbox is live: inbound `POST /webhooks/mail`, outbound `bro_mail`. `bro_mail` action=inbox lists recent inbound. When a worker needs an OTP (bank / WB / clinic), Bro looks in that inbox and the Instinct archive first (`otp` subagent or `otp_lookup`) and only asks in the iMessage thread if the letter is missing. Inbound Bro mail is also copied into the archive when Supermemory is on. Check: `npm run otp:check`.
Long work parks as Convex `jobs` (`npm run jobs:check`). Re-run `npm run webhooks` to subscribe mail.

Convex `returns:` validators reject documents with unknown fields, so every full-document validator (`tenantDoc`, `jobDoc`, …) is `doc(schema, "<table>")` from convex-helpers, never a hand-copied field list. Adding a column to `convex/schema.ts` is enough. Check: `npm run schema:check` (fails on any `v.object({ _id: v.id(…) })` literal in `convex/`). Postmortem 2026-09-05: a hand-copied `tenantDoc` without `archiveSyncedAt` made every tenant read throw once the hourly archive sync wrote that column, and Bro went silent.

Model calls always carry `max_tokens` (default 8192, `BRO_MAX_OUTPUT_TOKENS`): OpenRouter reserves the requested output length against the account balance before running, and without a cap it reserves the model's full 131k, so every turn fails with 402 as soon as credits dip. Postmortem 2026-09-06: `.harness/goals/openrouter-402-rca`. Check: `npm run model:check`.

A session that received a photo before #25 keeps `Uint8Array` parts in its eve history, and every memory-tool closure fails on each later turn. One-off cure: `POST /internal/session-clear` with `{ secret: BRO_INTERNAL_SECRET, conversationId }` (drops model history; Convex and Supermemory memory stay).

A human turn never ends in silence. Every `from().send` is stamped `origin: human | wakeup`; when a human-origin turn fails (`turn.failed`) or the model ends it with no text (tool errors, provider hiccup), the channel sends one short «что-то сломалось» line itself. Background wakeups may still end empty. Check: `npm run silent:check`.
