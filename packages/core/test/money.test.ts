import { describe, expect, it } from 'vitest';
import {
  bridgeMinor, minorUnitScale, normalizeParsedReceipt, parseAmount,
  parsedReceiptScale, rescaleAmountString, type ParsedReceiptAmounts,
} from '../src/money.js';

describe('rescaleAmountString — currency picker moves across scales', () => {
  it('USD → CLP keeps the number (the Boragó 100x bug)', () => {
    expect(rescaleAmountString('950000.00', 'USD', 'CLP')).toBe('950000');
    expect(parseAmount(rescaleAmountString('950000.00', 'USD', 'CLP'), 'CLP')).toBe(950_000);
  });

  it('CLP → USD keeps the number and gains decimals', () => {
    expect(rescaleAmountString('4240', 'CLP', 'USD')).toBe('4240.00');
  });

  it('same-scale switches leave the text untouched', () => {
    expect(rescaleAmountString('12.5', 'USD', 'CAD')).toBe('12.5');
    expect(rescaleAmountString('4240', 'CLP', 'JPY')).toBe('4240');
  });

  it('empty input stays empty', () => {
    expect(rescaleAmountString('', 'USD', 'CLP')).toBe('');
    expect(rescaleAmountString('  ', 'USD', 'CLP')).toBe('  ');
  });
});

describe('bridgeMinor', () => {
  it('re-expresses scale-100 minors as zero-decimal minors', () => {
    expect(bridgeMinor(95_000_000, 100, 'CLP')).toBe(950_000);
    expect(bridgeMinor(950_000, 1, 'USD')).toBe(95_000_000);
    expect(bridgeMinor(1234, 100, 'CAD')).toBe(1234);
  });

  it('rounds half away from zero', () => {
    expect(bridgeMinor(50, 100, 'CLP')).toBe(1);
    expect(bridgeMinor(-50, 100, 'CLP')).toBe(-1);
  });
});

describe('parsedReceiptScale', () => {
  it('prefers the explicit scale field', () => {
    expect(parsedReceiptScale({ currency: 'CLP', scale: 100 })).toBe(100);
    expect(parsedReceiptScale({ currency: null, scale: 1 })).toBe(1);
  });

  it('infers the server fallback for legacy parses', () => {
    expect(parsedReceiptScale({ currency: null })).toBe(100);   // 'XXX' path
    expect(parsedReceiptScale({ currency: 'CLP' })).toBe(1);
    expect(parsedReceiptScale({ currency: 'USD' })).toBe(100);
  });
});

describe('normalizeParsedReceipt — the Boragó receipt', () => {
  // Verbatim shape of the bad prod parse: currency unknown → scaled at 100.
  const borago: ParsedReceiptAmounts = {
    currency: null,
    items: [
      { name: 'Endémica', quantity: 3, totalMinor: 59_700_000 },
      { name: 'Maridaje Endémica', quantity: 3, totalMinor: 29_700_000 },
      { name: 'Pisco Op', quantity: 2, totalMinor: 2_600_000 },
      { name: 'Pisco Op - Desierto De Atacama', quantity: 1, totalMinor: 3_000_000 },
    ],
    subtotalMinor: 95_000_000,
    taxMinor: null,
    tipMinor: 9_500_000,
    totalMinor: 95_000_000,
  };

  it('pins an unknown-currency parse to CLP at the right magnitude', () => {
    const n = normalizeParsedReceipt(borago, 'CLP');
    expect(n.currency).toBe('CLP');
    expect(n.scale).toBe(1);
    expect(n.totalMinor).toBe(950_000);
    expect(n.subtotalMinor).toBe(950_000);
    expect(n.tipMinor).toBe(95_000);
    expect(n.items.map((i) => i.totalMinor)).toEqual([597_000, 297_000, 26_000, 30_000]);
    expect(n.items.reduce((a, i) => a + i.totalMinor, 0)).toBe(n.subtotalMinor);
  });

  it('is a no-op when the parse already matches the currency scale', () => {
    const clp = { ...borago, currency: 'CLP', scale: 1, totalMinor: 950_000 };
    expect(normalizeParsedReceipt(clp, 'CLP').totalMinor).toBe(950_000);
  });

  it('respects an explicit scale over the inferred one', () => {
    // A legacy CLP parse (scale implied 1) must NOT be shrunk again.
    const legacy = { ...borago, currency: 'CLP', totalMinor: 950_000 };
    delete (legacy as { scale?: number | null }).scale;
    expect(normalizeParsedReceipt(legacy, 'CLP').totalMinor).toBe(950_000);
  });

  it('preserves null fields', () => {
    expect(normalizeParsedReceipt(borago, 'CLP').taxMinor).toBeNull();
  });
});
