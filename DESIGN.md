# Design system — Top Builder OS

Shares the Top Builder AI brand (see TBAI marketing one-pagers): confident
light surface, deep navy ink, indigo→teal as the single brand gesture.

## Scene
Mike opens this on a phone in an Arizona driveway at 6am and his wife opens
it on a laptop at the kitchen table at 10pm. Bright ambient light, tired
eyes → **light theme**, high contrast, big touch targets (44px floor).

## Tokens (OKLCH)
- `--bg` oklch(0.985 0.004 260) — cool near-white (brand-hued, not cream)
- `--surface` white; `--panel` oklch(0.968 0.007 265) — sidebar/toolbar layer
- `--ink` oklch(0.24 0.035 275) — deep navy; `--muted` oklch(0.48 0.025 270)
- `--line` oklch(0.90 0.01 265)
- `--brand` (indigo) oklch(0.51 0.19 277) ≈ #5450d4 — primary actions,
  selection, focus; AA on white for large/bold, buttons use white text (7:1)
- `--go` (teal-green) oklch(0.56 0.13 165) ≈ #0e9f6e — money-positive,
  success, the "stat" color from the brand sheets
- `--warn` amber tint pair; `--danger` oklch(0.51 0.19 27)
- Gradient (indigo→teal) appears ONCE per screen max: the sidebar logo mark
  and primary CTA hover sheen. Never text-clipped.

## Type
Inter (variable, self-hosted fallback to system-ui). One family. Fixed rem
scale ×1.2: 12.8 / 13.5(body dense) / 15(body) / 18 / 21.6 / 26. Headings
600–700, `text-wrap: balance`. Tabular numerals on all money (`font-variant-
numeric: tabular-nums`).

## Shell
Left sidebar (240px, `--panel`), grouped nav: WORK (Intake, Customers, Jobs,
Dispatch, Field, Crew) · MONEY (Bank, Purchasing, Stock, Money HQ, Reports,
Accountant) · SYSTEM (Helpers, Team). Active item: indigo text + soft indigo
tint bar. Topbar: page title + tenant + user/logout. <900px: sidebar becomes
a slide-over behind a hamburger; content full-width. Nav items the signed-in
person lacks department access to are hidden (server still enforces).

## Components
Cards 12px radius, 1px `--line`, no shadows at rest (shadow only on overlay
layers). Tables: 13.5px, tabular-nums, row hover tint. Buttons: primary
indigo / secondary outline / quiet text — same shape everywhere, 10px radius.
Pills: tinted, never full-saturation. Focus: 2px indigo ring, always visible.
Motion: 150–200ms ease-out on state only; `prefers-reduced-motion` honored.
