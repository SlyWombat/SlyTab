import { useState, type ReactNode } from 'react';
import { CURRENCIES, CURRENCY_NAMES, formatMinor, type Currency } from '@slytab/core';

const BADGE_HUES = ['#79aaff', '#6ee0d2', '#f5a05e', '#ff8fb2', '#b78cff', '#6fc2ff'];

export function badgeColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BADGE_HUES[h % BADGE_HUES.length]!;
}

export function Badge({ id, name, sm = false }: { id: string; name: string; sm?: boolean }) {
  return (
    <span className={`badge${sm ? ' sm' : ''}`} style={{ background: badgeColor(id) }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The only money renderer (DESIGN.md §6). Direction = colour AND sign. */
export function Amount({
  minor, currency, signed = false, size = 14,
}: { minor: number; currency: string; signed?: boolean; size?: number }) {
  const cls = !signed ? 'amount' : minor >= 0 ? 'amount amount--owed' : 'amount amount--owe';
  const text = signed
    ? `${minor >= 0 ? '+' : '−'}${formatMinor(Math.abs(minor), currency)}`
    : formatMinor(minor, currency);
  const label = signed ? (minor >= 0 ? `you are owed ${text}` : `you owe ${text}`) : text;
  return <span className={cls} style={{ fontSize: `${size / 16}rem` }} aria-label={label}>{text}</span>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="sheet-back" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}

export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="SlyTab">
      <defs>
        <mask id="seam-ui">
          <rect width="96" height="96" fill="#fff" />
          <path d="M48 8 A20 20 0 0 0 48 48 A20 20 0 0 1 48 88" fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round" />
        </mask>
      </defs>
      <g mask="url(#seam-ui)">
        <path d="M48 8 A40 40 0 0 0 48 88 A20 20 0 0 0 48 48 A20 20 0 0 1 48 8 Z" fill="var(--ss-brand)" />
        <path d="M48 8 A40 40 0 0 1 48 88 A20 20 0 0 0 48 48 A20 20 0 0 1 48 8 Z" fill="var(--ss-owed)" />
      </g>
    </svg>
  );
}

/**
 * Searchable currency multi-select with full names — a wall of 3-letter
 * chips was unusable (user feedback). `exclude` hides the group's home
 * currency, which is always available anyway.
 */
export function CurrencyMultiPicker({ selected, onChange, exclude }: {
  selected: string[];
  onChange: (next: string[]) => void;
  exclude?: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const options = CURRENCIES
    .filter((c) => c !== exclude)
    .filter((c) => q === ''
      || c.toLowerCase().includes(q)
      || CURRENCY_NAMES[c].toLowerCase().includes(q));

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 8 }}>
          {selected.map((c) => (
            <button type="button" key={c} className="btn sm"
              style={{ background: 'var(--ss-brand)', color: '#fff' }}
              title={`Remove ${CURRENCY_NAMES[c as Currency] ?? c}`}
              onClick={() => onChange(selected.filter((x) => x !== c))}>
              {c} ✕
            </button>
          ))}
        </div>
      )}
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search — e.g. peso, CLP, dollar…"
        style={{ width: '100%', background: 'var(--ss-surface-2)', color: 'var(--ss-text)',
          border: '1px solid var(--ss-outline)', borderRadius: 10, padding: '9px 12px',
          font: '400 0.875rem var(--ss-font-body)', marginBottom: 6 }} />
      <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--ss-outline)',
        borderRadius: 10 }}>
        {options.map((c) => {
          const on = selected.includes(c);
          return (
            <button type="button" key={c}
              onClick={() => onChange(on ? selected.filter((x) => x !== c) : [...selected, c])}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                background: on ? 'var(--ss-surface-2)' : 'none', border: 'none',
                padding: '9px 12px', color: 'var(--ss-text)', textAlign: 'left',
                font: '400 0.84375rem var(--ss-font-body)', cursor: 'pointer' }}>
              <span style={{ width: 16, color: 'var(--ss-brand)' }}>{on ? '✓' : ''}</span>
              <b style={{ width: 42, fontFamily: 'var(--ss-font-mono)' }}>{c}</b>
              <span style={{ color: 'var(--ss-text-2)' }}>{CURRENCY_NAMES[c]}</span>
            </button>
          );
        })}
        {options.length === 0 && (
          <div style={{ padding: 12, color: 'var(--ss-text-3)', fontSize: '0.8125rem' }}>No matches.</div>
        )}
      </div>
    </div>
  );
}
