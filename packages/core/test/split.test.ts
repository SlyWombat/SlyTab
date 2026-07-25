import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSplit, SplitError, splitInputsFromStored, splitInputsToStored, splitMembersFromInputs, type SplitMember, type SplitMethod } from '../src/split.js';

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
