/**
 * Ledger design tokens — mirrors docs/design/DESIGN.md (the source of
 * truth) and apps/web/src/styles/tokens.css. Consumed by the mobile app.
 *
 * `text3` carries almost all secondary information — dates, payer names,
 * "you lent"/"you borrowed", section headings, form labels, input
 * placeholders — at 12pt or smaller, so it needs WCAG AA 4.5:1, not the 3:1
 * large-text allowance. Both values were measured against every surface they
 * sit on rather than chosen by eye (issue #94):
 *
 *   dark  #909dba — bg 6.87  surface 6.25  surface2 5.46  surface3 4.61
 *   light #5a6680 — bg 5.38  surface 5.76  surface2 5.09  surface3 4.68
 *
 * The previous dark value (#6b7794) was 3.80:1 on surface and 2.80:1 on
 * surface3; the light one (#8592ad) was worse still at 3.13:1 on white. If you
 * change either, re-measure against ALL FOUR surfaces — the first candidate we
 * tried passed three of them and failed surface3.
 */

export const color = {
  dark: {
    bg: '#0c1220', surface: '#141c2e', surface2: '#1c2740', surface3: '#253352',
    outline: '#2e3d5e',
    text: '#eef2fa', text2: '#a9b4cc', text3: '#909dba',
    brand: '#4f8ef7', brandStrong: '#79aaff',
    owed: '#34c98e', owe: '#f5a623', danger: '#ef5d6b', success: '#34c98e',
  },
  light: {
    bg: '#f6f7fb', surface: '#ffffff', surface2: '#eef1f7', surface3: '#e2e8f3',
    outline: '#d4dbe8',
    text: '#16203a', text2: '#4a5878', text3: '#5a6680',
    brand: '#2f6fe0', brandStrong: '#1d5ccb',
    // owed/owe measured 3.32:1 and 3.12:1 on the light surfaces — below AA on
    // the app's most important text. Darkened to 5.31 and 4.91 minimum across
    // all four (#92). The dark palette's pair already passes at 8:1.
    owed: '#0d6b49', owe: '#8a5806', danger: '#cf3545', success: '#0d6b49',
  },
  category: {
    food: '#f5a05e', home: '#6fc2ff', travel: '#b78cff',
    fun: '#ff8fb2', utilities: '#6ee0d2', other: '#a9b4cc',
  },
} as const;

export const font = {
  display: 'Space Grotesk',
  body: 'Inter',
  mono: 'JetBrains Mono',
} as const;

export const space = [0, 4, 8, 12, 16, 20, 24, 32, 48] as const;

export const radius = { sm: 8, md: 12, lg: 20, full: 9999 } as const;

export const motion = {
  tap: 120, sheet: 200, countUp: 320,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;
