import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SimplifyError, simplifyDebts, type Transfer } from '../src/simplify.js';

interface Vector {
  name: string;
  net: Record<string, number>;
  expected: Transfer[];
}

const { cases } = JSON.parse(
  readFileSync(new URL('../test-vectors/simplify.json', import.meta.url), 'utf8'),
) as { cases: Vector[] };

describe('simplifyDebts — shared test vectors', () => {
  for (const v of cases) {
    it(v.name, () => {
      expect(simplifyDebts(v.net)).toEqual(v.expected);
    });
  }
});

describe('simplifyDebts — invariants and errors', () => {
  it('transfers exactly settle every balance', () => {
    const net = { a: 1234, b: -400, c: -834, d: 700, e: -700 };
    const after = { ...net };
    for (const t of simplifyDebts(net)) {
      after[t.from as keyof typeof after] += t.amountMinor;
      after[t.to as keyof typeof after] -= t.amountMinor;
    }
    for (const v of Object.values(after)) expect(v).toBe(0);
  });

  it('rejects balances that do not sum to zero', () => {
    expect(() => simplifyDebts({ a: 100, b: -50 })).toThrow(SimplifyError);
  });
});
