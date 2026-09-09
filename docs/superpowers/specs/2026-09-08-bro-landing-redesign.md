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
| `--container` / `--measure` | `42rem` / `62ch` | narrow by design |

No radius token, because nothing on the page is rounded. The only remaining button
is inside the login sheet, and it is a square black rectangle.

## The stage

`assets/hero-portrait.mp4` and `assets/hero-landscape.mp4`, both `muted loop
playsinline autoplay`, swapped by `@media (orientation: …)` so a phone gets the 9:16
cut rather than the cropped-out middle of a 16:9 one.

**The footage does not exist yet**, so both fall back to a plain white poster and the
middle of the screen is empty. That is the honest state: doji's page minus the
person. Planned footage is short scenarios of different people texting the assistant
— a parent, a working guy, a teenager — generated in Higgsfield. **They must be shot
against a flat light ground**, or the white page falls apart around them.

A sound toggle sits bottom-right, as on doji, but stays hidden until a video actually
reaches `readyState >= 2`. A visible control with nothing to unmute is worse than no
control.

## No cartoon

The bubble character is gone from the brand. The favicon is now the letterform `b.`
cut as vector outlines straight from Prata (`assets/bro-mark.svg`), and the touch
icon and share card are the wordmark set in the same face. The identity is the
typography.

## Page

1. **Stage** — the film. `bro.` centred, «Войти» right, «Получить своего бро» large
   at the bottom.
2. **Тариф** — the offer as a plain list on hairline rules.
3. **Что вы оплачиваете и как** — kept verbatim.
4. **Footer** — legal details, unchanged.

doji's home does not scroll — it is `fixed inset-0` and nothing else. bro's cannot
copy that: the YooKassa offer text, refund terms and sole-trader details have to stay
reachable, so the stage is `100svh` and the required sections follow underneath.

Manifesto, Careers and Socials have no counterpart here and are dropped. «Войти»
stays because the cabinet and vault are real surfaces behind it.

## Contracts preserved

Every id `assets/auth.js` binds (`#login-open`, `#login-modal`, `#login-handle`,
`#login-send`, `#login-code`, `#login-verify`, `#login-status`, `#login-cancel`,
`#cabinet-open`, `#vault-open`, `#logout`) and the `POST /access` flow. Both CTAs
share one handler via `[data-request-access]` and show the same state.

## Verification

Rendered at 390×844 as a touch device and at 1280×800 with Prata and Onest loaded.
Checked: no horizontal scroll on either, no console or page errors beyond the two
expected 404s for the absent video files, only `bro.` and «Войти» in the masthead,
both CTAs wired, and the orientation swap resolving to portrait on the phone and
landscape on the desktop. `npm run cabinet:check` passes its landing assertions.

## Out of scope

Cabinet/vault restyle — they still carry inline styles and the old meadow
background, so `assets/meadow.webp` stays. Also the real hero footage, analytics, i18n.
The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.
