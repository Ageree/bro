# Bro

Personal iMessage concierge. **eve** runs the agent. **Convex** holds tenants, orders, and long-term memory (one store per person). **Inkbox** is blue iMessage only (never SMS). **Supermemory** (optional, paid) adds automatic conversation memory.

Outbound replies are compiled to iMessage text: markdown is stripped, `**latin**` becomes Unicode math-bold (looks bold on iPhone), Russian field labels get a `▸` mark, long numbered dumps become one bubble per item. Inkbox cannot send native iOS 18 text styles or carousels. Inbound photos/carousels reach the model as URLs. Check: `npm run imessage:check`.

Voice notes: inbound audio is transcribed via OpenRouter STT before the model sees it (`[voice] …`). iPhone CAF Opus is remuxed to Ogg in TypeScript (no ffmpeg in production). If transcription fails and there is no other text, Bro sends a short Russian retry line and skips the agent. Override with `BRO_STT_MODEL` / `BRO_STT_FALLBACK_MODEL` / `BRO_STT_LANGUAGE`. Check: `npm run voice:check`.

## Needs

- Node 24 (`nvm use`)
- Inkbox API key, OpenRouter (`z-ai/glm-5.3-flash`, override with `BRO_MODEL` / `BRO_MODEL_CONTEXT_TOKENS`) or Vercel AI Gateway

## Run

```bash
cp .env.example .env.local
# fill INKBOX_*, OPENROUTER_API_KEY (or AI_GATEWAY_API_KEY), ALLOWED_SENDERS
npm run memory:check
npm run provision:inkbox    # once
npm run webhooks            # once: signing key + https://<handle>.inkboxwire.com/webhooks/imessage
npm run dev:local           # eve :2000 + Inkbox tunnel (needed for iMessage)
```

Production (you are just a user on iMessage): Convex cloud + `eve deploy` on Vercel. Webhook URL is the Vercel host, not the laptop tunnel.

`npm run dev` is TUI-only (no public URL). Local iMessage still needs the tunnel: `https://bro-ageree.inkboxwire.com`.

Onboard: after provision, the human texts `connect @bro-ageree` to the printed router **as iMessage** (blue). iPhone Settings → Messages → Send as SMS = off.

Shared router pool is the default (inbound-first, ~100 messages/day). To let Bro write first, set `BRO_DEDICATED_LINE=1` before `npm run provision:inkbox` and on the Convex deployment. New identities then pass Inkbox `claimIMessageNumber: true` (create) or `identity.update({ claimIMessageNumber: true, idempotencyKey })` (existing). Unattached inventory is `inkbox.imessages.claimNumber({ idempotencyKey })` — Bro does not call that on the default path. Off by default; shared pool is unchanged. Number/status, when returned, is stored on the tenant. Check: `npm run dedicated:check`.

Memory is three eve slots, all keyed by the person's E.164. `memo` (always on) is curated facts in the Convex `memories` table: recalled every turn, maintained by the model via `memo__remember` / `memo__search` / `memo__forget`, deduped and capped at 400 lines per person. `recall` mounts only when `SUPERMEMORY_API_KEY` is set: [Supermemory](https://supermemory.ai) then captures completed turns automatically, recalls relevant context before each turn, and adds `recall__search` and friends — no extra setup. Without the key both Supermemory slots are disabled and nothing breaks. Check: `npm run memory:check`.

`archive` is the Instinct-style layer (also Supermemory-gated): a Convex cron POSTs `/internal/memory-sync` hourly per active tenant, the eve route copies fresh Gmail and upcoming Calendar items via Composio into one Supermemory container per person (`bro_archive_<E.164>`, upserts by `customId`), and the slot semantically searches that archive with the current request before every turn. Archived copies survive app disconnects — deletion is the explicit `archive__forget` tool. Check: `npm run archive:check`.

Push watchers (`watch_app`): Composio triggers POST Convex `/composio`, then one agent turn per event. Subscribe once with `npm run composio:webhook https://<deployment>.convex.site/composio`. Prices/websites still poll via `schedule_wakeup kind=watcher`. Check: `npm run watchers:check`.

Landing CTA creates a personal Inkbox identity and opens iMessage (`sms_link`).
`assets/config.js` holds the Convex HTTP site URL (`https://<deployment>.convex.site`).
Set `INKBOX_API_KEY` and `INKBOX_WEBHOOK_URL` on the Convex deployment.
Cap is `BRO_IDENTITY_CAP` (default 100).
`BRO_DEDICATED_LINE` on Convex claims a dedicated line at landing provision.

Billing is a one-shot YooKassa month. Set `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` on the Convex deployment; webhook URL is `https://<deployment>.convex.site/yookassa`. Empty keys keep the free beta, with daily message and monthly browser-job limits.

The landing «Войти» button opens a cabinet. First access still goes through «Запросить доступ». Later logins send a one-time code to the bound iMessage thread. Cabinet reads (`GET /me`) take a session token, never a tenant id. Check: `npm run cabinet:check`.

Site logins: Bro texts a link. The person opens it, signs in on the site, and cookies stay on their Browser Use Cloud profile. Bro never sees the password. If a session expires, Bro sends another link. Check: `npm run profile:check`.

The vault holds per-tenant cards, addresses, and contacts — not site passwords. AES-256-GCM keys are derived from `BRO_VAULT_KEY` (set on the Convex deployment; `openssl rand -base64 32`). Losing or rotating it makes existing items undecryptable. The model only ever receives opaque handles; secrets are injected into the page over CDP and masked in screenshots. The human types them at `/vault.html` behind the cabinet login. Vault links use `BRO_CABINET_BASE`. The `worker` subagent needs `KERNEL_API_KEY` (Kernel cloud browsers); without it `worker` fails with a clear error and `browser_task` keeps working. Proxy: `BRO_KERNEL_PROXY_COUNTRY` (default `ru`, `none` disables) or `BRO_KERNEL_PROXY_ID`; `BRO_KERNEL_REGION` moves the browser VM off Kernel's `us-east` default. One `worker` assignment costs one browser job however many browsers it opens. Check: `npm run vault:check`, `npm run worker:check`, `npm run types:check`.

Bro's Inkbox mailbox is live: inbound `POST /webhooks/mail`, outbound `bro_mail`.
Long work parks as Convex `jobs` (`npm run jobs:check`). Re-run `npm run webhooks` to subscribe mail.
