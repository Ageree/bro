# bro — cabinet & vault redesign

_Date: 2026-09-10. Extends `2026-09-08-bro-landing-redesign.md` to the pages
behind the login, which that spec listed as out of scope._

## Why

The landing became white paper with a black serif on it. The cabinet did not:
it was still the stock meadow photograph under a white scrim, Inter, dark-green
ink (`#17271e`), rounded translucent cards, pill buttons. A person who pressed
«Войти» left one product and arrived in another. The vault behind it was the
same page in the same old skin, and `oferta.html` — the one link in the landing
masthead — was the last page in green Inter.

## What changed

`assets/brand.css` grew a second half. The landing part is untouched; what is
new is the vocabulary a document page needs, and it is the same system:

| Piece | Rule |
| --- | --- |
| `.bar` | the masthead, now shared — `.stage__bar` is only `flex: 0 0 auto` on top of it |
| `.doc` | one 42 rem column, centred, the masthead spanning the viewport above it |
| `.sec` | a section: a hairline, a serif `h2`, the current state small and grey on the same line |
| `.acts` / `.act` | actions are text, like «Получить своего бро» — no pill, no fill |
| `.rows` | memories, vault items and payments are all the same hairline-divided list |
| `.meter` | a quota is a 2 px rule partly inked in, square ends |
| `.field` | square, 1 px black, no radius, capped at 22 rem |
| `.modal` / `.sheet` | moved here out of `index.html`, so all three pages share one login sheet |

One token was added: `--rule: #e6e6e6`. A long page needs a divider, `--ink`
at 1 px is a fence across every section, and `--ink-mute` is committed to fine
print. It is the only new value in the palette.

`assets/meadow.webp` is deleted — nothing loads it now.

## Two decisions worth writing down

**The handle is not set in the serif.** Everything else on these pages follows
the landing into Prata, but `bro-a1b2c3d4` at 2.8 rem in a didone reads
`bro-alb2c3d4`: the figure one is a bare stem, and so is the letter l. This is
the one string a person has to read character by character and type back into
the login box on a desktop. It is set in Onest at 500 instead — `.handle-xl`
for machine strings, `.doc-title` (Prata) for the vault's «Сейф» and the
oferta's heading. Words get the serif, identifiers get the gothic.

**Errors are black, not red.** The palette is white, black and one grey; the
captions and statuses around an error are already `--ink-mute`, so full ink
reads as the loud one without importing a colour the system does not have.

## Cabinet

Ten sections in one column, in the order a person asks about them: the handle
and what it costs, «Сейчас», «Компьютер», «ChatGPT», «Лимиты», «Память»,
«Входы в сайты», «Сейф», «Часовой пояс», «Оплаты». The two things a person
comes to do — «Написать Bro» and «Оплатить месяц» — are large serif text under
the handle, the same device as the landing's call to action.

Two small copy fixes fell out of the layout. The masthead no longer links
«Кабинет» from the cabinet itself (the section-expiry path null-guards that id
now), and «Часовой пояс» no longer prints the current zone twice — the select
already shows it.

Nothing about the data changed: every id `assets/auth.js` binds, every route
(`/me`, `/me/pay`, `/me/tz`, `/me/computer`, `/me/chatgpt/*`,
`/me/memories/forget`, `/vault/items`, `/access`) and every guard
(`safeHttpUrl`, the `bro-[a-z0-9]{8}` handle test, the wipe confirmation, no
`boxId` or `userCode` rendered from the snapshot) is carried over untouched.

## Vault

Same treatment; the form is the page, so it keeps a two-line local stylesheet
for field rhythm and the flash strip. `assets/vault.js` painted its rows with
the old `ghost` pill and `muted` class — those are now `.act`/`.t-mute`, three
strings changed, no logic.

## Oferta

Presentation only: the inline green stylesheet is replaced by `brand.css` plus
a prose block for the running measure. **Not a word of the legal text was
touched.** It still names the ИП, the ИНН, the ОГРНИП, the refund terms, the
YooKassa flow and the 152-ФЗ clause.

One thing to fix separately, because it is content and not design: §2.2 links
tariffs at `brobro.tech/#pricing`, and the pricing table was removed from the
landing in #57, so that anchor now resolves to the top of the page. The price
itself is stated in the same sentence, so nothing is misleading, but the link
is dead and only the founder should re-word an offer.

## Checks

`scripts/cabinet-check.ts` keeps every existing assertion — the ids, the
routes, the copy, the timezone list, the snapshot leaks — and gains a few for
the system: both pages link `brand.css`, the cabinet carries no local
stylesheet at all, neither page mentions the meadow or a `card`, `vault.js` no
longer paints a `ghost`, and the hairline token exists.

Two stale assertions were repaired rather than added to. `#57` rewired the
landing's CTA to `querySelectorAll("[data-request-access]")` but left the check
asserting the id-only selector it replaced, and the login sheet's
`white-space: nowrap` is now in `brand.css` rather than inline in `index.html`.
Both were failing before this change; the check now runs to the end.

It still cannot run to the end on a clean checkout: line ~497 reads
`vercel.json`, which is absent on `main` and still is. Verified by dropping a
one-line `vercel.json` in locally — `cabinet-check ok`, `profile-sync-check ok`
— and removing it again. `vault:check` and `types:check` cannot run in this
container at all: `node_modules` is empty, so `zod` and the node types are
missing. Neither touches these files.

## Verification

Rendered in Chromium with Prata and Onest actually loaded (the fonts were
served from a local mirror, since the sandbox blocks `fonts.gstatic.com` from
the browser but not from curl), against a stubbed `/me` and `/vault/items`:

- cabinet, vault and oferta at 1280×800, 390×844 and 360×640
- no horizontal scroll on any of them, no console or page errors on any of them
- the login sheet on both the landing and the cabinet, logged out, rendering
  the same as it did inline
- the masthead painting correctly in both states: «Сейф»/«Выйти» signed in,
  «Войти» alone signed out

## Out of scope

The landing's markup and its footage. Analytics, i18n. The landscape cut of the
hero clip that `2026-09-08` asks for. The dead `#pricing` anchor in the oferta.
