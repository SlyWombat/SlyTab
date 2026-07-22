/**
 * Ledger design tokens — mirrors docs/design/DESIGN.md (the source of
 * truth) and apps/web/src/styles/tokens.css. Consumed by the mobile app.
 */

export const color = {
  dark: {
    bg: '#0c1220', surface: '#141c2e', surface2: '#1c2740', surface3: '#253352',
    outline: '#2e3d5e',
    text: '#eef2fa', text2: '#a9b4cc', text3: '#6b7794',
    brand: '#4f8ef7', brandStrong: '#79aaff',
    owed: '#34c98e', owe: '#f5a623', danger: '#ef5d6b', success: '#34c98e',
  },
  light: {
    bg: '#f6f7fb', surface: '#ffffff', surface2: '#eef1f7', surface3: '#e2e8f3',
    outline: '#d4dbe8',
    text: '#16203a', text2: '#4a5878', text3: '#8592ad',
    brand: '#2f6fe0', brandStrong: '#1d5ccb',
    owed: '#148f63', owe: '#b57408', danger: '#cf3545', success: '#148f63',
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
