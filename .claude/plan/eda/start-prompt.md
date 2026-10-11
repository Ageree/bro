# Unit: Yandex Eda ordering through the API (worker start prompt)

You implement Yandex Eda (eda.yandex.ru) restaurant ordering for Bro, and only that.
Repo: Ageree/bro, base branch `bro-next`. Work on your own branch, open a draft PR into
`bro-next`, then stop. Never merge, never deploy, never place a real Eda order: the
coordinator session does the live order after review. Commits and PR title in Russian,
from the user's point of view (see docs/dev-notes.md "Процесс").

## Read first
- AGENTS.md, docs/dev-notes.md (environment section: Node 24, env -u TELEGRAM_BOT_USERNAME …).
- docs/yandex-api/food.md (Eda read operations), docs/yandex-api/purchases.md, docs/yandex-api/go-booking.md.
- The Lavka flow is the model to copy, compactly: agent/lib/yandex/food/cart.ts
  (`food.lavka_cart_set`), agent/lib/yandex/lavka/checkout.ts (prepare / submit / payment
  polling), agent/tools/yandex_purchase.ts (prepare → verbatim confirmationQuestion →
  person's yes → confirm; status).

## What to build (small, elegant: the owner hates bloat — no defensive layers, no test-only seams)
1. `food.eda_cart_set` (access "cart") in agent/lib/yandex/food/cart.ts: put items of one
   place into the Eda cart with quantities (0 removes). Client code: `addItem` →
   `v1.post("/cart", …)` (= POST /api/v1/cart), `changeItem` → PUT /api/v1/cart/{id},
   `removeItem` → DELETE /api/v1/cart/{id}; GET /api/v1/cart reads it. Find the exact bodies
   (item id, place slug, quantity, item options) by reading the Eda bundle and by a live
   probe (below). Answer the cart like food.lavka_cart does (items, subtotal, delivery fee, total).
2. `agent/lib/yandex/eda/checkout.ts`: `prepareEdaPurchase` (reads cart, the saved address
   "Дом" from GET /api/v3/user/addresses — the same id as Lavka's, and the default card;
   returns publicQuote {items, delivery address, payment, amountMinor} + snapshot) and
   `submitEdaPurchase` (POST /api/v1/orders as `eats.desktop.98332-*.js` builds it: payment
   method, `userAddressId`, `request_id`, …; then poll the payment like Lavka's `payment()`
   if Eda has such a status endpoint — find it). Never retry the order POST.
3. Wire `service: "eda"` into yandex_purchase prepare/confirm/status by generalising the
   Lavka path (DB enum `service` in db/schema/yandex-purchases.ts + CHECK migration via
   `pnpm db:generate`, then `pnpm exec oxfmt db/migrations/meta`).
4. Tests in the existing style (tests/agent/yandex/food/fake-page.ts, lavka-purchase.test.ts):
   a few that pin the request bodies and the outcomes; no more.

## Live probe (read-only + cart changes only)
`python3 scripts/cloudru-app-host/yandex-probe.py bro-app-sel-2 spec.json out.json` runs in
the owner's own pool browser (see ops/yandex-probe.ts for the spec). First, from a fresh
session: export BRO_CLOUD=selectel BRO_APP_HOST_DIR=/root/.bro-app-host-selectel
S3_ENDPOINT=https://s3.ru-1.storage.selcloud.ru S3_REGION=ru-1 PROBE_BUCKET=bro-bucket,
then `python3 scripts/cloudru-app-host/host.py state restore`. Workspace id:
`personal:85be64ec145182e956a9e9d7b7a6d568`. A `{workspace, page, steps}` spec records every
fetch/XHR of the page with bodies; steps are JS expressions awaited in the page. Only
registered operations can be called with `{op, args}`, so test a new in-page function by
pasting its source as a step. "expired token" right after a wake is the snapshot clock:
retry once. Allowed live: reading anything, adding/removing items in the Eda cart
(leave it empty at the end). Forbidden: POST /api/v1/orders or anything that pays.
Home coordinates: 55.695511, 37.485725. A cheap place near home: slug `doner24_mqn27`.

## Checks
oxlint (`pnpm -s lint:app`), `pnpm -s types:check:app`, oxfmt, knip, and the yandex tests
(`./node_modules/.bin/vitest run tests/agent/yandex db/tests/yandex-purchases.test.ts`, with
`env -u TELEGRAM_BOT_USERNAME -u IMESSAGE_PROJECT_ID`). CI runs the rest.

## Result
Draft PR: what changes for the person, the live evidence (cart set worked, prepare returned
ready with the exact total), the exact submit body you found and where, what is unproven.
Then stop; the coordinator reviews, merges, deploys and places the live order.
