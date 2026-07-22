import { describe, expect, it } from 'vitest';
import { computeNetBalances } from '../src/balance.js';
import { convertMinor } from '../src/currency.js';
import { formatMinor } from '../src/money.js';

describe('computeNetBalances', () => {
  it('payers gain, sharers owe, confirmed settlements offset', () => {
    const expenses = [
      {
        // dave pays 82.10, split 4 ways (2053/2053/2052/2052)
        payers: [{ userId: 'dave', amountMinor: 8210 }],
        shares: [
          { userId: 'dave', amountMinor: 2053 },
          { userId: 'alice', amountMinor: 2053 },
          { userId: 'marc', amountMinor: 2052 },
          { userId: 'priya', amountMinor: 2052 },
        ],
      },
    ];
    const settlements = [
      { fromUserId: 'alice', toUserId: 'dave', amountMinor: 2053, status: 'confirmed' as const },
      { fromUserId: 'marc', toUserId: 'dave', amountMinor: 2052, status: 'pending' as const },
    ];
    const net = computeNetBalances(expenses, settlements);
    expect(net['dave']).toBe(8210 - 2053 - 2053); // paid, own share, alice repaid
    expect(net['alice']).toBe(0); // settled up (confirmed)
    expect(net['marc']).toBe(-2052); // pending settlement does not count
    expect(net['priya']).toBe(-2052);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('convertMinor', () => {
  it('rounds half away from zero (PHP round() parity)', () => {
    expect(convertMinor(4210, 1.3729)).toBe(5780); // 5779.9…
    expect(convertMinor(1, 0.5)).toBe(1); // 0.5 -> 1
    expect(convertMinor(-1, 0.5)).toBe(-1); // -0.5 -> -1
  });
  it('rejects invalid rates', () => {
    expect(() => convertMinor(100, 0)).toThrow(RangeError);
    expect(() => convertMinor(100, Number.NaN)).toThrow(RangeError);
  });
});

describe('formatMinor', () => {
  it('formats CAD minor units', () => {
    expect(formatMinor(120460, 'CAD', 'en-CA')).toMatch(/1,204\.60/);
  });
  it('handles zero-decimal currencies', () => {
    expect(formatMinor(500, 'JPY', 'en-CA')).toMatch(/500/);
  });
});
