<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\MetricsService;
use SlyTab\Support\Ulid;

/**
 * The dashboard's whole value is that its numbers are true. Nine accounts
 * existed when it was built and four were real people, so the exclusions are
 * the feature — these tests are about what must NOT be counted.
 */
final class MetricsTest extends TestCase
{
    private static ?PDO $pdo = null;
    private MetricsService $svc;

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
        self::$pdo->exec('DELETE FROM expenses');
        self::$pdo->exec('DELETE FROM memberships');
        self::$pdo->exec('DELETE FROM `groups`');
        self::$pdo->exec('DELETE FROM sessions');
        self::$pdo->exec('DELETE FROM users');
        $this->svc = new MetricsService(self::$pdo);
    }

    /** @param array<string,mixed> $flags */
    private function user(string $name, array $flags = []): string
    {
        $id = Ulid::generate();
        self::$pdo->prepare(
            'INSERT INTO users (id, email, password_hash, display_name, payment_handles,
                                email_verified_at, placeholder_at, deleted_at, is_test)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )->execute([
            $id, strtolower($name) . '@example.test', 'x', $name, '{}',
            ($flags['verified'] ?? false) ? gmdate('Y-m-d H:i:s') : null,
            ($flags['placeholder'] ?? false) ? gmdate('Y-m-d H:i:s') : null,
            ($flags['deleted'] ?? false) ? gmdate('Y-m-d H:i:s') : null,
            ($flags['test'] ?? false) ? 1 : 0,
        ]);
        return $id;
    }

    private function session(string $userId, int $daysAgo): void
    {
        self::$pdo->prepare(
            'INSERT INTO sessions (id, user_id, token_hash, device_label, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY),
                     DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY))',
        )->execute([Ulid::generate(), $userId, bin2hex(random_bytes(32)), 'test', $daysAgo]);
    }

    public function testOnlyRealPeopleAreCounted(): void
    {
        $this->user('Real', ['verified' => true]);
        $this->user('AlsoReal');
        $this->user('Reviewer', ['test' => true]);
        $this->user('Invited', ['placeholder' => true]);
        $this->user('Gone', ['deleted' => true]);

        $m = $this->svc->snapshot();

        self::assertSame(2, $m['users'], 'test, placeholder and deleted accounts must not count');
        self::assertSame(1, $m['verified']);
        self::assertSame(1, $m['excludedTestAccounts'], 'and the dashboard says how many it hid');
    }

    public function testActivityWindowsUseRealAccountsOnly(): void
    {
        $recent = $this->user('Recent');
        $old = $this->user('Old');
        $tester = $this->user('Tester', ['test' => true]);
        $this->session($recent, 2);
        $this->session($old, 20);
        $this->session($tester, 1);

        $m = $this->svc->snapshot();

        self::assertSame(1, $m['active7d'], 'the test account was active yesterday and must not count');
        self::assertSame(2, $m['active30d']);
    }

    /** A test run adding expenses must not look like traction. */
    public function testExpensesCreatedByTestAccountsAreExcluded(): void
    {
        $real = $this->user('Real');
        $tester = $this->user('Tester', ['test' => true]);
        $gid = Ulid::generate();
        self::$pdo->prepare(
            'INSERT INTO `groups` (id, name, home_currency, currencies, created_by) VALUES (?, ?, ?, ?, ?)',
        )->execute([$gid, 'G', 'CAD', '["CAD"]', $real]);

        foreach ([[$real, 'real one'], [$tester, 'test one'], [$tester, 'test two']] as [$who, $desc]) {
            self::$pdo->prepare(
                'INSERT INTO expenses (id, group_id, description, amount, currency, expense_date,
                                       category, created_by)
                 VALUES (?, ?, ?, ?, ?, CURDATE(), ?, ?)',
            )->execute([Ulid::generate(), $gid, $desc, 1000, 'CAD', 'other', $who]);
        }

        $m = $this->svc->snapshot();

        self::assertSame(1, $m['expenses'], 'only the real person\'s expense counts');
        self::assertSame(1, $m['expenses7d']);
        self::assertSame(1, $m['groups']);
    }

    public function testSnapshotIsStampedAndComplete(): void
    {
        $m = $this->svc->snapshot();

        foreach (['users', 'verified', 'active7d', 'active30d', 'groups', 'expenses',
                  'expenses7d', 'settlements', 'receipts', 'openBugReports', 'pushDevices',
                  'excludedTestAccounts', 'generatedAt'] as $k) {
            self::assertArrayHasKey($k, $m);
        }
        self::assertNotFalse(strtotime((string) $m['generatedAt']));
    }
}
