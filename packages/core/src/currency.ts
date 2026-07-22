/**
 * Currency conversion — FR-5.x. The rate is locked on the expense row at
 * creation time (ECB daily reference for the expense date) and never
 * silently re-fetched; conversion is therefore a pure function.
 */

import { assertMinor } from './money.js';

/** Round-half-away-from-zero, matching PHP's round() for parity. */
export function convertMinor(amountMinor: number, rate: number): number {
  assertMinor(amountMinor);
  if (!(rate > 0) || !Number.isFinite(rate)) {
    throw new RangeError(`fx rate must be a positive finite number, got ${rate}`);
  }
  const raw = amountMinor * rate;
  return raw >= 0 ? Math.floor(raw + 0.5) : -Math.floor(-raw + 0.5);
}
