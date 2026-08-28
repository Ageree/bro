# Bro

Personal iMessage concierge. **eve** runs the agent. **Convex** holds tenants and orders. **Inkbox** is blue iMessage only (never SMS). **OptMem** is long-term memory, one store per person.

Outbound replies are compiled to iMessage text: markdown is stripped, `**latin**` becomes Unicode math-bold (looks bold on iPhone), Russian field labels get a `▸` mark, long numbered dumps become one bubble per item. Inkbox cannot send native iOS 18 text styles or carousels. Inbound photos/carousels reach the model as URLs. Check: `npm run imessage:check`.

## Needs

- Node 24 (`nvm use`)
- Python 3 (OptMem `vendor/optmem/memo`)
- Inkbox API key, OpenRouter (`z-ai/glm-5.3-flash`, override with `BRO_MODEL` / `BRO_MODEL_CONTEXT_TOKENS`) or Vercel AI Gateway

## Run

```bash
cp .env.example .env.local
# fill INKBOX_*, OPENROUTER_API_KEY (or AI_GATEWAY_API_KEY), ALLOWED_SENDERS
npm run optmem:check
npm run provision:inkbox    # once
npm run webhooks            # once: signing key + https://<handle>.inkboxwire.com/webhooks/imessage
npm run dev:local           # eve :2000 + Inkbox tunnel (needed for iMessage)
```

Production (you are just a user on iMessage): Convex cloud + `eve deploy` on Vercel. Webhook URL is the Vercel host, not the laptop tunnel.

`npm run dev` is TUI-only (no public URL). Local iMessage still needs the tunnel: `https://bro-ageree.inkboxwire.com`.

Onboard: after provision, the human texts `connect @bro-ageree` to the printed router **as iMessage** (blue). iPhone Settings → Messages → Send as SMS = off.

Shared router pool is the default (inbound-first, ~100 messages/day). To let Bro write first, set `BRO_DEDICATED_LINE=1` before `npm run provision:inkbox` and on the Convex deployment. New identities then pass Inkbox `claimIMessageNumber: true` (create) or `identity.update({ claimIMessageNumber: true, idempotencyKey })` (existing). Unattached inventory is `inkbox.imessages.claimNumber({ idempotencyKey })` — Bro does not call that on the default path. Off by default; shared pool is unchanged. Number/status, when returned, is stored on the tenant. Check: `npm run dedicated:check`.

Memory files: `data/optmem/<E.164>/` (gitignored). Runtime memory is Convex.

Landing CTA creates a personal Inkbox identity and opens iMessage (`sms_link`).
`assets/config.js` holds the Convex HTTP site URL (`https://<deployment>.convex.site`).
Set `INKBOX_API_KEY` and `INKBOX_WEBHOOK_URL` on the Convex deployment.
Cap is `BRO_IDENTITY_CAP` (default 100).
`BRO_DEDICATED_LINE` on Convex claims a dedicated line at landing provision.

Billing is a one-shot YooKassa month. Set `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` on the Convex deployment; webhook URL is `https://<deployment>.convex.site/yookassa`. Empty keys keep the free beta, with daily message and monthly browser-job limits.

The landing «Войти» button opens a cabinet. First access still goes through «Запросить доступ». Later logins send a one-time code to the bound iMessage thread. Cabinet reads (`GET /me`) take a session token, never a tenant id. Check: `npm run cabinet:check`.

Bro's Inkbox mailbox is live: inbound `POST /webhooks/mail`, outbound `bro_mail`.
Long work parks as Convex `jobs` (`npm run jobs:check`). Re-run `npm run webhooks` to subscribe mail.
