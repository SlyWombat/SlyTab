<?php

declare(strict_types=1);

namespace SlyTab\Domain;

use InvalidArgumentException;

/**
 * Debt simplification — PHP twin of packages/core/src/simplify.ts.
 * Both implementations must pass packages/core/test-vectors/simplify.json.
 *
 * Greedy: repeatedly settle the largest debtor against the largest
 * creditor; ties broken by id ascending. Positive net = is owed.
 */
final class Simplify
{
    /**
     * @param array<string,int> $net member id => net balance in minor units
     * @return list<array{from:string, to:string, amountMinor:int}>
     */
    public static function debts(array $net): array
    {
        $sum = array_sum($net);
        if ($sum !== 0) {
            throw new InvalidArgumentException("net balances sum to {$sum}, expected 0");
        }

        $creditors = [];
        $debtors = [];
        foreach ($net as $id => $amount) {
            if ($amount > 0) {
                $creditors[] = ['id' => (string) $id, 'amount' => $amount];
            } elseif ($amount < 0) {
                $debtors[] = ['id' => (string) $id, 'amount' => -$amount];
            }
        }

        $byAmountDescIdAsc = static fn(array $a, array $b): int =>
            [$b['amount'], $a['id']] <=> [$a['amount'], $b['id']];

        $transfers = [];
        while ($creditors !== [] && $debtors !== []) {
            usort($creditors, $byAmountDescIdAsc);
            usort($debtors, $byAmountDescIdAsc);
            $amount = min($creditors[0]['amount'], $debtors[0]['amount']);
            $transfers[] = [
                'from' => $debtors[0]['id'],
                'to' => $creditors[0]['id'],
                'amountMinor' => $amount,
            ];
            $creditors[0]['amount'] -= $amount;
            $debtors[0]['amount'] -= $amount;
            if ($creditors[0]['amount'] === 0) {
                array_shift($creditors);
            }
            if ($debtors[0]['amount'] === 0) {
                array_shift($debtors);
            }
        }
        return $transfers;
    }
}
