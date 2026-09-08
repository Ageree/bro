# bro — landing redesign & design system

_Date: 2026-09-08. Supersedes `2026-08-26-bro-landing-design.md`._

## Why

The first landing was a stock meadow photo with a wordmark on top. Nothing on the
page came from the product, so it read as a wellness page and the brand was a font
choice. The redesign gives bro a character and a system with a point of view.

## The character — «Бабл»

bro has no app, no dashboard, no screen of his own. He exists as one thing: a bubble
in your chat. So the character *is* the message.

- **Form:** a soft cloud bubble with a blunt tail at the bottom left, two oval eyes and
  a small smile.
- **Personality:** warm and unbothered. He smiles, but he does not chatter — he says
  «сделаю» and gets on with it.
- **States, without redrawing:** eyes closed → asleep; eyes as dashes → thinking; tail
  flipped → your turn.
- **Scales:** verified at 240 / 90 / 42 / 20 px before the shape was frozen. The face
  survives to favicon size.

The character came from a Higgsfield generation the founder approved. It is **redrawn
as vector**, not traced: a traced diffusion output carries wobbly, unevenly weighted
edges that show at hero size and turn to mush at favicon size. The body is nine
overlapping circles plus a tail path — few and large, so the outline stays gently
scalloped. An earlier pass used more, smaller lobes and read as broccoli.

Source of truth is `assets/bro-mark.svg`. The page inlines the same shapes so CSS can
animate the eyes — document CSS does not reach into a `<use>` shadow tree. The body
inherits `currentColor` and the `.bro__face` group takes `--bro-eye`, so he inverts
cleanly on an ink surface by setting both.

## Where the system comes from

The founder asked to borrow the design system from
[folk.com/folkways](https://www.folk.com/folkways). What folk actually does, read off
their stylesheets rather than guessed at:

- warm putty paper (`#e8e3da`) and a warm, brown-biased near-black ink (`#0e0a07`) —
  no neutral greys anywhere in the palette;
- **thick ink outlines** as the signature: `--border: 3px solid var(--ink)`, `2px` for
  the lighter variant;
- **small radii** on paper — `--radius-card: 6px`, `--radius-soft: 14px` — against
  fully-round pills;
- a **letterpress** treatment: a lit top inset edge and a shaded bottom one, so a
  surface sits *in* the page instead of floating over it;
- a warm accent family (butter golds, rust `#d4561f`, sage `#95a684`), washi tape;
- `cubic-bezier(.32, .72, 0, 1)` for motion;
- Labil Grotesk and Cursor Gothic for type, with Caveat for handwritten notes.

**What was deliberately not borrowed, and why:**

1. **Labil Grotesk and Cursor Gothic are licensed commercial faces.** Pulling their
   woff2 files off folk's CDN and serving them from bro would be font piracy. The
   substitute is **Golos Text** (Paratype) — a warm neo-grotesk in the same register
   with stronger Cyrillic than the Onest this replaces, which matters on a Russian
   site. **Caveat** is free on Google Fonts and is used the same way folk uses it.
2. **The butter gold accent.** It is folk's most recognisable colour, and wearing a
   competitor's hero colour is how you end up looking like their side project. bro's
   accent is **rust `#d4561f`**, which is in folk's palette but not their signature.
3. **Washi tape.** Their most costume-y device; it would read as fancy dress on a
   product about getting errands done.

## The system

Surfaces follow the tactile-paper idiom: warm ground, ink outline, small radius,
letterpress highlight, so every block reads as printed stock.

**Chat bubbles are the deliberate exception.** They keep soft radii, because that is
what a message is — and the contrast against hard-edged paper is what makes them read
as real bubbles lying on the page rather than as more cards. This is the one place the
borrowed system was bent to fit the product.

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#e8e3da` | putty ground |
| `--paper-2` / `--paper-3` | `#f6f6f3` / `#fafaf7` | raised stock, inputs |
| `--ink` | `#0e0a07` | outlines, bro's bubbles, primary button |
| `--ink-soft` / `--ink-mute` | `#4a3b3d` / `#6e6260` | secondary copy |
| `--signal` | `#d4561f` | one job only: bro acted unprompted |
| `--border` / `--border-3` | `2px` / `3px solid var(--ink)` | the signature |
| `--r-card` / `--r-soft` / `--r-bubble` | `6px` / `14px` / `1.4rem` | paper is hard, speech is soft |
| `--press` | lit top inset, shaded bottom | letterpress |
| `--spring` | `cubic-bezier(.32,.72,0,1)` | all motion |

- **Type:** Golos Text 400–700, Caveat 600 for margin notes.
- **Motion budget:** he blinks, the demo thread types itself once on scroll, cards and
  buttons lift on the spring. All respect `prefers-reduced-motion`.
- **Accent discipline:** `--signal` marks exactly one thing — the unprompted message,
  ringed and annotated in a hand. Spending it elsewhere costs its meaning.

Tokens and primitives live in `assets/brand.css` and are page-agnostic on purpose:
`cabinet.html` and `vault.html` still carry their own inline styles and the old meadow
background. Porting them onto `brand.css` is the next step, not part of this change.

## Page

1. **Hero** — character, wordmark, promise, CTA.
2. **Как это выглядит** — a thread that types itself: a booking, a repeat order paid
   from the vault, and one message bro sends unprompted, annotated in Caveat.
3. **Что он умеет** — six capability cards.
4. **Тарифы** — unchanged offer, on an ink slab.
5. **Что вы оплачиваете и как** — kept verbatim; YooKassa requires it.
6. **Напиши ему первым** — closing CTA. The page previously ended on legal prose.
7. **Footer** — legal details, unchanged.

## Contracts preserved

Every id `assets/auth.js` binds (`#login-open`, `#login-modal`, `#login-handle`,
`#login-send`, `#login-code`, `#login-verify`, `#login-status`, `#login-cancel`,
`#cabinet-open`, `#vault-open`, `#logout`) and the `POST /access` CTA flow.
Both CTAs share one handler via `[data-request-access]` and show the same state.

`scripts/cabinet-check.ts` pinned the old `class="cta sheet-cta"` string; it now
asserts the `sheet-cta` class on `#login-send` instead of the whole skin.

## Assets

- `assets/bro-mark.svg` — the mark; favicon. Standalone, so its fills are literal.
- `assets/bro-logo.png` — 1024², apple-touch-icon.
- `assets/bro-og.png` — 1200×630 share card.
- `assets/meadow.webp` — kept: `cabinet.html` and `vault.html` still use it.

## Verification

Rendered at 1280×900 and 390×844 with the real fonts loaded. Checked: no horizontal
scroll on either viewport, no console or page errors, only «Войти» visible in the
topbar when logged out, both CTAs wired. `npm run cabinet:check` passes its landing
assertions.

## Out of scope

Cabinet/vault restyle, an expression sheet for the character, analytics, i18n.
The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.
