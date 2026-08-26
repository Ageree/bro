# Bro

Personal iMessage concierge. **eve** runs the agent. **Convex** holds tenants and orders. **Inkbox** is blue iMessage only (never SMS). **OptMem** is long-term memory, one store per person.

## Needs

- Node 24 (`nvm use`)
- Python 3 (OptMem `vendor/optmem/memo`)
- Inkbox API key, Vercel AI Gateway (or another model key)

## Run

```bash
cp .env.example .env.local
# fill INKBOX_*, AI_GATEWAY_API_KEY, ALLOWED_SENDERS
npm run optmem:check
npm run dev                 # eve at http://127.0.0.1:2000
```

Onboard: `npm run provision:inkbox`, then the human texts `connect @bro` to the printed router **as iMessage** (blue). iPhone Settings → Messages → Send as SMS = off.

Memory files: `data/optmem/<E.164>/` (gitignored).
