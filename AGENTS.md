# Bro — cloud / AI testers

Talk to Bro over **real iMessage** (Inkbox + Apple). Do not ask the operator to exercise Bro from their iPhone. Do not POST a fake inbound to `/internal/sim` for this lane — that never proves delivery, downgrade, or the webhook signature.

## Lane

1. Secrets already on the cloud environment: `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET`, `BRO_INTERNAL_SECRET`, `OPENROUTER_API_KEY`, `CONVEX_DEPLOY_KEY`.
2. Isolated Convex for the QA Bro (do not use the operator's production `CONVEX_DEPLOY_KEY` as the default dest): `CONVEX_AGENT_MODE=anonymous npx convex dev`. Set `BRO_INTERNAL_SECRET` on that deployment to match eve.
3. `npm run live -- status` — Inkbox identities, router, dedicated-line readiness. Exit 2 when the lane cannot start a conversation.
4. `npm run live -- provision --qa` — create `BRO_LIVE_TESTER_HANDLE` (default `bro-live-tester`) with `claimIMessageNumber: true`, and `BRO_LIVE_BRO_HANDLE` (default `bro-live-bro`) on the shared pool plus a tunnel webhook. This handle is **not** `bro-ageree`.
5. The tester **must** have a start-capable dedicated iMessage number. Shared pool is inbound-first. Current Free/Developer plans return `DedicatedIMessageNumberQuotaExceededError`; upgrade Inkbox to Startup with a start-capable dedicated line (`https://inkbox.ai/console/organizations?tab=billing`), then re-run provision.
6. Export `ALLOWED_SENDERS` to include the tester E.164 (provision prints the merged list).
7. `bash scripts/dev-live.sh` — eve on `:2000` as `bro-live-bro` + Inkbox tunnel. Never point the tunnel at `bro-ageree` (production webhook).
8. `npm run live -- "привет"` — tester sends a real blue iMessage to the router (`connect @bro-live-bro` first if needed), then polls the tester inbox for Bro's inbound bubbles.
9. `npm run live -- --play .harness/plays/live-help.json` — scripted play with `expect` regexes.

Optional: `BRO_LIVE_TARGET` overrides the router E.164. `--bro bro-ageree` aims at production — only when the tester number is on **production** `ALLOWED_SENDERS` and you intend to bind a real tenant.

## What this covers

Apple delivery (`service=imessage`, refuse downgrade), the live Inkbox webhook signature, onboard/help, agent turns, tools, Convex memory/jobs. Same path a person on an iPhone uses.

## What not to do

- Do not text the operator's real number (`+79217818876`) or dump that thread.
- Do not run `npm run tunnel` / `dev:local` as `bro-ageree` from a cloud agent.
- Do not treat a local loopback as live iMessage.
- Structural checks stay `npm run <area>:check`. `npm run live:check` covers this lane's policy. `npm run live -- status` is the live Inkbox probe.

## Cursor Cloud

`INKBOX_API_KEY` is injected. `npm run live -- status` works without extra secrets. A send/play needs the dedicated tester line (plan upgrade above) plus `dev-live.sh` and anonymous Convex when judging this checkout rather than production.
