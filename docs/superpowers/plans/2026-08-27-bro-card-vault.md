# Bro card vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The human binds one bank card on a hosted page; Bro fills it on Ozon/WB checkout; 3DS stays with the human (bank push or OTP in iMessage).

**Architecture:** BYOC only. `card.html` posts PAN/CVC to Convex HTTP `/card`. Cipher (AES-256-GCM) lives on `tenants`. Eve decrypts inside `browser_task` and appends digits only to the Browser Use API call. The model sees last4, never PAN.

**Tech Stack:** Convex HTTP + schema, static `card.html`, eve tools, Web Crypto, existing Browser Use / jobs.

**Spec:** `docs/superpowers/specs/2026-08-27-bro-card-vault-design.md`

## Global Constraints

- Node 24, no new dependencies.
- One card per tenant; overwrite on save; «забудь карту» deletes cipher.
- PAN/CVC never in iMessage, OptMem, `orders`, logs, or tool JSON returned to the model.
- Bro does not issue cards and does not read bank SMS from the human’s Messages.app.
- Outbound iMessage stays blue (`sendBlueIMessage`).
- Follow existing `assertSecret` / `BRO_INTERNAL_SECRET` and `scripts/*-check.ts` assert style.
- Do not commit unless the human asked.

---

### Task 1: Card policy (pure)

**Files:**
- Create: `convex/lib/cardPolicy.ts`
- Create: `scripts/card-policy-check.ts`
- Modify: `package.json` — add `"card:check": "node --experimental-strip-types scripts/card-policy-check.ts"`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
export type CardBrand = "mir" | "visa" | "mc";

export function digitsOnly(s: string): string;
export function luhnOk(pan: string): boolean;
export function cardBrand(pan: string): CardBrand | null; // 2200–2204 → mir; 4 → visa; 51–55/2221–2720 → mc
export function expiryOk(month: number, year: number, now?: Date): boolean; // year 2-digit or 4
export function cvcOk(cvc: string): boolean; // 3–4 digits
export function parseCardInput(input: {
  pan: string;
  expMonth: number;
  expYear: number;
  cvc: string;
}):
  | { ok: true; pan: string; expMonth: number; expYear: number; cvc: string; brand: CardBrand; last4: string }
  | { ok: false; error: string };

export function makeCardToken(bytes: Uint8Array): string; // 24 bytes → 48 hex
export function linkFresh(expiresAtMs: number, used: boolean, nowMs: number): boolean;
export function cardLinkUrl(origin: string, token: string): string; // `${origin}/card.html?t=${token}`

export function cardPlain(pan: string, cvc: string): string; // `${pan}|${cvc}`
export function splitCardPlain(s: string): { pan: string; cvc: string };
export async function encryptCard(plain: string, keyHex: string): Promise<string>;
export async function decryptCard(blob: string, keyHex: string): Promise<string>;
export function modelPayloadHasPan(payload: unknown, pan: string): boolean;
```

Encrypt: AES-256-GCM, 12-byte IV, key = 32 bytes from 64 hex chars. Blob = base64(iv || ciphertext-with-tag). Use `globalThis.crypto.subtle` (works in Convex httpAction and Node 24).

- [ ] **Step 1: Write the failing check**

`scripts/card-policy-check.ts` same assert style as `scripts/access-policy-check.ts`:

```ts
import {
  cardBrand,
  cardLinkUrl,
  cardPlain,
  cvcOk,
  decryptCard,
  digitsOnly,
  encryptCard,
  expiryOk,
  linkFresh,
  luhnOk,
  makeCardToken,
  modelPayloadHasPan,
  parseCardInput,
  splitCardPlain,
} from "../convex/lib/cardPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(digitsOnly("2200 1234 5678 9012") === "2200123456789012", "digits");
assert(luhnOk("2201382000000013") || luhnOk("2200770212091237") || true, "skip until real luhn fixture");
// Use a known Luhn-valid PAN:
assert(luhnOk("2200000000000006") || luhnOk("4111111111111111"), "visa luhn");
assert(luhnOk("4111111111111111"), "4111 luhn");
assert(!luhnOk("4111111111111112"), "bad luhn");
assert(cardBrand("2200123456789012") === "mir", "mir bin");
assert(cardBrand("4111111111111111") === "visa", "visa");
assert(cardBrand("5555555555554444") === "mc", "mc");
assert(expiryOk(12, 2027, new Date("2026-08-27")), "future");
assert(!expiryOk(1, 2020, new Date("2026-08-27")), "past");
assert(cvcOk("123") && cvcOk("1234") && !cvcOk("12"), "cvc");
const parsed = parseCardInput({
  pan: "4111 1111 1111 1111",
  expMonth: 12,
  expYear: 27,
  cvc: "123",
});
assert(parsed.ok && parsed.last4 === "1111" && parsed.brand === "visa", "parse");
assert(!parseCardInput({ pan: "4111", expMonth: 12, expYear: 27, cvc: "123" }).ok, "short pan");

const tok = makeCardToken(new Uint8Array(24).fill(7));
assert(/^[0-9a-f]{48}$/.test(tok), "token hex");
assert(linkFresh(Date.now() + 60_000, false, Date.now()), "fresh");
assert(!linkFresh(Date.now() - 1, false, Date.now()), "expired");
assert(!linkFresh(Date.now() + 60_000, true, Date.now()), "used");
assert(
  cardLinkUrl("https://example.com", "ab") === "https://example.com/card.html?t=ab",
  "url",
);

const key = "11".repeat(32);
const blob = await encryptCard(cardPlain("4111111111111111", "123"), key);
const back = splitCardPlain(await decryptCard(blob, key));
assert(back.pan === "4111111111111111" && back.cvc === "123", "roundtrip");
assert(
  !modelPayloadHasPan({ last4: "1111", status: "active" }, "4111111111111111"),
  "meta safe",
);
assert(
  modelPayloadHasPan({ hint: "use 4111111111111111" }, "4111111111111111"),
  "leak",
);
console.log("card-policy-check ok");
```

Fix the dummy `luhnOk("2200…") || true` line — do **not** ship a tautology. Keep only real Luhn fixtures (`4111111111111111`, a 16-digit MIR that passes Luhn if you have one; otherwise brand-test MIR BIN with a constructed Luhn-valid 2200… number in the check).

- [ ] **Step 2: Run to verify it fails**

```bash
npm run card:check
```

Expected: fail (module missing) after adding the script to `package.json`.

- [ ] **Step 3: Implement `convex/lib/cardPolicy.ts`**

Minimal functions matching the signatures above. `parseCardInput` uses `digitsOnly`, Luhn, brand, expiry, CVC. `expYear` 0–99 means 2000+year.

- [ ] **Step 4: Run check**

```bash
npm run card:check
```

Expected: `card-policy-check ok`

---

### Task 2: Convex schema + cards

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/tenants.ts` — extend `tenantDoc` with optional card fields (so existing queries still typecheck)
- Create: `convex/cards.ts`

**Interfaces:**
- Consumes: `parseCardInput`, `makeCardToken`, `linkFresh`, `encryptCard`, `cardPlain`, `cardLinkUrl` from `convex/lib/cardPolicy.ts`
- Produces: Convex functions below. Eve calls them with `BRO_INTERNAL_SECRET` like `tenants.*`.

Schema:

```ts
// tenants — add optional:
cardLast4: v.optional(v.string()),
cardBrand: v.optional(v.union(v.literal("mir"), v.literal("visa"), v.literal("mc"))),
cardExpMonth: v.optional(v.number()),
cardExpYear: v.optional(v.number()),
cardBlob: v.optional(v.string()),
cardStatus: v.optional(v.union(v.literal("active"), v.literal("removed"))),

cardLinks: defineTable({
  tenantId: v.id("tenants"),
  token: v.string(),
  expiresAt: v.number(),
  used: v.boolean(),
}).index("by_token", ["token"]),
```

`convex/cards.ts`:

```ts
export const mintLink = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  // 15 min TTL, 24 random bytes → token, insert cardLinks
});

export const last4 = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({
      status: v.literal("active"),
      last4: v.string(),
      brand: v.union(v.literal("mir"), v.literal("visa"), v.literal("mc")),
      expMonth: v.number(),
      expYear: v.number(),
    }),
    v.null(),
  ),
});

export const forget = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.null(),
  // patch tenant: cardStatus removed, cardBlob undefined, last4/brand/exp cleared
});

export const consumeLink = internalMutation({
  args: {
    token: v.string(),
    last4: v.string(),
    brand: v.union(v.literal("mir"), v.literal("visa"), v.literal("mc")),
    expMonth: v.number(),
    expYear: v.number(),
    blob: v.string(),
  },
  returns: v.object({ last4: v.string(), brand: v.string() }),
  // load link by_token; if !linkFresh throw; mark used; patch tenant card* active
});

export const blobForPay = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({
      blob: v.string(),
      expMonth: v.number(),
      expYear: v.number(),
      last4: v.string(),
      brand: v.union(v.literal("mir"), v.literal("visa"), v.literal("mc")),
    }),
    v.null(),
  ),
});
```

`mintLink` origin: `process.env.BRO_PUBLIC_ORIGIN` (no trailing slash). Fail closed if missing. TTL 15 * 60 * 1000.

Do **not** put `blobForPay` result into any tool return. Only `agent/lib/card.ts` (Task 4) may call it.

- [ ] **Step 1: Extend schema + `tenantDoc`**

Add the optional fields to `tenants` and `tenantDoc` in `convex/tenants.ts`. Existing handlers stay as they are.

- [ ] **Step 2: Write `convex/cards.ts`**

Use `assertSecret`. Token: `makeCardToken(crypto.getRandomValues(new Uint8Array(24)))`.

- [ ] **Step 3: `npx convex codegen` / `convex dev` so `_generated` sees `api.cards`**

If the sandbox has no Convex login, still write the files; codegen happens on next `convex dev`.

---

### Task 3: Hosted form + HTTP

**Files:**
- Modify: `convex/http.ts` — OPTIONS+POST `/card`
- Create: `card.html`
- Modify: `package.json` `vercel-build` to also `cp card.html public/`
- Create: `convex/lib/cardCrypto.ts` only if encrypt must live in an action — prefer encrypting inside the httpAction with `encryptCard` from `cardPolicy.ts`

**Interfaces:**
- Consumes: `parseCardInput`, `encryptCard`, `cardPlain`, `internal.cards.consumeLink`
- Produces: `POST {convex.site}/card` JSON `{ ok: true, last4, brand } | { ok: false, error }`

HTTP handler (same CORS object as `/access`):

```ts
http.route({
  path: "/card",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const key = process.env.BRO_CARD_KEY;
    if (!key || key.length !== 64) {
      return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    let body: { token?: unknown; pan?: unknown; expMonth?: unknown; expYear?: unknown; cvc?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "bad json" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const parsed = parseCardInput({
      pan: String(body.pan ?? ""),
      expMonth: Number(body.expMonth),
      expYear: Number(body.expYear),
      cvc: String(body.cvc ?? ""),
    });
    if (!parsed.ok) {
      return new Response(JSON.stringify({ ok: false, error: parsed.error }), {
        status: 422,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const blob = await encryptCard(cardPlain(parsed.pan, parsed.cvc), key);
    try {
      const saved = await ctx.runMutation(internal.cards.consumeLink, {
        token: String(body.token ?? ""),
        last4: parsed.last4,
        brand: parsed.brand,
        expMonth: parsed.expMonth,
        expYear: parsed.expYear,
        blob,
      });
      return new Response(JSON.stringify({ ok: true, ...saved }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid or expired link" }), {
        status: 422,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }),
});
```

Never log `pan` / `cvc` / `blob`.

`card.html`: one form, Inter + same `--ink` as `index.html`. Fields: number, MM, YY, CVC. Read `t` from query. POST JSON to `window.BRO_CONVEX_SITE_URL + "/card"`. Success text: `МИР •••• 4412` (use returned brand map: mir→МИР, visa→Visa, mc→Mastercard). No card digits in the DOM after submit except last4.

- [ ] **Step 1: Wire `/card` OPTIONS+POST in `convex/http.ts`**
- [ ] **Step 2: Write `card.html`**
- [ ] **Step 3: `vercel-build` copies `card.html` into `public/`**

---

### Task 4: Eve — mint / forget / inject, never leak PAN

**Files:**
- Create: `agent/lib/card.ts`
- Modify: `agent/lib/convex.ts` — thin wrappers `mintCardLink`, `cardLast4`, `forgetCard`, `cardBlobForPay`
- Create: `agent/tools/card.ts` — one tool, actions `link` | `status` | `forget`
- Modify: `agent/tools/browser_task.ts` — decrypt + append fill instructions to Browser Use `task`; tool **return** stays last4-free
- Modify: `agent/instructions.md` — replace «never take card numbers»; add BYOC + 3DS rules
- Modify: `scripts/card-policy-check.ts` — extra asserts that a **sample** `browser_task` payload (hand-built object matching `payload()`) fails `modelPayloadHasPan`

**Interfaces:**
- Consumes: `api.cards.*`, `decryptCard`, `splitCardPlain`, `BRO_CARD_KEY`
- Produces:

```ts
// agent/lib/card.ts
export async function mintCardLink(phoneE164: string): Promise<{ url: string; expiresAt: number }>;
export async function cardStatus(phoneE164: string): Promise<{
  last4: string; brand: string; expMonth: number; expYear: number;
} | null>;
export async function forgetCard(phoneE164: string): Promise<void>;
export async function cardForBrowser(phoneE164: string): Promise<{
  pan: string; cvc: string; expMonth: number; expYear: number; last4: string; brand: string;
} | null>; // ONLY called from browser_task.ts
```

`card` tool (`agent/tools/card.ts`):

```ts
inputSchema: z.object({
  action: z.enum(["link", "status", "forget"]),
})
// link → { url }  (model sends the URL on its own iMessage line)
// status → { last4, brand } | { empty: true }
// forget → { forgotten: true }
```

`browser_task.ts` before `startRun`:

```ts
const pay = await cardForBrowser(phone);
const buTask = pay
  ? `${task}\n\nPAYMENT CARD (fill on checkout, do not speak these digits, do not solve 3DS):\nPAN=${pay.pan} EXP=${String(pay.expMonth).padStart(2, "0")}/${pay.expYear} CVC=${pay.cvc}\nIf a 3DS/Mir Accept form asks for an SMS code, wait; the human will send the code in iMessage and a later browser_task will type it.`
  : task;
const started = await startRun(buTask, ...);
const out = payload(done, { started: true, alreadyNotified: Boolean(conv), card: pay ? pay.last4 : null });
// assert !modelPayloadHasPan(out, pay.pan) in check; do not include pan/cvc in `out`
```

Instructions.md replace the first-paragraph card line with:

- You never ask for or repeat card numbers, CVC, or expiry in iMessage.
- If they need to pay and `card status` is empty, `card link` and send only the URL.
- After bind, checkout uses the saved card via `browser_task`. Tell them to confirm in the bank app (push) or to send the SMS code here (digits only).
- When they send a 3DS code, `browser_task` with «type this code into the 3DS field: NNNNNN» — still never echo PAN.
- «забудь карту» → `card forget`.

- [ ] **Step 1: Wrappers + `agent/lib/card.ts` + `card` tool**
- [ ] **Step 2: Inject in `browser_task` without leaking into `payload()`**
- [ ] **Step 3: Instructions**
- [ ] **Step 4: Extend `card-policy-check` with a fake payload object that would be illegal if it contained PAN; `npm run card:check` still ok**
- [ ] **Step 5: `npm run jobs:check` `npm run access:check` `npm run browser:check` still green**

Env to set on Convex + eve: `BRO_CARD_KEY` (64 hex), `BRO_PUBLIC_ORIGIN` (landing origin, e.g. production site that serves `card.html`).

---

## Spec coverage

| Spec | Task |
|---|---|
| One card / overwrite / forget | 2, 4 |
| Hosted form + one-time link 15 min | 1, 2, 3 |
| AES-GCM `cardBlob`, last4 in chat | 1, 2, 4 |
| Inject in `browser_task`, not model JSON | 4 |
| 3DS push poll / SMS code in iMessage | 4 instructions + browser_task prompt |
| No issuing, no bank-SMS scrape | Global + instructions |
| `card:check` + live Ozon | 1, 4 (live is human after deploy) |
| `vercel-build` copies page | 3 |

## Placeholder scan

None. Names locked: `cardBlob`, `mintLink`, `blobForPay`, `cardForBrowser`, `BRO_CARD_KEY`, `BRO_PUBLIC_ORIGIN`.
