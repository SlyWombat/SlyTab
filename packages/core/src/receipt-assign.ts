/**
 * Receipt item-assignment math, shared by the web and mobile Assign
 * sheets (previously duplicated in each). All amounts are integer minor
 * units of the bill currency.
 *
 * Items can be IGNORED (issue #23): loyalty-credit lines ("$1.45 Uber
 * One credits earned") that the parser reads as items but that are not
 * part of the bill. Ignored items count toward nothing — not the item
 * sum, not the assignment requirement, not anyone's share.
 */

import { computeSplit } from './split.js';

export interface ReceiptBillInput {
  items: readonly { totalMinor: number }[];
  /** Parsed bill total; null falls back to items + tax + tip. */
  totalMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
}

export interface ReceiptBill {
  /** Sum of the kept (non-ignored) items. */
  itemsSum: number;
  /** The bill as printed (or reconstructed from kept items). */
  billTotal: number;
  /** billTotal + any card-slip tip. */
  totalMinor: number;
  /** totalMinor − itemsSum: tax + tip + unparsed delta, prorated. */
  extraMinor: number;
}

export function receiptBill(
  parsed: ReceiptBillInput,
  ignored: ReadonlySet<number> = new Set(),
  slipTipMinor = 0,
): ReceiptBill {
  const itemsSum = parsed.items.reduce((a, it, i) => a + (ignored.has(i) ? 0 : it.totalMinor), 0);
  const billTotal = parsed.totalMinor
    ?? itemsSum + (parsed.taxMinor ?? 0) + (parsed.tipMinor ?? 0);
  const totalMinor = billTotal + slipTipMinor;
  return { itemsSum, billTotal, totalMinor, extraMinor: totalMinor - itemsSum };
}

/**
 * Per-member totals: each kept item splits equally among its assignees,
 * then the extra (tax/tip/delta) prorates by assigned value using
 * largest-remainder shares. Invariant: when every kept item has at
 * least one assignee, the shares sum to exactly
 * itemsSum + extraMinor === totalMinor.
 */
export function assignedShares(
  items: readonly { totalMinor: number }[],
  assign: Readonly<Record<number, ReadonlySet<string> | readonly string[]>>,
  ignored: ReadonlySet<number>,
  extraMinor: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  items.forEach((item, i) => {
    if (ignored.has(i)) return;
    const who = [...(assign[i] ?? [])].sort();
    if (who.length === 0) return;
    const split = computeSplit('equal', item.totalMinor, who.map((id) => ({ id })));
    for (const [id, v] of Object.entries(split)) out[id] = (out[id] ?? 0) + v;
  });
  if (extraMinor !== 0 && Object.keys(out).length > 0) {
    const weights = Object.entries(out)
      .filter(([, v]) => v > 0)
      .map(([id, v]) => ({ id, shares: v }));
    if (weights.length > 0) {
      const prorated = computeSplit('shares', Math.abs(extraMinor), weights);
      for (const [id, v] of Object.entries(prorated)) {
        out[id] = (out[id] ?? 0) + (extraMinor > 0 ? v : -v);
      }
    }
  }
  return out;
}

/** Every kept item has at least one assignee (Continue is allowed). */
export function allAssigned(
  items: readonly unknown[],
  assign: Readonly<Record<number, ReadonlySet<string> | readonly string[]>>,
  ignored: ReadonlySet<number>,
): boolean {
  return items.every((_, i) => {
    if (ignored.has(i)) return true;
    const a = assign[i];
    return a !== undefined && (a instanceof Set ? a.size : (a as readonly string[]).length) > 0;
  });
}
