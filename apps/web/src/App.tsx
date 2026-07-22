import { formatMinor } from '@slysplit/core';

/** Split-coin mark (assets/brand/slysplit-mark.svg, inlined). */
function Mark({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="SlySplit">
      <defs>
        <mask id="seam">
          <rect width="96" height="96" fill="#fff" />
          <path
            d="M48 8 A20 20 0 0 0 48 48 A20 20 0 0 1 48 88"
            fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round"
          />
        </mask>
      </defs>
      <g mask="url(#seam)">
        <path d="M48 8 A40 40 0 0 0 48 88 A20 20 0 0 0 48 48 A20 20 0 0 1 48 8 Z" fill="var(--ss-brand)" />
        <path d="M48 8 A40 40 0 0 1 48 88 A20 20 0 0 0 48 48 A20 20 0 0 1 48 8 Z" fill="var(--ss-owed)" />
      </g>
    </svg>
  );
}

/**
 * Placeholder Welcome screen (ui_requirements.md §2.1) proving the token
 * pipeline end to end: core formats the money, tokens.css styles it.
 */
export function App() {
  return (
    <main
      style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 'var(--ss-space-4)', padding: 'var(--ss-space-6)',
        textAlign: 'center',
      }}
    >
      <Mark />
      <h1 style={{ font: '600 34px/1.2 var(--ss-font-display)', letterSpacing: '-0.02em' }}>
        Sly<span style={{ color: 'var(--ss-text-2)' }}>Split</span>
      </h1>
      <p style={{ color: 'var(--ss-text-2)', maxWidth: '38ch' }}>
        Split expenses with the people you actually share life with.
      </p>
      <p className="amount amount--owed" style={{ fontSize: 22 }}>
        {'+' + formatMinor(14210, 'CAD')}
      </p>
      <p style={{ color: 'var(--ss-text-3)', fontSize: 13 }}>
        Scaffold build — screens land per docs/design/ui_requirements.md
      </p>
    </main>
  );
}
