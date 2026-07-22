/**
 * Net balances — FR-6.1/6.3. Derived, never stored.
 * Convention: positive net = the group owes this member money.
 */

import { assertMinor } from './money.js';

export interface ExpenseLike {
  payers: readonly { userId: string; amountMinor: number }[];
  shares: readonly { userId: string; amountMinor: number }[];
}

export interface SettlementLike {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  /** only confirmed settlements move balances */
  status: 'pending' | 'confirmed';
}

export function computeNetBalances(
  expenses: readonly ExpenseLike[],
  settlements: readonly SettlementLike[],
): Record<string, number> {
  const net: Record<string, number> = {};
  const add = (userId: string, delta: number) => {
    assertMinor(delta);
    net[userId] = (net[userId] ?? 0) + delta;
  };

  for (const e of expenses) {
    for (const p of e.payers) add(p.userId, p.amountMinor);
    for (const s of e.shares) add(s.userId, -s.amountMinor);
  }
  for (const s of settlements) {
    if (s.status !== 'confirmed') continue;
    add(s.fromUserId, s.amountMinor);
    add(s.toUserId, -s.amountMinor);
  }
  return net;
}
