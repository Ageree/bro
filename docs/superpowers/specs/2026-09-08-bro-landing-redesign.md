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

A flex column: the masthead and the call to action take their own height, the film
gets whatever is left. `assets/hero-portrait.mp4` is the real footage — 720×1280,
28.9 s, H.264, 996 KB, generated in Seedance.

**`object-fit: contain`, never `cover`.** This is the whole point: a 9:16 clip under
`cover` on a 16:9 desktop crops the head and the feet off. Under `contain` the figure
is shown whole at every viewport, and the letterboxing either side is invisible
because the footage is on the same white as the page. Measured at 390×844, 360×640,
1280×800 and 1440×900 against a marked test frame: the top and bottom edges of the
frame are inside the film box on all four, and neither edge crosses the masthead or
the call to action.

The clip carries a single track and no audio, so there is no sound toggle — doji has
one because their film has sound. A control with nothing to unmute is worse than none.

### One white, cut out of the footage

The clip was not shot on the page's white. Measured at full resolution across every
second: the background sits anywhere between **207 and 253** depending on the
character, and drifts within a single frame too. Against a fixed `#ffffff` page that
shows as a grey rectangle around the letterboxed frame — worst case 48 levels off.

**Tone correction does not work, and this was tried.** A curve that lifts the
background to white also lifts anything at the same brightness, and several
characters wear light clothing: at a knee of 190 the man in the white shirt
dissolved into the background entirely, and the pink top and grey vest washed out.
Background and shirt occupy the same tonal range, so no global operator can separate
them. (ffmpeg's `curves` is worth a warning of its own: it interpolates a spline
through the control points, so a "flat below 0.78" curve still lifted the whole
figure by 52 levels on average. `lutrgb` with an explicit expression is the tool for
a piecewise knee.)

**Making the page follow the film does not work either, even though it works.** A
1×1 canvas sampling the frame corner eight times a second and writing it to `--paper`
tracked the cuts correctly in a browser — 246 → 253 → 246 → 247 — but it makes the
whole page's colour a property of the video. The page flickers between shades as
characters change, and the brief is a white site.

So the background is removed from the footage instead of corrected. What a tone curve
cannot do by brightness, a segmentation model does by shape: `rembg`/u2net produces a
subject alpha per frame, and the frame is composited over pure `#ffffff`. This
separates the white shirt from the white wall because the model is deciding *person or
not*, not *bright or not*.

All 693 frames were processed at roughly 0.4–1.1 s each and re-encoded at CRF 27 with
`+faststart` (**4.05 MB → 707 KB**). Verified on the encoded output, sampling every
twelfth frame: the six-pixel border ring is exactly 255 on **58 of 58** frames, and
comparing each matted frame against its original, **99.7 %** of the subject pixels
survive (worst frame 98.9 %). By eye, on the frames tone correction destroyed — the
white shirt, the white sneakers, the fur hood, flyaway hair, lace tights — the figure
is intact.

`--paper` is therefore a constant `#ffffff` again, and the page carries no runtime
colour script at all.

**One thing worth fixing later:** the clip is portrait only, so on a wide desktop it is
height-limited and the figure ends up narrow — 335 px across a 1280 px viewport. doji
avoids this by shooting a separate 16:9 cut where the person is framed with more air.
A landscape cut would drop straight in; the markup would take a second `<video>` and a
`@media (orientation: …)` swap, which is how this file was built before the footage
existed.

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
Checked: no horizontal scroll on either, no console or page errors beyond the two
expected 404s for the absent video files, only `bro.` and «Войти» in the masthead,
both CTAs wired, and the orientation swap resolving to portrait on the phone and
landscape on the desktop. `npm run cabinet:check` passes its landing assertions.

## Out of scope

Cabinet/vault restyle — they still carry inline styles and the old meadow
background, so `assets/meadow.webp` stays. Also the real hero footage, analytics, i18n.
The `vercel.json` that `cabinet-check.ts` reads is missing on `main` and still is.

## Rebuilding the film

`scripts/hero-video/build.py` is the pipeline the section above describes, made
repeatable: `refs` cuts one still per character out of the film in production,
`generate` runs image-to-video on each still, `assemble` trims, mattes to white
and encodes, `verify` proves the border ring is 255. Only `generate` touches the
network.

Two things it fixes about the film in production. The nine shots run 1.8 s
instead of 3.21 s, so the faces change about twice as often and the whole strip
is 16.2 s rather than 28.9 s. And each character is given its own piece of
business — typing, laughing, taking a call, punching the air — because nine
people holding the same pose read as one photo shown nine times.

The reference stills come out of the film already shipped, which are matted to
`#ffffff` before a single request is made, so the model starts from the page's
own white. `assemble` mattes the result again anyway: what the model paints
behind the figure is its own business.

Generation runs on Higgsfield. Its API takes a key id and a secret from
https://cloud.higgsfield.ai as `Authorization: Key ${id}:${secret}`; a dashboard
or session token (`oat_…`) is not an API key and comes back
`401 Invalid credentials`. The catalogue there tops out at Seedance **v1**
(`/bytedance/seedance/v1/pro/fast/image-to-video`, 1080 × 9:16) — 2.5 is not
exposed. Veo 3.1, Kling 2.5 Turbo Pro and Sora 2 Pro sit behind the same
lifecycle if a different model is wanted; only the path and payload change.
