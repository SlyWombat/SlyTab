<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\ActivityService;
use SlyTab\Services\BalanceService;
use SlyTab\Services\ExpenseService;
use SlyTab\Services\FxService;
use SlyTab\Services\GroupService;
use SlyTab\Support\Ulid;

/**
 * Balances and expense pages must cost a fixed number of queries.
 *
 * The database is on a different host — /health/deep measures the round trip
 * at 11-13ms — so a query issued per expense is not a style problem, it is the
 * growth term. BalanceService used to run 2 queries per expense and
 * ExpenseService 3 per row of every page: a user with 49 expenses measured
 * 2.2-2.6s on a real device in Santiago, and the cost rose forever.
 *
 * This asserts the PROPERTY rather than a number: double the expenses, and the
 * query count must not move. A constant would have to be updated whenever an
 * unrelated query is added, and would then be updated past a reintroduced N+1
 * without anyone noticing.
 */
final class QueryCountTest extends TestCase
{
    private static ?PDO $pdo = null;

    public static function setUpBeforeClass(): void
    {
        try {
            self::$pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator(self::$pdo))->fresh();
    }

    /** Statements executed on this connection so far. */
    private function queries(): int
    {
        $row = self::$pdo->query("SHOW SESSION STATUS LIKE 'Questions'")->fetch();
        return (int) $row['Value'];
    }

    /** @return array{group:string, user:string} */
    private function seed(int $expenseCount): array
    {
        $pdo = self::$pdo;
        $userId = Ulid::generate();
        $pdo->prepare('INSERT INTO users (id, email, password_hash, display_name, default_currency)
                       VALUES (?, ?, ?, ?, ?)')
            ->execute([$userId, "qc-{$userId}@example.com", 'x', 'QC', 'CAD']);

        $groupId = Ulid::generate();
        $pdo->prepare('INSERT INTO `groups` (id, name, emoji, home_currency, created_by)
                       VALUES (?, ?, ?, ?, ?)')
            ->execute([$groupId, 'QC', '🧪', 'CAD', $userId]);
        $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
            ->execute([$groupId, $userId]);

        for ($i = 0; $i < $expenseCount; $i++) {
            $eid = Ulid::generate();
            $pdo->prepare('INSERT INTO expenses (id, group_id, description, amount, currency,
                             expense_date, category, created_by)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$eid, $groupId, "e{$i}", 1000, 'CAD', '2026-08-01', 'other', $userId]);
            $pdo->prepare('INSERT INTO expense_payers (expense_id, user_id, amount) VALUES (?, ?, ?)')
                ->execute([$eid, $userId, 1000]);
            $pdo->prepare('INSERT INTO expense_shares (expense_id, user_id, amount, split_method)
                           VALUES (?, ?, ?, ?)')
                ->execute([$eid, $userId, 1000, 'equal']);
        }
        return ['group' => $groupId, 'user' => $userId];
    }

    private function balances(): BalanceService
    {
        return new BalanceService(self::$pdo, new FxService(self::$pdo));
    }

    public function testGroupBalancesDoNotCostAQueryPerExpense(): void
    {
        $small = $this->seed(3);
        $large = $this->seed(12);
        $svc = $this->balances();

        // Warm anything lazily prepared, so the measurement is of the work
        // itself rather than of first use.
        $svc->forGroup($small['group'], $small['user']);

        $before = $this->queries();
        $svc->forGroup($small['group'], $small['user']);
        $costSmall = $this->queries() - $before;

        $before = $this->queries();
        $svc->forGroup($large['group'], $large['user']);
        $costLarge = $this->queries() - $before;

        self::assertSame(
            $costSmall,
            $costLarge,
            "balances cost {$costSmall} queries for 3 expenses and {$costLarge} for 12 — "
            . 'that difference is a query per expense, against a database one network hop away',
        );
    }

    public function testAnExpensePageDoesNotCostQueriesPerRow(): void
    {
        $small = $this->seed(3);
        $large = $this->seed(12);
        $activity = new ActivityService(self::$pdo);
        $svc = new ExpenseService(
            self::$pdo,
            new GroupService(self::$pdo, $activity),
            new FxService(self::$pdo),
            $activity,
        );

        $svc->listForGroup($small['group'], null, 50);

        $before = $this->queries();
        $svc->listForGroup($small['group'], null, 50);
        $costSmall = $this->queries() - $before;

        $before = $this->queries();
        $svc->listForGroup($large['group'], null, 50);
        $costLarge = $this->queries() - $before;

        self::assertSame(
            $costSmall,
            $costLarge,
            "a 3-row page cost {$costSmall} queries and a 12-row page {$costLarge} — "
            . 'the page is paying per row again',
        );
    }
}
