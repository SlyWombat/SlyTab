/**
 * Debt simplification — FR-6.2. Greedy: repeatedly settle the largest
 * debtor against the largest creditor. Minimizes transfer count for all
 * realistic group sizes and is fully deterministic (ties broken by id
 * ascending). PHP twin: api/src/Domain/Simplify.php — both must pass
 * packages/core/test-vectors/simplify.json.
 */

export interface Transfer {
  from: string;
  to: string;
  amountMinor: number;
}

export class SimplifyError extends Error {}

export function simplifyDebts(net: Record<string, number>): Transfer[] {
  const sum = Object.values(net).reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new SimplifyError(`net balances sum to ${sum}, expected 0`);

  const creditors = Object.entries(net)
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ id, amount: v }));
  const debtors = Object.entries(net)
    .filter(([, v]) => v < 0)
    .map(([id, v]) => ({ id, amount: -v }));

  const byAmountDescIdAsc = (
    a: { id: string; amount: number },
    b: { id: string; amount: number },
  ) => b.amount - a.amount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const transfers: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(byAmountDescIdAsc);
    debtors.sort(byAmountDescIdAsc);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c.amount, d.amount);
    transfers.push({ from: d.id, to: c.id, amountMinor: amount });
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount === 0) creditors.shift();
    if (d.amount === 0) debtors.shift();
  }
  return transfers;
}
