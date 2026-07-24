/**
 * All money in SlyTab is integer minor units (cents) in a named currency.
 * Floats never carry money — they may only appear transiently inside
 * conversion, immediately rounded back to an integer.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF',
]);

export function minorUnitScale(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
}

export function assertMinor(amount: number, label = 'amount'): void {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`${label} must be an integer of minor units, got ${amount}`);
  }
}

/** "C$1,204.60" style formatting. Direction sign is the caller's job. */
export function formatMinor(
  amount: number,
  currency: string,
  locale = 'en-CA',
): string {
  assertMinor(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(amount / minorUnitScale(currency));
}

export function sumMinor(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) {
    assertMinor(a);
    total += a;
  }
  assertMinor(total, 'sum');
  return total;
}

/**
 * Convert minor units across currencies with a value rate, bridging
 * minor-unit scales (4240 CLP-minor ≈ 452 USD-minor, not 5).
 */
export function convertAcrossMinor(minor: number, rate: number, from: string, to: string): number {
  assertMinor(minor);
  const raw = (minor / minorUnitScale(from)) * rate * minorUnitScale(to);
  return raw >= 0 ? Math.floor(raw + 0.5) : -Math.floor(-raw + 0.5);
}

/**
 * Amount-field text → minor units, honouring the currency's scale.
 * Zero-decimal currencies write thousands with "." or "," (Chile:
 * "25.000" = twenty-five thousand pesos), so separators are grouping,
 * not decimals.
 */
export function parseAmount(input: string, currency: string): number {
  if (minorUnitScale(currency) === 1) {
    const digits = input.replace(/[^\d]/g, '');
    return digits === '' ? 0 : Math.min(Number.parseInt(digits, 10), Number.MAX_SAFE_INTEGER);
  }
  return Math.round((parseFloat(input) || 0) * 100);
}

/** Minor units → amount-field text ("4240" for CLP, "42.40" for CAD). */
export function minorToAmountString(minor: number, currency: string): string {
  const scale = minorUnitScale(currency);
  return scale === 1 ? String(minor) : (minor / scale).toFixed(2);
}

/**
 * Reinterpret an amount-field string when the currency picker moves
 * between currencies of different minor-unit scales, keeping the number
 * the user sees. Without this, "950000.00" (USD) re-read as CLP strips
 * the "." as a thousands separator and becomes 95,000,000 pesos.
 */
export function rescaleAmountString(input: string, from: string, to: string): string {
  if (input.trim() === '' || minorUnitScale(from) === minorUnitScale(to)) return input;
  return minorToAmountString(bridgeMinor(parseAmount(input, from), minorUnitScale(from), to), to);
}

/** Re-express minor units recorded at `fromScale` in `currency`'s scale. */
export function bridgeMinor(minor: number, fromScale: number, currency: string): number {
  const to = minorUnitScale(currency);
  if (fromScale === to) return minor;
  const raw = (minor / fromScale) * to;
  return raw >= 0 ? Math.floor(raw + 0.5) : -Math.floor(-raw + 0.5);
}

/** The amount fields of a server receipt parse (see ReceiptService). */
export interface ParsedReceiptAmounts {
  currency: string | null;
  /** Minor-unit scale the server applied; older parses omit it. */
  scale?: number | null;
  items: { name: string; quantity: number; totalMinor: number }[];
  subtotalMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
  totalMinor: number | null;
}

/**
 * The scale a parse's *Minor fields were written in. Parses that predate
 * the explicit `scale` field used the scale of their detected currency —
 * or 100 when no currency was detected (the server's 'XXX' fallback).
 */
export function parsedReceiptScale(p: Pick<ParsedReceiptAmounts, 'currency' | 'scale'>): number {
  return p.scale ?? minorUnitScale(p.currency ?? 'XXX');
}

/**
 * Pin a parse to a definite currency, re-expressing every *Minor field in
 * that currency's scale. Call this before doing arithmetic or display on
 * a parse: a receipt read without a currency is scaled at 100, which is
 * 100x off once the user says it was CLP.
 */
export function normalizeParsedReceipt<T extends ParsedReceiptAmounts>(parsed: T, currency: string): T {
  const from = parsedReceiptScale(parsed);
  const bridge = (m: number | null): number | null =>
    m === null ? null : bridgeMinor(m, from, currency);
  return {
    ...parsed,
    currency,
    scale: minorUnitScale(currency),
    items: parsed.items.map((i) => ({ ...i, totalMinor: bridgeMinor(i.totalMinor, from, currency) })),
    subtotalMinor: bridge(parsed.subtotalMinor),
    taxMinor: bridge(parsed.taxMinor),
    tipMinor: bridge(parsed.tipMinor),
    totalMinor: bridge(parsed.totalMinor),
  };
}
