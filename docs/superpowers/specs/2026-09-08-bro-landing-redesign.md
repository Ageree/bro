# bro — landing redesign & design system

_Date: 2026-09-09. Supersedes `2026-08-26-bro-landing-design.md`._

## Why

The first landing was a stock meadow photo with a wordmark on top. Nothing on the
page came from the product, so it read as a wellness page and the brand was a font
choice.

## The reference

[doji.com](https://www.doji.com/). Two earlier passes got it wrong by reading their
markup instead of looking at the page:

1. I read "full-viewport video, `object-cover`" and built a **dark cinematic hero**
   with white chrome over a veil. Their hero is a person on a light ground.
2. I then fixed the tone but kept a **grotesk** and a pill button. Their whole page
   is set in a **serif**, and their call to action is not a button at all — it is
   large serif text sitting at the bottom of the screen.

What the page actually is: **white, black serif, one person standing in the middle,
one line of text to press.** Chrome is text and nothing else — no pills, no boxes,
no borders, no rounded corners anywhere.

### Their type could not be used, and the reason is not only licensing

doji sets `--font-headline: "Tid-Book"` and `--font-default: "DioramaGothic"`. From
the woff2 name tables: **Tid Book** is Letters from Sweden (Göran Söderström &
Stefania Malmsten), **Diorama Gothic** is Diorama Type Partners. Both are licensed
commercial faces, so serving them from bro would be piracy.

The decisive problem is simpler: **both files contain zero Cyrillic glyphs** — 458
and 491 mapped codepoints, none in U+0400–U+04FF. They cannot set «Получить своего
бро» at all; every Russian word would fall through to a system font.

**Prata** (Cyreal) stands in for the display face. It is free, it is the same
high-contrast didone register as Tid Book, and its Cyrillic is native to the design
rather than bolted on — which matters when the whole page is Russian. Like doji's
use of Tid Book, it is used at a single weight (400). **Onest** carries the fine
print, mirroring doji's serif-headline / gothic-default pairing.

If a Tid Book web licence is ever bought, swapping it in is one `@font-face` and one
token — but the Cyrillic problem would remain, so it would need a Cyrillic cut.

## The system

| Token | Value | Role |
| --- | --- | --- |
| `--paper` / `--ink` | `#ffffff` / `#000000` | the whole palette |
| `--ink-mute` | `#757575` | fine print only |
| `--font-display` | Prata | wordmark, nav, CTA, headings |
| `--font-text` | Onest | fine print and legal prose |
| `--pad` | `clamp(1.15rem, 4vw, 2rem)` | the one spacing unit |

No radius token, because nothing on the page is rounded. No container or measure
tokens either, now that the page has no prose to set. The only remaining button is
inside the login sheet, and it is a square black rectangle.

## The stage

`assets/hero-portrait.mp4` and `assets/hero-landscape.mp4`, both `muted loop
playsinline autoplay`, swapped by `@media (orientation: …)` so a phone gets the 9:16
cut rather than the cropped-out middle of a 16:9 one.

The film is in `assets/hero-portrait.mp4` (720×1280) and `assets/hero-landscape.mp4`
(1280×720). Six people stand in the same spot on a light-grey cyclorama, each
chatting with bro on a phone, then the next person replaces them — same mechanic
as doji.com. Cast and photography notes:
`docs/superpowers/specs/2026-09-09-hero-cast.md`. Posters:
`assets/hero-poster-portrait.png`, `assets/hero-poster-landscape.png`.
**They are shot against a flat light ground**, or the white page falls apart
around them.

A sound toggle sits bottom-right, as on doji, but stays hidden until a video actually
reaches `readyState >= 2`. A visible control with nothing to unmute is worse than no
control.

## No cartoon

The bubble character is gone from the brand. The favicon is now the letterform `b.`
cut as vector outlines straight from Prata (`assets/bro-mark.svg`), and the touch
icon and share card are the wordmark set in the same face. The identity is the
typography.

## Page

One screen. Nothing scrolls, the way doji's home does not scroll.

- **Masthead** — «Оферта» left, `bro.` centred, «Войти» right. The same three slots
  doji gives to Manifesto / Doji / Careers.
- **The film** fills the screen.
- **«Получить своего бро»** large at the bottom, alone — no strapline under it.
- **Sound toggle** bottom right, hidden until footage loads.

The pricing table, the payment prose and the footer with the sole-trader details were
all removed at the founder's request. **The legal content itself is not lost:**
`oferta.html` already carries the ИП name, ИНН, ОГРНИП, the contact address, the
refund terms, the YooKassa payment flow and the 152-ФЗ personal-data clause. It stays
published and is now reached from the masthead link instead of a footer.

That link is the reason the page keeps one non-design element. A payment provider
needs the offer reachable from the site; a single word in the corner satisfies that
without a wall of text under the film. If it goes too, nothing on the site states the
terms a customer is paying under.

## Contracts preserved

Every id `assets/auth.js` binds (`#login-open`, `#login-modal`, `#login-handle`,
`#login-send`, `#login-code`, `#login-verify`, `#login-status`, `#login-cancel`,
`#cabinet-open`, `#vault-open`, `#logout`) and the `POST /access` flow. Both CTAs
share one handler via `[data-request-access]` and show the same state.

## Verification

Rendered at 390×844 as a touch device and at 1280×800 with Prata and Onest loaded.
Checked: no horizontal scroll on either, no console or page errors, only `bro.`
and «Войти» in the masthead, both CTAs wired, and the orientation swap resolving
to portrait on the phone and landscape on the desktop. Hero films now sit on
those paths. `npm run cabinet:check` passes its landing assertions.

## Out of scope

Cabinet/vault restyle — they still carry inline styles and the old meadow
background, so `assets/meadow.webp` stays. Also analytics and i18n.
The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.
