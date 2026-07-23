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
