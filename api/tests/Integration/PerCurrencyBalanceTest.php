<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\BalanceService;
use SlyTab\Support\Ulid;

/**
 * Issue #106: balances kept per currency, unconverted.
 *
 * The converted net is what SlyTab shows by default and is the better answer
 * for most people — one number to settle. This is the other reading: what do I
 * owe *in euros*, without trusting any rate. It has to agree with reality in
 * each currency separately, and it must not appear at all when there is only
 * one currency, because then it is just the net with extra steps.
 */
final class PerCurrencyBalanceTest extends TestCase
{
    private static ?PDO $pdo = null;
    private BalanceService $svc;
    private string $groupId = '';
    /** @var array<string,string> */
    private array $u = [];

    public static function setUpBeforeClass(): void
    {
        try {
            self::$pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator(self::$pdo))->fresh();
    }

    protected function setUp(): void
    {
        $pdo = self::$pdo;
        $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach (['expense_shares', 'expense_payers', 'expenses', 'settlements',
                  'memberships', '`groups`', 'users'] as $t) {
            $pdo->exec("DELETE FROM {$t}");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');

        $this->svc = new BalanceService($pdo);
        foreach (['ann', 'bob'] as $name) {
            $id = Ulid::generate();
            $this->u[$name] = $id;
            $pdo->prepare('INSERT INTO users (id, email, password_hash, display_name, payment_handles)
                           VALUES (?, ?, ?, ?, ?)')
                ->execute([$id, "$name@example.test", 'x', ucfirst($name), '{}']);
        }
        $this->groupId = Ulid::generate();
        $pdo->prepare('INSERT INTO `groups` (id, name, home_currency, currencies, created_by)
                       VALUES (?, ?, ?, ?, ?)')
            ->execute([$this->groupId, 'Trip', 'CAD', '["CAD","EUR"]', $this->u['ann']]);
        foreach ($this->u as $id) {
            $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
                ->execute([$this->groupId, $id]);
        }
    }

    /** Ann pays the whole thing; it splits evenly, so Bob owes half. */
    private function expense(int $minor, string $currency, ?float $rate): void
    {
        $id = Ulid::generate();
        self::$pdo->prepare(
            'INSERT INTO expenses (id, group_id, description, amount, currency, fx_rate,
                                   fx_rate_source, expense_date, category, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?)',
        )->execute([$id, $this->groupId, "spend {$currency}", $minor, $currency, $rate,
                    $rate === null ? null : 'ecb', 'other', $this->u['ann']]);
        self::$pdo->prepare('INSERT INTO expense_payers (expense_id, user_id, amount) VALUES (?, ?, ?)')
            ->execute([$id, $this->u['ann'], $minor]);
        foreach ([intdiv($minor, 2), $minor - intdiv($minor, 2)] as $i => $share) {
            self::$pdo->prepare('INSERT INTO expense_shares (expense_id, user_id, amount) VALUES (?, ?, ?)')
                ->execute([$id, array_values($this->u)[$i], $share]);
        }
    }

    public function testAbsentWhenOnlyOneCurrencyIsInPlay(): void
    {
        $this->expense(1000, 'CAD', null);

        $b = $this->svc->forGroup($this->groupId);

        self::assertEmpty((array) $b['byCurrency'],
            'with one currency this view says nothing the net does not');
    }

    public function testEachCurrencyKeepsItsOwnUnconvertedBalance(): void
    {
        $this->expense(1000, 'CAD', null);   // Bob owes Ann 5.00 CAD
        $this->expense(500, 'EUR', 1.5);     // Bob owes Ann 2.50 EUR

        $b = (array) $this->svc->forGroup($this->groupId)['byCurrency'];

        self::assertSame(['CAD', 'EUR'], array_keys($b));
        self::assertSame(500, $b['CAD'][$this->u['ann']], 'Ann is up 5.00 CAD');
        self::assertSame(-500, $b['CAD'][$this->u['bob']]);
        // The EUR figure must be EUROS — not euros valued in dollars.
        self::assertSame(250, $b['EUR'][$this->u['ann']], 'Ann is up 2.50 EUR, unconverted');
        self::assertSame(-250, $b['EUR'][$this->u['bob']]);
    }

    /** The converted net still works, and is a different number on purpose. */
    public function testTheConvertedNetIsUnaffected(): void
    {
        $this->expense(1000, 'CAD', null);
        $this->expense(500, 'EUR', 1.5);     // 2.50 EUR -> 3.75 CAD

        $net = $this->svc->forGroup($this->groupId)['net'];

        self::assertSame(875, $net[$this->u['ann']], '5.00 + 3.75 CAD');
        self::assertSame(-875, $net[$this->u['bob']]);
    }

    public function testSettlingInOneCurrencyClearsOnlyThatCurrency(): void
    {
        $this->expense(1000, 'CAD', null);
        $this->expense(500, 'EUR', 1.5);
        self::$pdo->prepare(
            "INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, status)
             VALUES (?, ?, ?, ?, ?, 'EUR', 'confirmed')",
        )->execute([Ulid::generate(), $this->groupId, $this->u['bob'], $this->u['ann'], 250]);

        $b = (array) $this->svc->forGroup($this->groupId)['byCurrency'];

        self::assertArrayNotHasKey('EUR', $b, 'the euro debt was paid and should disappear');
        self::assertSame(-500, $b['CAD'][$this->u['bob']], 'the dollar debt is untouched');
    }
}
