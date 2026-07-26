import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSplit, rescaleAmountFields, SplitError, splitInputsFromStored, splitInputsToStored, splitMembersFromInputs, type SplitMember, type SplitMethod } from '../src/split.js';
import { parseAmount, rescaleAmountString } from '../src/money.js';

interface Vector {
  name: string;
  method: SplitMethod;
  totalMinor: number;
  members: SplitMember[];
  expected: Record<string, number>;
}

const { cases } = JSON.parse(
  readFileSync(new URL('../test-vectors/split.json', import.meta.url), 'utf8'),
) as { cases: Vector[] };

describe('computeSplit — shared test vectors', () => {
  for (const v of cases) {
    it(v.name, () => {
      const result = computeSplit(v.method, v.totalMinor, v.members);
      expect(result).toEqual(v.expected);
      const sum = Object.values(result).reduce((a, b) => a + b, 0);
      expect(sum).toBe(v.totalMinor);
    });
  }
});

describe('computeSplit — invariants and errors', () => {
  it('always reconciles to the cent for awkward equal splits', () => {
    for (let total = 1; total <= 500; total++) {
      const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }];
      const r = computeSplit('equal', total, members);
      expect(Object.values(r).reduce((x, y) => x + y, 0)).toBe(total);
    }
  });

  it('rejects exact amounts that do not reconcile', () => {
    expect(() =>
      computeSplit('exact', 5000, [
        { id: 'u1', exactMinor: 2000 },
        { id: 'u2', exactMinor: 2999 },
      ]),
    ).toThrow(SplitError);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      computeSplit('percent', 1000, [
        { id: 'u1', percent: 50 },
        { id: 'u2', percent: 49.99 },
      ]),
    ).toThrow(SplitError);
  });

  it('rejects adjustments exceeding the total', () => {
    expect(() =>
      computeSplit('adjustment', 1000, [
        { id: 'u1', adjustMinor: 1500 },
        { id: 'u2' },
      ]),
    ).toThrow(SplitError);
  });

  it('rejects duplicate member ids', () => {
    expect(() => computeSplit('equal', 1000, [{ id: 'u1' }, { id: 'u1' }])).toThrow(SplitError);
  });

  it('rejects non-integer totals', () => {
    expect(() => computeSplit('equal', 10.5, [{ id: 'u1' }])).toThrow(RangeError);
  });
});

describe('split form-input bridging (issue #13)', () => {
  it('builds shares members from raw strings, blank meaning 0', () => {
    const members = splitMembersFromInputs('shares', ['a', 'b', 'c'], { a: '2', b: '1' }, 'CAD');
    expect(members).toEqual([
      { id: 'a', shares: 2 }, { id: 'b', shares: 1 }, { id: 'c', shares: 0 },
    ]);
    expect(computeSplit('shares', 3000, members)).toEqual({ a: 2000, b: 1000, c: 0 });
  });

  it('parses percents with decimals', () => {
    const members = splitMembersFromInputs('percent', ['a', 'b'], { a: '66.67', b: '33.33' }, 'CAD');
    expect(computeSplit('percent', 300, members)).toEqual({ a: 200, b: 100 });
  });

  it('parses signed adjustments at the currency scale, including zero-decimal', () => {
    expect(splitMembersFromInputs('adjustment', ['a'], { a: '-4.50' }, 'CAD'))
      .toEqual([{ id: 'a', adjustMinor: -450 }]);
    expect(splitMembersFromInputs('adjustment', ['a'], { a: '-4.500' }, 'CLP'))
      .toEqual([{ id: 'a', adjustMinor: -4500 }]);
  });

  it('rejects garbage input with a SplitError', () => {
    expect(() => splitMembersFromInputs('shares', ['a'], { a: 'two' }, 'CAD')).toThrow(SplitError);
    expect(() => splitMembersFromInputs('percent', ['a'], { a: '50%%' }, 'CAD')).toThrow(SplitError);
  });

  it('round-trips stored splitInput back into form strings', () => {
    for (const [method, raw] of [
      ['shares', { a: '2', b: '1' }],
      ['percent', { a: '66.67', b: '33.33' }],
      ['adjustment', { a: '-4.50', b: '10.00' }],
    ] as const) {
      const stored = splitInputsToStored(method, ['a', 'b', 'c'], raw, 'CAD');
      expect(stored).not.toBeNull();
      expect(splitInputsFromStored(method, stored!, 'CAD')).toEqual(raw);
    }
  });

  it('stores nothing for equal and exact — the shares list restores those', () => {
    expect(splitInputsToStored('equal', ['a'], {}, 'CAD')).toBeNull();
    expect(splitInputsToStored('exact', ['a'], { a: '5.00' }, 'CAD')).toBeNull();
  });
});

describe('rescaleAmountFields — a balanced split survives a scale change (#74)', () => {
  // The reported expense: ARS 45920.00 split exact three ways. Rescaling
  // each share on its own rounds all three up to 15307 = 45921, one peso
  // over the 45920 total, and the form refuses to save.
  const shares = { a: '15306.67', b: '15306.67', c: '15306.66' };

  it('keeps the shares summing to the rescaled total', () => {
    const out = rescaleAmountFields(shares, '45920.00', 'ARS', 'CLP');
    const sum = Object.values(out).reduce((a, v) => a + parseAmount(v, 'CLP'), 0);
    expect(sum).toBe(parseAmount(rescaleAmountString('45920.00', 'ARS', 'CLP'), 'CLP'));
    expect(out).toEqual({ a: '15307', b: '15307', c: '15306' });
  });

  it('rounds the other way too, and back again', () => {
    // 0-decimal → 2-decimal is exact, so nothing has to move.
    expect(rescaleAmountFields({ a: '15307', b: '15307', c: '15306' }, '45920', 'CLP', 'ARS'))
      .toEqual({ a: '15307.00', b: '15307.00', c: '15306.00' });
    // Down-scaling a split whose thirds each round down: 10.00 / 3.
    const out = rescaleAmountFields({ a: '3.34', b: '3.33', c: '3.33' }, '10.00', 'CAD', 'CLP');
    expect(Object.values(out).reduce((a, v) => a + parseAmount(v, 'CLP'), 0)).toBe(10);
  });

  it('leaves same-scale switches and blank fields alone', () => {
    expect(rescaleAmountFields(shares, '45920.00', 'ARS', 'CAD')).toEqual(shares);
    expect(rescaleAmountFields({ a: '10.00', b: '' }, '10.00', 'CAD', 'CLP'))
      .toEqual({ a: '10', b: '' });
  });

  it('does not even out a half-typed split — those numbers are the user\'s', () => {
    // Shares that don't reconcile yet fall back to per-field rescaling.
    expect(rescaleAmountFields({ a: '15306.67', b: '15306.67' }, '45920.00', 'ARS', 'CLP'))
      .toEqual({ a: '15307', b: '15307' });
    // …as does an empty or not-yet-entered total.
    expect(rescaleAmountFields({ a: '5.00' }, '', 'CAD', 'CLP')).toEqual({ a: '5' });
  });

  it('ignores fields that carry no amount', () => {
    const out = rescaleAmountFields({ a: '5.00', b: '5.00', c: '0' }, '10.00', 'CAD', 'CLP');
    expect(out).toEqual({ a: '5', b: '5', c: '0' });
  });
});
