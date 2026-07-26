/**
 * Split math — FR-3.2. Deterministic to the cent.
 *
 * Remainder cents distribute by largest remainder, ties broken by member id
 * ascending. This algorithm has a PHP twin in api/src/Domain/Split.php; both
 * must pass packages/core/test-vectors/split.json. Change them together.
 */

import {
  assertMinor, bridgeMinor, minorToAmountString, minorUnitScale, parseAmount,
  parseSignedAmount, rescaleAmountString,
} from './money.js';

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

/**
 * Split-form input bridging — issue #13. Both clients build their split
 * forms on these so the parsing rules stay identical: blank means 0,
 * shares are whole numbers, percents take decimals, adjustments are
 * signed amounts at the currency's scale.
 */

/**
 * Per-member numbers an expense persists as `splitInput` so editing can
 * restore the form. Meaning follows the split method: share counts,
 * percents, or adjustment minor units (in the expense's currency).
 */
export type SplitInputValues = Record<string, number>;

function inputNumber(raw: string, label: string): number {
  const n = Number(raw);
  if (Number.isNaN(n)) throw new SplitError(`"${raw}" is not a ${label}`);
  return n;
}

/** Raw per-member form strings → members for computeSplit. */
export function splitMembersFromInputs(
  method: SplitMethod,
  ids: readonly string[],
  inputs: Readonly<Record<string, string>>,
  currency: string,
): SplitMember[] {
  return ids.map((id) => {
    const raw = (inputs[id] ?? '').trim();
    switch (method) {
      case 'equal':
        return { id };
      case 'exact':
        return { id, exactMinor: parseAmount(raw, currency) };
      case 'shares':
        return { id, shares: raw === '' ? 0 : inputNumber(raw, 'share count') };
      case 'percent':
        return { id, percent: raw === '' ? 0 : inputNumber(raw, 'percentage') };
      case 'adjustment':
        return { id, adjustMinor: parseSignedAmount(raw, currency) };
    }
  });
}

/** Form strings → the numbers to persist as `splitInput`. Members left blank (or 0) are dropped. */
export function splitInputsToStored(
  method: SplitMethod,
  ids: readonly string[],
  inputs: Readonly<Record<string, string>>,
  currency: string,
): SplitInputValues | null {
  if (method === 'equal' || method === 'exact') return null; // the shares list restores these
  const out: SplitInputValues = {};
  for (const m of splitMembersFromInputs(method, ids, inputs, currency)) {
    const v = m.shares ?? m.percent ?? m.adjustMinor ?? 0;
    if (v !== 0) out[m.id] = v;
  }
  return out;
}

/**
 * Rescale a set of amount fields that has to keep summing to `totalStr`
 * when the currency picker moves between minor-unit scales (issue #74).
 *
 * `rescaleAmountString` on its own rounds every field independently, so a
 * balanced split comes apart on the way down to a zero-decimal currency:
 * ARS 15306.67 / 15306.67 / 15306.66 (= 45920.00) each round half-up to
 * CLP 15307, which is 45921 against a 45920 total. The form then shows
 * `remaining: -1` and disables Save for something the user never typed.
 *
 * So when the fields reconcile against the total before the switch, the
 * total is rescaled first and re-apportioned across them by their old
 * weights (largest remainder, as everywhere else) — the split stays
 * balanced and stays as close to the old proportions as integers allow.
 * When they don't reconcile (a half-typed split), each field is rescaled
 * on its own as before: mid-edit numbers are the user's, not ours to
 * even out.
 *
 * Blank fields stay blank. Only ids present in `inputs` take part.
 */
export function rescaleAmountFields(
  inputs: Readonly<Record<string, string>>,
  totalStr: string,
  from: string,
  to: string,
): Record<string, string> {
  const each = (): Record<string, string> => Object.fromEntries(
    Object.entries(inputs).map(([id, v]) => [id, rescaleAmountString(v, from, to)]),
  );
  const fromScale = minorUnitScale(from);
  if (fromScale === minorUnitScale(to)) return { ...inputs };
  try {
    const total = parseAmount(totalStr, from);
    const filled = Object.entries(inputs).filter(([, v]) => v.trim() !== '');
    const entries = filled.map(([id, v]) => ({ id, weight: parseAmount(v, from) }));
    const sum = entries.reduce((a, e) => a + e.weight, 0);
    // Nothing to preserve unless the fields genuinely balance the total.
    if (total <= 0 || sum !== total
      || entries.some((e) => e.weight < 0) || !entries.some((e) => e.weight > 0)) return each();
    const parts = apportion(bridgeMinor(total, fromScale, to),
      entries.filter((e) => e.weight > 0));
    return Object.fromEntries(Object.entries(inputs).map(([id, v]) => [
      id,
      parts[id] === undefined ? rescaleAmountString(v, from, to) : minorToAmountString(parts[id], to),
    ]));
  } catch {
    return each(); // unparseable mid-edit input: leave the old behaviour
  }
}

/** Persisted `splitInput` numbers → the form strings they came from. */
export function splitInputsFromStored(
  method: SplitMethod,
  stored: Readonly<SplitInputValues>,
  currency: string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(stored).map(([id, v]) => [
    id,
    method === 'adjustment' ? minorToAmountString(v, currency) : String(v),
  ]));
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
