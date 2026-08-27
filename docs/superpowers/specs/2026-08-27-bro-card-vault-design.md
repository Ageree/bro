# bro — add your card (BYOC)

_Date: 2026-08-27_

## Product

The human adds their own bank card once on a hosted page (Agentcard-style
BYOC). Bro fills that card on Ozon/WB checkout. The human confirms 3DS
(bank push, or types/forwards the SMS code in iMessage). Bro never
issues a card. Bro never asks for PAN in chat.

## Decisions

- **One card per tenant.** New save overwrites. «забудь карту» clears it.
- **Hosted form, not iMessage.** One-time HTTPS link, ~15 min, single use.
  Page lives next to the landing (`card.html`). POST hits Convex HTTP
  `/card`, same pattern as `/access`.
- **Encrypt at rest.** AES-256-GCM of `PAN|CVC` with `BRO_CARD_KEY` (env
  on Convex and eve). Last4, brand, expiry are plaintext so chat can
  say `МИР •••• 4412`. Cipher never returned to the model.
- **Inject in `browser_task`, not in the prompt the model writes.** Eve
  decrypts in-process and appends card digits only to the Browser Use
  API task. Tool JSON back to the model is last4/status only. Browser
  Use sees PAN for that job — accepted ceiling for cap 10.
- **3DS is not skipped.** Push: human taps the bank app; Bro polls the
  browser. SMS/ACS form: Bro asks for the code in iMessage, types it
  into the cloud browser, no `liveUrl` unless the ACS cannot be driven.
  Bro does not read bank SMS from the human’s Messages.app. Inkbox SMS
  inbound is out of v1 (Bro stays blue-outbound; a forwarded code in
  this thread is enough).
- **Jobs.** Checkout with 3DS parks `waitingFor: human` until the code
  or a «готово» / paid poll.
- **Out of scope:** issuing (T-Bank, Paygine, Agentcard Issue, crypto
  MIR), multiple cards, PCI vault vendor, Stripe, PAN in OptMem/orders
  /iMessage/logs, Bro tapping the bank push, subscriptions, Inkbox
  dedicated SMS as the card’s 3DS phone.

## Data

`tenants` adds:

- `cardLast4`, `cardBrand` (`mir` | `visa` | `mc`)
- `cardExpMonth`, `cardExpYear`
- `cardBlob` — one string: iv + ciphertext + tag (AES-256-GCM)
- `cardStatus` (`active` | `removed`)

`cardLinks`: `tenantId`, `token`, `expiresAt`, `used`. Index `by_token`.

Env: `BRO_CARD_KEY` (32-byte hex), `BRO_PUBLIC_ORIGIN` (landing host for
the link). Missing key → minting a link fails closed.

## Flow

1. Human wants to buy, no active card → Bro mints a link
   `{BRO_PUBLIC_ORIGIN}/card.html?t=…` and waits.
2. Form: number, MM/YY, CVC. Luhn + expiry. Brand from BIN (`2200…` →
   mir). POST `/card` encrypts, writes tenant, burns the token. Page
   shows `МИР •••• 4412`.
3. Bro on checkout: `browser_task` decrypts, tells Browser Use to fill
   payment fields and **not** to solve 3DS itself.
4. Push 3DS → iMessage «подтверди в банке»; poll until paid.
5. SMS/ACS → iMessage «пришли код»; next human message is the OTP;
   `browser_task` types it; still no PAN in chat.
6. Paid → real merchant order id into `orders` (existing table). Invented
   ids remain forbidden.
7. «забудь карту» → `removed`, cipher deleted.

## Files

- `convex/schema.ts`, `convex/http.ts`, `convex/cards.ts`
- `convex/lib/cardPolicy.ts` — token, brand, luhn, ttl
- `card.html` + `assets/config.js` (`BRO_CONVEX_SITE_URL`)
- `agent/lib/card.ts` — mint link, last4 for chat, decrypt only inside
  `browser_task`
- `agent/tools/browser_task.ts`, `agent/instructions.md`
- `scripts/card-policy-check.ts`

## Verification

- `npm run card:check` — luhn, brand, ttl, used-token reject, cipher
  roundtrip, model payload never contains PAN
- Live: bind card from iPhone → last4 in chat, no digits → cheap Ozon
  order → 3DS push or code in iMessage → real order id → «забудь карту»
  → next buy asks for a new link
- Fail if PAN appears in iMessage, logs, or tool result JSON
