import type { ReactNode } from 'react';
import { formatMinor } from '@slytab/core';

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
  return <span className={cls} style={{ fontSize: size }} aria-label={label}>{text}</span>;
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
