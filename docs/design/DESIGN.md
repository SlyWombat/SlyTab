# SlySplit — Design Language & Tokens

**Date:** 2026-07-22 · **Status:** Source of truth for `tokens.css` (web) and
`packages/core/src/tokens.ts` (mobile). Change tokens here first.

## 1. Design language: "Ledger"

SlySplit's visual language is called **Ledger** — a money app that feels like
a well-kept notebook, not a bank. It inherits the family DNA (CaseMaker's
"Industrial Parametric": dark navy surfaces, token-first, no CSS framework,
Space Grotesk / Inter / JetBrains Mono) and softens it for a consumer app
used at dinner tables and on road trips.

Principles:

1. **Numbers are the interface.** Amounts are the most important element on
   every screen — always tabular-lining figures in the mono font, always
   colour-coded by direction.
2. **Direction has exactly two colours.** Green = you are owed / incoming.
   Amber = you owe / outgoing. Never used for anything else; red is reserved
   for errors and destructive actions so money-direction and danger never
   blur.
3. **Dark by default, light supported.** Dark is the family default and the
   primary design target; a full light theme ships in v1.0 because this app
   is used outdoors in daylight. Both themes derive from the same token
   names.
4. **One-hand, one-glance.** Primary actions live in the bottom half of
   mobile screens; every screen answers its main question ("what do I owe?")
   without scrolling.

## 2. Brand & logo

The mark is the **split coin**: a circle divided into two interlocking halves
by an S-shaped seam — the S of **S**ly**S**plit. It encodes the product in
one shape: money, split fairly, between two parties. Left half
`--ss-brand` blue, right half `--ss-owed` green; the seam is negative space
(transparent in the mark, painted navy in the app icon).

Assets (source of truth, all SVG, in `assets/brand/`):

| File | Use |
|---|---|
| `slysplit-mark.svg` | Standalone mark, transparent seam — works on any background |
| `slysplit-icon.svg` | 1024×1024 app-icon master (navy ground, 224px corner radius). Export PNG sets for iOS/Android/favicon from this. |
| `slysplit-wordmark-dark.svg` | Mark + "SlySplit" set in Space Grotesk 600, for dark grounds |
| `slysplit-wordmark-light.svg` | Same, colour-adjusted for light grounds (AA-safe darkened hues) |

Usage rules:

- **Clearspace** = half the mark's diameter on all sides; nothing enters it.
- **Minimum sizes:** mark 20px, wordmark 120px wide. Below that, use the
  mark alone.
- The wordmark sets "Sly" in `--ss-text` and "Split" in `--ss-text-2` — the
  two-tone name echoes the two-tone coin. Never letterspace or re-colour it.
- The seam is part of the mark. Don't fill it, don't rotate the mark, don't
  swap the half colours (blue is always left/first), don't add effects.
- In-app: the mark appears in the Welcome screen hero and the web header;
  everywhere else the app speaks through the UI, not the logo.

## 3. Colour tokens

Namespace `--ss-*`. Values below are the dark theme; light overrides follow.

```css
:root {
  /* Surfaces (dark) */
  --ss-bg:            #0c1220;   /* app background — deep navy */
  --ss-surface:       #141c2e;   /* cards, sheets */
  --ss-surface-2:     #1c2740;   /* raised: inputs, list rows */
  --ss-surface-3:     #253352;   /* pressed / selected */
  --ss-outline:       #2e3d5e;   /* hairlines, dividers */

  /* Text */
  --ss-text:          #eef2fa;
  --ss-text-2:        #a9b4cc;   /* secondary */
  --ss-text-3:        #6b7794;   /* tertiary, placeholders */

  /* Brand & accents */
  --ss-brand:         #4f8ef7;   /* actions, links, focus */
  --ss-brand-strong:  #79aaff;
  --ss-owed:          #34c98e;   /* green: you are owed / incoming */
  --ss-owe:           #f5a623;   /* amber: you owe / outgoing */
  --ss-danger:        #ef5d6b;   /* errors, destructive */
  --ss-success:       #34c98e;   /* confirmations (same hue as owed) */

  /* Category chip hues (fixed assignments, both themes) */
  --ss-cat-food:      #f5a05e;  --ss-cat-home:     #6fc2ff;
  --ss-cat-travel:    #b78cff;  --ss-cat-fun:      #ff8fb2;
  --ss-cat-utilities: #6ee0d2;  --ss-cat-other:    #a9b4cc;
}

[data-theme="light"] {
  --ss-bg:        #f6f7fb;  --ss-surface:  #ffffff;
  --ss-surface-2: #eef1f7;  --ss-surface-3:#e2e8f3;
  --ss-outline:   #d4dbe8;
  --ss-text:      #16203a;  --ss-text-2:   #4a5878;  --ss-text-3: #8592ad;
  --ss-brand:     #2f6fe0;  --ss-brand-strong: #1d5ccb;
  --ss-owed:      #148f63;  --ss-owe:      #b57408;  --ss-danger: #cf3545;
  --ss-success:   #148f63;
}
```

Contrast requirement: all text/surface pairs ≥ 4.5:1 (WCAG AA); amount
colours (`--ss-owed`/`--ss-owe`) ≥ 4.5:1 against `--ss-surface` in both
themes (the light values above are darkened for this reason — verify with a
checker before changing).

## 4. Typography

```css
--ss-font-display: "Space Grotesk", system-ui, sans-serif; /* headings, big balances */
--ss-font-body:    "Inter", system-ui, sans-serif;          /* everything else */
--ss-font-mono:    "JetBrains Mono", ui-monospace, monospace; /* amounts, codes */
```

| Token | Size/line | Use |
|---|---|---|
| `--ss-type-hero`    | 34/40 display, 600 | Net balance on Home |
| `--ss-type-title`   | 24/30 display, 600 | Screen titles |
| `--ss-type-heading` | 18/24 display, 600 | Section headers, group names |
| `--ss-type-body`    | 15/22 body, 400    | Default |
| `--ss-type-caption` | 13/18 body, 400    | Metadata, timestamps |
| `--ss-type-amount`  | 15/22 mono, 500, `tabular-nums` | Inline amounts |
| `--ss-type-amount-lg` | 22/28 mono, 600 | Row-leading amounts |

Amounts always render with the mono font and `font-variant-numeric:
tabular-nums` so columns of money align. Negative direction is conveyed by
colour **and** an explicit sign/arrow (never colour alone — colour-blind
safe).

## 5. Spacing, radius, elevation

4px base scale: `--ss-space-1..8` = 4, 8, 12, 16, 20, 24, 32, 48.
Radii: `--ss-radius-sm: 8px` (chips, inputs), `--ss-radius-md: 12px`
(cards, rows), `--ss-radius-lg: 20px` (sheets, modals), `--ss-radius-full`
(avatars, FAB). Elevation on dark themes is expressed by surface step
(`surface` → `surface-2` → `surface-3`), not shadows; light theme may add a
soft `0 1px 3px rgb(22 32 58 / 0.10)`.

## 6. Core components

- **Amount** — the atomic money renderer: value, currency, direction colour,
  optional converted-value subscript (`US$ 42.10 · ≈ C$57.80`). The only
  component allowed to format money; it calls `packages/core/money.ts`.
- **BalancePill** — person/group + net amount; tap → detail. States: owed
  (green), owes (amber), settled (`--ss-text-3`, "settled up ✓").
- **PersonBadge** — initial(s) or emoji on a deterministic per-user colour;
  32px in rows, 48px in headers.
- **SplitBar** — horizontal proportion bar showing each member's share of an
  expense, using PersonBadge colours.
- **Sheet** — bottom sheet used for all create/edit flows on mobile; centred
  modal (max-width 480px) on web. All primary forms live in sheets.
- **FAB** — single floating "+" (add expense) on Home and Group screens,
  `--ss-brand`, bottom-right, above the tab bar.
- **Keypad** — custom amount pad (mobile) with currency toggle; system
  keyboard on web.
- **EmptyState** — icon + one sentence + one action button. Every list has
  a designed empty state (see UI requirements).

## 7. Motion & feedback

Durations: 120ms (taps/pressed), 200ms (sheets, page transitions), 320ms
(balance count-up on Home). Easing `cubic-bezier(0.2, 0, 0, 1)`. Settling a
debt to zero plays a brief scale+fade "✓" on the BalancePill. Respect
`prefers-reduced-motion` (and the OS setting on mobile): reduce to opacity
fades only. Haptics (mobile): light impact on save, success notification on
settlement confirmed — via `expo-haptics`, mindful of SlyLED's Android
VIBRATE-permission lesson.

## 8. Voice

Plain, warm, brief. "You owe Dave C$12.50", never "Outstanding payable:
$12.50". Errors say what to do next ("Couldn't read this receipt — add the
items manually?"). No exclamation marks in errors; at most one anywhere
else.
