# bro — landing redesign & design system

_Date: 2026-09-08. Supersedes `2026-08-26-bro-landing-design.md`._

## Why

The first landing was a stock meadow photo with a wordmark on top. Nothing on the
page came from the product, so it read as a wellness page and the brand was a font
choice. The redesign gives bro a character and derives the whole system from it.

## The character — «Бабл»

bro has no app, no dashboard, no screen of his own. He exists as one thing: a bubble
in your chat. So the character *is* the message.

- **Form:** a soft cloud bubble with a blunt tail at the bottom left, two oval eyes and
  a small smile.
- **Personality:** warm and unbothered. He smiles, but he does not chatter — he says
  «сделаю» and gets on with it.
- **States, without redrawing:** eyes closed → asleep; eyes as dashes → thinking; tail
  flipped → your turn. One object, endless expression.
- **Scales:** the silhouette survives at 16 px (favicon) and as a hero at ~170 px.
  Verified by rendering at 240 / 90 / 42 / 20 px before the shape was frozen.

The character came from a Higgsfield generation the founder approved. It is **redrawn
as vector**, not traced: a traced diffusion output carries wobbly, unevenly weighted
edges that show up badly at hero size and turn to mush at favicon size. The body is
nine overlapping circles plus a tail path — few and large, so the outline is gently
scalloped rather than knobbly. An earlier pass used more, smaller lobes and read as
broccoli.

Source of truth is `assets/bro-mark.svg`. The page inlines the same shapes so CSS can
animate the eyes — document CSS does not reach into a `<use>` shadow tree. The body
inherits `currentColor` and the `.bro__face` group takes `--bro-eye`, so he inverts
cleanly on an ink surface by setting both.

## The system

The atom is the bubble. Character, logo, card, price plan and message are the same
shape at different sizes. Every surface carries the same tail corner
(`border-bottom-left-radius: var(--r-sm)`), so the whole page reads as things bro said.

**The page is a conversation** — that is the organising idea, not a decoration.

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#f2efe7` | warm ground; never pure white |
| `--paper-raised` | `#fbfaf6` | cards, the human's bubbles |
| `--ink` | `#15241b` | bro's voice — his bubbles, the primary button |
| `--ink-soft` | `#6b7c71` | secondary copy |
| `--signal` | `#d8913a` | one accent, reserved for "bro acted on his own" |
| `--r-sm/md/lg/pill` | `.75 / 1.25 / 1.75 rem / 999px` | one radius family — the brand signature |

- **Type:** Onest, not Inter. Inter reads as a system default; Onest has real Cyrillic
  design and the site is Russian.
- **Motion budget:** bro blinks, and the demo thread types itself once on scroll.
  Both respect `prefers-reduced-motion`.
- **Accent discipline:** `--signal` marks exactly one thing — the unprompted message.
  Spending it anywhere else costs its meaning.

Tokens and primitives live in `assets/brand.css` and are page-agnostic on purpose:
`cabinet.html` and `vault.html` still carry their own inline styles and the old meadow
background. Porting them onto `brand.css` is the next step, not part of this change.

## Page

1. **Hero** — character, wordmark, promise, CTA.
2. **Как это выглядит** — a real thread that types itself: a booking, a repeat order
   paid from the vault, and one message bro sends unprompted. Shows the product
   instead of describing it.
3. **Что он умеет** — six capability cards.
4. **Тарифы** — unchanged offer, restyled as an ink bubble.
5. **Что вы оплачиваете и как** — kept verbatim; YooKassa requires it.
6. **Напиши ему первым** — closing CTA. The page previously ended on legal prose.
7. **Footer** — legal details, unchanged.

## Contracts preserved

Every id `assets/auth.js` binds (`#login-open`, `#login-modal`, `#login-handle`,
`#login-send`, `#login-code`, `#login-verify`, `#login-status`, `#login-cancel`,
`#cabinet-open`, `#vault-open`, `#logout`) and the `POST /access` CTA flow.
Both CTAs now share one handler via `[data-request-access]` and show the same state.

`scripts/cabinet-check.ts` pinned the old `class="cta sheet-cta"` string; it now
asserts the `sheet-cta` class on `#login-send` instead of the whole skin.

## Assets

- `assets/bro-mark.svg` — the mark; favicon. Standalone, so its fills are literal.
- `assets/bro-logo.png` — 1024², apple-touch-icon.
- `assets/bro-og.png` — 1200×630 share card.
- `assets/meadow.webp` — kept: `cabinet.html` and `vault.html` still use it.

## Verification

Rendered at 1280×900 and 390×844 with Onest loaded. Checked: no horizontal scroll on
either viewport, no console or page errors, only «Войти» visible in the topbar when
logged out, both CTAs wired. `npm run cabinet:check` passes its landing assertions.

## Out of scope

Cabinet/vault restyle, an expression sheet for the character, analytics,
i18n. The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.
