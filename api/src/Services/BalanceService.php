<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Domain\Simplify;

/**
 * Balances — FR-6.x. Derived on demand, never stored. All results are in
 * the group's home currency, in minor units; positive net = is owed.
 *
 * Foreign-currency expenses convert per-user with the expense's locked
 * rate; any rounding residual is assigned to the participant with the
 * largest absolute effect (tie: lowest id) so nets always sum to zero and
 * Simplify::debts stays well-defined.
 */
final class BalanceService
{
    public function __construct(private readonly PDO $pdo) {}

    /**
     * @return array{
     *   net: array<string,int>,
     *   plan: list<array{from:string,to:string,amountMinor:int}>,
     *   pairwise: list<array{from:string,to:string,amountMinor:int}>
     * }
     */
    /**
     * Spending summaries for the Totals tab — everything converted into the
     * group's home currency with each expense's locked rate. Settlements are
     * transfers, not spending, so they are not included.
     *
     * @return array{
     *   totalMinor:int,
     *   byCategory:list<array{category:string,minor:int}>,
     *   byPayer:list<array{userId:string,minor:int}>,
     *   byShare:list<array{userId:string,minor:int}>,
     *   byMonth:list<array{month:string,minor:int}>
     * }
     */
    public function totalsFor(string $groupId): array
    {
        $total = 0;
        $byCategory = [];
        $byMonth = [];
        $stmt = $this->pdo->prepare(
            'SELECT amount, fx_rate, category, expense_date FROM expenses
             WHERE group_id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$groupId]);
        foreach ($stmt->fetchAll() as $e) {
            $minor = self::toHome((int) $e['amount'], $e['fx_rate']);
            $total += $minor;
            $byCategory[$e['category']] = ($byCategory[$e['category']] ?? 0) + $minor;
            $month = substr($e['expense_date'], 0, 7);
            $byMonth[$month] = ($byMonth[$month] ?? 0) + $minor;
        }

        $byPayer = $this->participantTotals($groupId, 'expense_payers');
        $byShare = $this->participantTotals($groupId, 'expense_shares');

        arsort($byCategory);
        krsort($byMonth);
        return [
            'totalMinor' => $total,
            'byCategory' => array_map(
                static fn(string $k, int $v): array => ['category' => $k, 'minor' => $v],
                array_keys($byCategory), array_values($byCategory),
            ),
            'byPayer' => $byPayer,
            'byShare' => $byShare,
            'byMonth' => array_map(
                static fn(string $k, int $v): array => ['month' => $k, 'minor' => $v],
                array_keys($byMonth), array_values($byMonth),
            ),
        ];
    }

    /** @return list<array{userId:string,minor:int}> converted, descending */
    private function participantTotals(string $groupId, string $table): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT p.user_id, p.amount, e.fx_rate FROM {$table} p
             JOIN expenses e ON e.id = p.expense_id
             WHERE e.group_id = ? AND e.deleted_at IS NULL",
        );
        $stmt->execute([$groupId]);
        $sums = [];
        foreach ($stmt->fetchAll() as $r) {
            $sums[$r['user_id']] = ($sums[$r['user_id']] ?? 0) + self::toHome((int) $r['amount'], $r['fx_rate']);
        }
        arsort($sums);
        return array_map(
            static fn(string $k, int $v): array => ['userId' => $k, 'minor' => $v],
            array_keys($sums), array_values($sums),
        );
    }

    private static function toHome(int $minor, mixed $fxRate): int
    {
        return $fxRate === null ? $minor : (int) round($minor * (float) $fxRate);
    }

    public function forGroup(string $groupId): array
    {
        $net = [];
        $pair = []; // pair["a|b"] > 0 means a owes b

        // Seed every active member so settled members show explicit zeros.
        $members = $this->pdo->prepare(
            'SELECT user_id FROM memberships WHERE group_id = ? AND left_at IS NULL',
        );
        $members->execute([$groupId]);
        foreach ($members->fetchAll(PDO::FETCH_COLUMN) as $uid) {
            $net[$uid] = 0;
        }

        foreach ($this->expenses($groupId) as $e) {
            $effects = [];
            foreach ($e['payers'] as $uid => $amt) {
                $effects[$uid] = ($effects[$uid] ?? 0) + $amt;
            }
            foreach ($e['shares'] as $uid => $amt) {
                $effects[$uid] = ($effects[$uid] ?? 0) - $amt;
            }
            $converted = self::convertEffects($effects, $e['fx_rate']);
            foreach ($converted as $uid => $amt) {
                $net[$uid] = ($net[$uid] ?? 0) + $amt;
            }

            // Pairwise attribution: each sharer owes each payer in
            // proportion to that payer's fraction of the expense.
            $total = array_sum($e['payers']);
            foreach ($e['shares'] as $sharer => $shareAmt) {
                foreach ($e['payers'] as $payer => $paidAmt) {
                    if ($sharer === $payer) {
                        continue;
                    }
                    $owed = intdiv($shareAmt * $paidAmt, max($total, 1));
                    if ($e['fx_rate'] !== null) {
                        $owed = (int) round($owed * $e['fx_rate']);
                    }
                    self::addPair($pair, $sharer, $payer, $owed);
                }
            }
        }

        $settlements = $this->pdo->prepare(
            "SELECT from_user, to_user, amount FROM settlements
             WHERE group_id = ? AND status = 'confirmed'",
        );
        $settlements->execute([$groupId]);
        foreach ($settlements->fetchAll() as $s) {
            $net[$s['from_user']] = ($net[$s['from_user']] ?? 0) + (int) $s['amount'];
            $net[$s['to_user']] = ($net[$s['to_user']] ?? 0) - (int) $s['amount'];
            self::addPair($pair, $s['from_user'], $s['to_user'], -(int) $s['amount']);
        }

        $pairwise = [];
        foreach ($pair as $key => $amt) {
            if ($amt === 0) {
                continue;
            }
            [$a, $b] = explode('|', $key);
            $pairwise[] = $amt > 0
                ? ['from' => $a, 'to' => $b, 'amountMinor' => $amt]
                : ['from' => $b, 'to' => $a, 'amountMinor' => -$amt];
        }
        usort($pairwise, static fn(array $x, array $y): int => [$x['from'], $x['to']] <=> [$y['from'], $y['to']]);

        return ['net' => $net, 'plan' => Simplify::debts($net), 'pairwise' => $pairwise];
    }

    public function netFor(string $groupId, string $userId): int
    {
        return $this->forGroup($groupId)['net'][$userId] ?? 0;
    }

    // ---- internals ----

    /**
     * @return list<array{fx_rate: ?float, payers: array<string,int>, shares: array<string,int>}>
     */
    private function expenses(string $groupId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, fx_rate FROM expenses WHERE group_id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$groupId]);
        $out = [];
        foreach ($stmt->fetchAll() as $e) {
            $payers = $this->pdo->prepare('SELECT user_id, amount FROM expense_payers WHERE expense_id = ?');
            $payers->execute([$e['id']]);
            $shares = $this->pdo->prepare('SELECT user_id, amount FROM expense_shares WHERE expense_id = ?');
            $shares->execute([$e['id']]);
            $out[] = [
                'fx_rate' => $e['fx_rate'] === null ? null : (float) $e['fx_rate'],
                'payers' => array_map('intval', $payers->fetchAll(PDO::FETCH_KEY_PAIR)),
                'shares' => array_map('intval', $shares->fetchAll(PDO::FETCH_KEY_PAIR)),
            ];
        }
        return $out;
    }

    /**
     * @param array<string,int> $effects per-user net effect in expense currency
     * @return array<string,int> converted to home currency, summing to zero
     */
    private static function convertEffects(array $effects, ?float $rate): array
    {
        if ($rate === null) {
            return $effects;
        }
        $converted = [];
        foreach ($effects as $uid => $amt) {
            $converted[$uid] = (int) round($amt * $rate, 0, PHP_ROUND_HALF_UP);
        }
        $residual = -array_sum($converted);
        if ($residual !== 0) {
            $target = null;
            foreach ($converted as $uid => $amt) {
                if ($target === null
                    || abs($amt) > abs($converted[$target])
                    || (abs($amt) === abs($converted[$target]) && $uid < $target)) {
                    $target = $uid;
                }
            }
            $converted[$target] += $residual;
        }
        return $converted;
    }

    /** @param array<string,int> $pair */
    private static function addPair(array &$pair, string $debtor, string $creditor, int $amount): void
    {
        // Canonical key: lexicographically smaller id first; positive value
        // means the first id owes the second.
        if ($debtor < $creditor) {
            $pair["{$debtor}|{$creditor}"] = ($pair["{$debtor}|{$creditor}"] ?? 0) + $amount;
        } else {
            $pair["{$creditor}|{$debtor}"] = ($pair["{$creditor}|{$debtor}"] ?? 0) - $amount;
        }
    }
}
