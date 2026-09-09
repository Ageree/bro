# bro — landing redesign & design system

_Date: 2026-09-09. Supersedes `2026-08-26-bro-landing-design.md`._

## Why

The first landing was a stock meadow photo with a wordmark on top. Nothing on the
page came from the product, so it read as a wellness page and the brand was a font
choice.

## The reference

[doji.com](https://www.doji.com/) — minimal and elegant on white. Read off their
stylesheets rather than guessed at:

- `--color-font: #000` on white. No greys in the palette at all.
- `--container-width: 40rem`, `--padding: 2rem`, `--max-width-text: 60ch`. Narrow.
- The **only** `border-radius` in their CSS is `9999px`. Everything else is square.
- The home page is one **full-viewport video**, `object-fit: cover`, in two cuts:
  a 9:16 portrait and a 16:9 landscape, swapped on orientation so a phone gets a
  portrait frame instead of the cropped-out middle of a widescreen one.
- Chrome over the film is tiny: a masthead and one link. Nothing competes with the
  footage.

### The fonts were not copyable, for two reasons

doji sets `--font-headline: "Tid-Book"` and `--font-default: "DioramaGothic"`.
Inspecting the woff2 name tables: **Tid Book** is Letters from Sweden (Göran
Söderström & Stefania Malmsten) and **Diorama Gothic** is Diorama Type Partners.
Both are licensed commercial faces, so serving them from bro would be piracy.

The decisive problem is simpler than licensing: **both files contain zero Cyrillic
glyphs** (458 and 491 mapped codepoints, none in U+0400–U+04FF). They physically
cannot set Russian. The site would fall through to a system font on every word.

**Onest** stands in — free, contemporary, and with Cyrillic drawn as a first-class
part of the family rather than bolted on.

## The system

| Token | Value | Role |
| --- | --- | --- |
| `--paper` / `--ink` | `#ffffff` / `#000000` | the whole palette |
| `--ink-mute` / `--ink-faint` | `#6f6f6f` / `#b4b4b4` | secondary copy, hairlines |
| `--pad` | `clamp(1.1rem, 4vw, 2rem)` | the one spacing unit |
| `--container` / `--measure` | `40rem` / `60ch` | narrow by design |
| `--r-pill` | `9999px` | the only radius in the system |
| `--veil` | black at 34–42% | keeps white type legible over any frame |

Type stays small and quiet — the footage is the only loud element on the page.
Cards, boxes and shadows are gone: the price list is hairline rules, the login sheet
is a square white panel.

## The stage

`assets/hero-portrait.mp4` and `assets/hero-landscape.mp4`, both `muted loop
playsinline autoplay`, swapped by `@media (orientation: …)`. Until the footage
exists both fall back to `assets/hero-poster-placeholder.png` — a neutral grey field,
deliberately mid-tone so the white chrome still reads over it. **Replace it with a
real poster frame before launch.**

Planned footage: short scenarios of different people texting the assistant — a
parent, a working guy, a teenager — generated in Higgsfield.

## Page

1. **Stage** — full-viewport film. Masthead `bro.` centred, «Войти» at the right,
   one pill CTA at the bottom: **«Получить своего бро»**.
2. **Тариф** — the offer as a hairline list.
3. **Что вы оплачиваете и как** — kept verbatim.
4. **Footer** — legal details, unchanged.

doji's home does not scroll: it is `fixed inset-0` and nothing else. bro's cannot
copy that. The YooKassa offer text, the refund terms and the sole-trader details
have to stay reachable on the site, so the stage is `100svh` and the required
sections follow underneath.

Everything else in doji's chrome is dropped, as asked: no Manifesto, no Careers, no
Socials. Most traffic is expected on phones, and those tabs have no counterpart here.
«Войти» stays because the cabinet and vault are real product surfaces behind it.

## The character

Demoted to the app icon and favicon (`assets/bro-mark.svg`, `assets/bro-logo.png`).
The masthead is now the wordmark `bro.` set in type, with the full stop, so the hero
belongs entirely to the film. He is unchanged otherwise and still available if a
smaller mark is wanted in the chrome later.

## Contracts preserved

Every id `assets/auth.js` binds (`#login-open`, `#login-modal`, `#login-handle`,
`#login-send`, `#login-code`, `#login-verify`, `#login-status`, `#login-cancel`,
`#cabinet-open`, `#vault-open`, `#logout`) and the `POST /access` flow. Both CTAs
share one handler via `[data-request-access]` and show the same state.

## Verification

Rendered at 390×844 as a touch device and at 1280×800, with Onest loaded. Checked:
no horizontal scroll on either, no console or page errors beyond the two expected
404s for the absent video files, only `bro.` and «Войти» visible in the masthead,
both CTAs wired, and the orientation swap resolving to portrait on the phone and
landscape on the desktop. `npm run cabinet:check` passes its landing assertions.

## Out of scope

Cabinet/vault restyle (still inline-styled with the old meadow background, so
`assets/meadow.webp` stays), the real hero footage, analytics, i18n.
The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.
