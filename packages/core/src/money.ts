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
