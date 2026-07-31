<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Domain\Simplify;
use SlyTab\Support\Categories;
use SlyTab\Support\Money;

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
     *   byHeading:list<array{category:string,minor:int}>,
     *   byPayer:list<array{userId:string,minor:int}>,
     *   byShare:list<array{userId:string,minor:int}>,
     *   byMonth:list<array{month:string,minor:int}>
     * }
     */
    public function totalsFor(string $groupId): array
    {
        $home = $this->homeCurrency($groupId);
        $total = 0;
        $byCategory = [];
        $byHeading = [];
        $byMonth = [];
        $stmt = $this->pdo->prepare(
            'SELECT amount, currency, fx_rate, category, expense_date FROM expenses
             WHERE group_id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$groupId]);
        foreach ($stmt->fetchAll() as $e) {
            $minor = self::toHome((int) $e['amount'], $e['fx_rate'], (string) $e['currency'], $home);
            $total += $minor;
            $byCategory[$e['category']] = ($byCategory[$e['category']] ?? 0) + $minor;
            // Subcategories roll up so the summary stays readable (#18).
            $heading = Categories::heading((string) $e['category']);
            $byHeading[$heading] = ($byHeading[$heading] ?? 0) + $minor;
            $month = substr($e['expense_date'], 0, 7);
            $byMonth[$month] = ($byMonth[$month] ?? 0) + $minor;
        }

        $byPayer = $this->participantTotals($groupId, 'expense_payers', $home);
        $byShare = $this->participantTotals($groupId, 'expense_shares', $home);

        arsort($byCategory);
        arsort($byHeading);
        krsort($byMonth);
        return [
            'totalMinor' => $total,
            'byCategory' => array_map(
                static fn(string $k, int $v): array => ['category' => $k, 'minor' => $v],
                array_keys($byCategory), array_values($byCategory),
            ),
            'byHeading' => array_map(
                static fn(string $k, int $v): array => ['category' => $k, 'minor' => $v],
                array_keys($byHeading), array_values($byHeading),
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
    private function participantTotals(string $groupId, string $table, string $home): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT p.user_id, p.amount, e.currency, e.fx_rate FROM {$table} p
             JOIN expenses e ON e.id = p.expense_id
             WHERE e.group_id = ? AND e.deleted_at IS NULL",
        );
        $stmt->execute([$groupId]);
        $sums = [];
        foreach ($stmt->fetchAll() as $r) {
            $sums[$r['user_id']] = ($sums[$r['user_id']] ?? 0)
                + self::toHome((int) $r['amount'], $r['fx_rate'], (string) $r['currency'], $home);
        }
        arsort($sums);
        return array_map(
            static fn(string $k, int $v): array => ['userId' => $k, 'minor' => $v],
            array_keys($sums), array_values($sums),
        );
    }

    private static function toHome(int $minor, mixed $fxRate, string $from, string $home): int
    {
        return $fxRate === null ? $minor : Money::convert($minor, (float) $fxRate, $from, $home);
    }

    private function homeCurrency(string $groupId): string
    {
        $stmt = $this->pdo->prepare('SELECT home_currency FROM `groups` WHERE id = ?');
        $stmt->execute([$groupId]);
        return (string) ($stmt->fetchColumn() ?: 'CAD');
    }

    public function forGroup(string $groupId): array
    {
        $home = $this->homeCurrency($groupId);
        $net = [];
        $pair = []; // pair["a|b"] > 0 means a owes b
        // #106: the same effects, kept in the currency they were spent in.
        // byCurrency[CUR][userId] — never converted, so it answers "what do I
        // owe in euros?" without anyone having to trust a rate.
        $byCurrency = [];

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
            $converted = self::convertEffects($effects, $e['fx_rate'], $e['currency'], $home);
            foreach ($converted as $uid => $amt) {
                $net[$uid] = ($net[$uid] ?? 0) + $amt;
            }
            // Unconverted, in the expense's own currency.
            $cur = (string) $e['currency'];
            foreach ($effects as $uid => $amt) {
                $byCurrency[$cur][$uid] = ($byCurrency[$cur][$uid] ?? 0) + $amt;
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
                        $owed = Money::convert($owed, $e['fx_rate'], $e['currency'], $home);
                    }
                    self::addPair($pair, $sharer, $payer, $owed);
                }
            }
        }

        $settlements = $this->pdo->prepare(
            "SELECT from_user, to_user, amount, currency FROM settlements
             WHERE group_id = ? AND status = 'confirmed'",
        );
        $settlements->execute([$groupId]);
        foreach ($settlements->fetchAll() as $s) {
            $net[$s['from_user']] = ($net[$s['from_user']] ?? 0) + (int) $s['amount'];
            $net[$s['to_user']] = ($net[$s['to_user']] ?? 0) - (int) $s['amount'];
            self::addPair($pair, $s['from_user'], $s['to_user'], -(int) $s['amount']);
            // …and in the per-currency view (#106), or a debt someone has
            // already paid keeps showing as outstanding there.
            $sc = (string) ($s['currency'] ?: $home);
            $byCurrency[$sc][$s['from_user']] = ($byCurrency[$sc][$s['from_user']] ?? 0) + (int) $s['amount'];
            $byCurrency[$sc][$s['to_user']] = ($byCurrency[$sc][$s['to_user']] ?? 0) - (int) $s['amount'];
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

        // Drop currencies where everyone has netted to zero: a row of zeros is
        // noise, and the whole point of this view is the currencies you still
        // owe something in.
        // Gate on how many currencies the group SPENT in, counted before the
        // zero rows are dropped. Gating on what is still outstanding meant
        // that settling one currency made the whole view disappear — taking
        // the other currency's outstanding detail with it, at exactly the
        // moment it was the only thing left to look at.
        $currenciesInPlay = count($byCurrency);

        $byCurrency = array_filter(
            array_map(
                static fn(array $rows): array => array_filter($rows, static fn(int $v): bool => $v !== 0),
                $byCurrency,
            ),
            static fn(array $rows): bool => $rows !== [],
        );
        ksort($byCurrency);

        return [
            'net' => $net,
            'plan' => Simplify::debts($net),
            'pairwise' => $pairwise,
            // #106: unconverted, per currency. Present only when it says
            // something the converted net does not — i.e. more than one
            // currency is actually in play.
            'byCurrency' => $currenciesInPlay > 1 ? $byCurrency : new \stdClass(),
        ];
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
            'SELECT id, currency, fx_rate FROM expenses WHERE group_id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$groupId]);
        $out = [];
        foreach ($stmt->fetchAll() as $e) {
            $payers = $this->pdo->prepare('SELECT user_id, amount FROM expense_payers WHERE expense_id = ?');
            $payers->execute([$e['id']]);
            $shares = $this->pdo->prepare('SELECT user_id, amount FROM expense_shares WHERE expense_id = ?');
            $shares->execute([$e['id']]);
            $out[] = [
                'currency' => (string) $e['currency'],
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
    private static function convertEffects(array $effects, ?float $rate, string $from, string $home): array
    {
        if ($rate === null) {
            return $effects;
        }
        $converted = [];
        foreach ($effects as $uid => $amt) {
            $converted[$uid] = Money::convert($amt, $rate, $from, $home);
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
