# bro — landing page design

_Date: 2026-08-26_

## Product
**bro** — a personal AI agent (in the spirit of Poke / Folk / Tomo). Has its own phone
number, its own email, soon a virtual card, and memory. Does routine tasks for you:
booking doctor appointments, restaurant reservations, searching the web — an ideal
personal assistant.

## Goal
A minimalist single-screen landing (reference: tomo.ai) with a full-bleed meadow-and-clouds
background. Pre-launch / awareness page.

## Decisions
- **Language:** Russian.
- **Scope:** one screen, maximum minimalism — no scroll sections, no navigation.
- **Primary CTA:** «Запросить доступ» → placeholder `#` (no backend for now).
- **Background:** meadow + soft clouds, generated via Higgsfield. Bright, airy, daytime,
  dreamy pastel light, no people, no text. Horizon in lower third so it crops well on
  mobile portrait. Landscape, high resolution.
- **Tech:** a single static `index.html` with inline CSS + one background image asset.
  Zero framework, zero build, zero dependencies. Deployable by dropping the folder onto
  Vercel/Netlify/GitHub Pages.
- **Typography:** clean grotesk (Inter/Geist via Google Fonts), large thin heading, generous
  whitespace.
- **Legibility/a11y:** a subtle translucent scrim behind the hero text guarantees contrast
  over any part of the generated image.

## Layout (single screen)
Full-viewport background image (`object-fit: cover`). Centered hero:
- Wordmark: `bro`
- H1: «Твой личный ИИ-агент»
- Subline: «Свой номер, своя почта, своя память. Записи к врачу, брони, поиск — берёт
  рутину на себя.»
- Pill button: «Запросить доступ» → `#`

Copy is provisional and may be tuned during the build.

## Files
- `index.html` — the whole page (markup + inline `<style>`).
- `assets/meadow.<webp|jpg>` — the Higgsfield-generated background.

## Verification
Render in a browser (desktop + mobile viewport), screenshot, confirm the hero text is
legible over the image and the layout holds.

## Out of scope (YAGNI)
Backend, waitlist storage, multi-page/scroll sections, i18n toggle, analytics, cookie
banner. Add only when explicitly requested.
