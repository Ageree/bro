# Bro

Personal iMessage concierge. **eve** runs the agent. **Convex** holds tenants and orders. **Inkbox** is blue iMessage only (never SMS). **OptMem** is long-term memory, one store per person.

## Needs

- Node 24 (`nvm use`)
- Python 3 (OptMem `vendor/optmem/memo`)
- Inkbox API key, Vercel AI Gateway (or another model key)

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

Memory files: `data/optmem/<E.164>/` (gitignored).
