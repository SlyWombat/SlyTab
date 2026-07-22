import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSplit, SplitError, type SplitMember, type SplitMethod } from '../src/split.js';

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
