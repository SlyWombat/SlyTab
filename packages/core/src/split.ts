/**
 * Split math — FR-3.2. Deterministic to the cent.
 *
 * Remainder cents distribute by largest remainder, ties broken by member id
 * ascending. This algorithm has a PHP twin in api/src/Domain/Split.php; both
 * must pass packages/core/test-vectors/split.json. Change them together.
 */

import { assertMinor } from './money.js';

export type SplitMethod = 'equal' | 'exact' | 'shares' | 'percent' | 'adjustment';

export interface SplitMember {
  id: string;
  /** exact: this member's amount in minor units */
  exactMinor?: number;
  /** shares: integer share count (2:1:1 …) */
  shares?: number;
  /** percent: 0–100, up to 4 decimal places */
  percent?: number;
  /** adjustment: fixed offset in minor units applied after an equal split */
  adjustMinor?: number;
}

export class SplitError extends Error {}

/**
 * Integer largest-remainder apportionment of `totalMinor` over integer
 * weights. Exact — no floating point.
 */
function apportion(
  totalMinor: number,
  entries: readonly { id: string; weight: number }[],
): Record<string, number> {
  const totalWeight = entries.reduce((a, e) => a + e.weight, 0);
  if (totalWeight <= 0) throw new SplitError('total weight must be positive');

  const rows = entries.map((e) => {
    const num = totalMinor * e.weight; // stays well inside 2^53
    return {
      id: e.id,
      base: Math.floor(num / totalWeight),
      rem: num % totalWeight,
    };
  });

  let leftover = totalMinor - rows.reduce((a, r) => a + r.base, 0);
  const order = [...rows].sort(
    (a, b) => b.rem - a.rem || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = r.base;
  for (const r of order) {
    if (leftover === 0) break;
    out[r.id] = (out[r.id] ?? 0) + 1;
    leftover--;
  }
  return out;
}

const PCT_SCALE = 10_000; // percent carries up to 4 decimals, held as integers

export function computeSplit(
  method: SplitMethod,
  totalMinor: number,
  members: readonly SplitMember[],
): Record<string, number> {
  assertMinor(totalMinor, 'totalMinor');
  if (totalMinor < 0) throw new SplitError('total must not be negative');
  if (members.length === 0) throw new SplitError('at least one member required');
  const ids = new Set(members.map((m) => m.id));
  if (ids.size !== members.length) throw new SplitError('duplicate member ids');

  switch (method) {
    case 'equal':
      return apportion(totalMinor, members.map((m) => ({ id: m.id, weight: 1 })));

    case 'exact': {
      const out: Record<string, number> = {};
      let sum = 0;
      for (const m of members) {
        if (m.exactMinor === undefined) throw new SplitError(`missing exactMinor for ${m.id}`);
        assertMinor(m.exactMinor, `exactMinor(${m.id})`);
        if (m.exactMinor < 0) throw new SplitError('exact amounts must not be negative');
        out[m.id] = m.exactMinor;
        sum += m.exactMinor;
      }
      if (sum !== totalMinor) {
        throw new SplitError(`exact amounts sum to ${sum}, expected ${totalMinor}`);
      }
      return out;
    }

    case 'shares': {
      const entries = members.map((m) => {
        if (m.shares === undefined || !Number.isSafeInteger(m.shares) || m.shares < 0) {
          throw new SplitError(`shares must be a non-negative integer for ${m.id}`);
        }
        return { id: m.id, weight: m.shares };
      });
      return apportion(totalMinor, entries);
    }

    case 'percent': {
      const entries = members.map((m) => {
        if (m.percent === undefined || m.percent < 0) {
          throw new SplitError(`percent must be provided and non-negative for ${m.id}`);
        }
        return { id: m.id, weight: Math.round(m.percent * PCT_SCALE) };
      });
      const totalPct = entries.reduce((a, e) => a + e.weight, 0);
      if (totalPct !== 100 * PCT_SCALE) {
        throw new SplitError(`percentages sum to ${totalPct / PCT_SCALE}, expected 100`);
      }
      return apportion(totalMinor, entries);
    }

    case 'adjustment': {
      let adjSum = 0;
      for (const m of members) {
        const adj = m.adjustMinor ?? 0;
        assertMinor(adj, `adjustMinor(${m.id})`);
        adjSum += adj;
      }
      const pool = totalMinor - adjSum;
      if (pool < 0) throw new SplitError('adjustments exceed the total');
      const base = apportion(pool, members.map((m) => ({ id: m.id, weight: 1 })));
      const out: Record<string, number> = {};
      for (const m of members) out[m.id] = (base[m.id] ?? 0) + (m.adjustMinor ?? 0);
      return out;
    }
  }
}
