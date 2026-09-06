# Bro — cloud / AI testers

Do not ask the operator to exercise Bro from their iPhone. Talk to the same agent through the sim lane.

## Lane

1. Secrets in the environment: `BRO_INTERNAL_SECRET`, `CONVEX_URL`, `OPENROUTER_API_KEY` (or `AI_GATEWAY_API_KEY`).
2. `bash scripts/dev-sim.sh` — eve on `:2000`, no Inkbox tunnel.
3. `npm run sim -- "<text>"` — one inbound turn, print Bro's bubbles.
4. `npm run sim -- --play .harness/plays/help.json` — scripted play with `expect` regexes.
5. `npm run sim -- --drain` — collect bubbles after `/internal/wakeup` (same `sim:` conversation).

Phones must be `+1555` + 7 digits (default `+15550001000`). Conversation id is `sim:+1555…`. Outbound is captured in process; Inkbox is never called.

## What this covers

Agent turns, tools, Convex memory/jobs/wakeups, canned help/onboard copy. Not Apple delivery, SMS downgrade, or the live Inkbox webhook signature.

## What not to do

- Do not text the operator's real number.
- Do not pass a non-`+1555` phone to `/internal/sim` (the route rejects it).
- Do not run `npm run dev:local` / the tunnel just to chat with Bro.
- Structural checks stay `npm run <area>:check`. Sim is for behavior the checks cannot see.
