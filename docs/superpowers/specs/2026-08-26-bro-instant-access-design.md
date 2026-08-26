# bro — instant iMessage access

_Date: 2026-08-26_

## Product

Landing CTA «Запросить доступ» creates a **personal Inkbox identity** and opens
Messages with a one-tap Send to the shared iMessage router. Not a waitlist.
Not an approve queue. Not a unique phone number per person.

## Decisions

- **Identity per person.** `createIdentity("bro-<id>")` with `imessage_enabled`.
  Own handle, own mailbox, own memory (Convex, keyed as today by phone once
  bound). Display name is always `Bro`.
- **Shared router, one-tap Send.** Inkbox cannot hide the router on shared
  service. Use the router’s `sms_link` so Messages opens with `connect @handle`
  already drafted. After Send, the router sends Bro’s contact card; further
  chat looks like Bro, not the router.
- **No unique iMessage number.** Dedicated lines are one-per-org on current
  plans. Out of scope.
- **iPhone only to create.** Non-iOS does not mint an identity (Developer cap
  is 10 identities / 10 iMessage recipients). Copy: open this page on iPhone.
- **Reuse in the same browser.** `localStorage["bro.handle"]`. Repeat click
  re-resolves `sms_link` (router number can change); does not create.
- **First inbound phone wins.** Whoever first messages that identity is bound
  to the tenant. A different number later is dropped. `ALLOWED_SENDERS` is no
  longer the product gate (keep as unused env for now).
- **Landing stays static** `index.html` + a few lines of JS. No framework.
- **Create path is Convex HTTP** `POST /access` (public, CORS). Eve stays the
  iMessage webhook. Two surfaces, no `eve build` for the site.
- **Out of scope:** email channel, virtual card, orders ledger, OptMem,
  waitlist, admin UI, merging agents across devices.

## Flow

1. iPhone taps CTA.
2. `POST {convex.site}/access` with optional `{ handle }` from localStorage.
3. If handle exists → return fresh `{ handle, smsLink, connectCommand }`.
4. Else, if identity cap reached → `{ ok: false, code: "closed" }`.
5. Else create Inkbox identity, subscribe webhook
   `{INKBOX_WEBHOOK_URL}?h={handle}`, store tenant + per-identity signing key,
   return `sms_link` from `GET /imessage/triage-number?agent_identity_id=`.
6. Page sets `localStorage` and `location.href = smsLink`.
7. Human hits Send. Router connects. First *real* inbound to eve binds
   `phoneE164` on that tenant. Replies go out as that identity.

## Data

`tenants` adds optional `inkboxHandle`, `inkboxIdentityId`, `emailAddress`,
`webhookSigningKey`. `phoneE164` becomes optional (bound on first message).
Indexes: existing `by_phone`, new `by_handle`.

Founder tenant (phone, no handle) keeps working: webhook without `?h=` uses
`INKBOX_AGENT_HANDLE` + `INKBOX_WEBHOOK_SECRET` as today.

Memories stay keyed by phone. New users have no memory until first iMessage.

## Agent

- Webhook URL query `h` selects identity. Verify with that tenant’s signing
  key. `sendIMessage` uses `getIdentity(handle)`, not the env handle.
- Session auth `principalId` remains the human E.164. Attributes also store
  `inkboxHandle`.
- `browser_task` notify/send uses the tenant handle.

## Caps and abuse

- `BRO_IDENTITY_CAP` (default 10) counted as tenants with `inkboxHandle`.
- Server UA must look like iOS to create (not to reuse).
- Inkbox `402` → same `closed` response.
- Handle format: `bro-` + 8 lowercase alphanumeric, retry on 409 (max 3).

## Files

- `index.html` — CTA JS
- `assets/config.js` — `BRO_CONVEX_SITE_URL` (gitignored; example committed)
- `convex/schema.ts`, `convex/tenants.ts`, `convex/access.ts`, `convex/http.ts`
- `agent/channels/imessage.ts`, `agent/lib/inkbox.ts`, `agent/lib/convex.ts`
- `docs/superpowers/specs/2026-08-26-bro-instant-access-design.md` (this file)

## Verification

- `npm run access:check` — UA, handle, bind-phone, cap (pure, no network)
- Tap CTA on iPhone (or iOS UA in Safari): Messages opens with connect draft
- Repeat tap does not create a second identity
- Desktop tap does not create
- First iMessage to the new handle is answered as that identity
