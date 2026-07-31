<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\BalanceService;
use SlyTab\Services\Mailer;
use SlyTab\Services\ReminderService;
use SlyTab\Support\Ulid;

/** Captures dispatch() so a reminder can be inspected instead of sent. */
final class ReminderMailer extends Mailer
{
    /** @var list<array{to:string,subject:string,body:string}> */
    public array $sent = [];

    public function dispatch(string $to, string $subject, string $body): bool
    {
        $this->sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
        return true;
    }
}

/**
 * Issue #19: payment reminders.
 *
 * Finding the forgotten debts is easy. The tests that matter are the ones
 * about restraint — not nagging twice, not emailing over pennies, not writing
 * to someone who asked for silence, and never telling the person who is OWED
 * to go and chase a friend.
 */
final class ReminderTest extends TestCase
{
    private static ?PDO $pdo = null;
    private ReminderMailer $mailer;
    private ReminderService $svc;
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
                  'notification_emails', 'memberships', '`groups`', 'users'] as $t) {
            $pdo->exec("DELETE FROM {$t}");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');

        $this->mailer = new ReminderMailer();
        $this->svc = new ReminderService($pdo, new BalanceService($pdo), $this->mailer);

        foreach (['ann', 'bob'] as $n) {
            $id = Ulid::generate();
            $this->u[$n] = $id;
            $pdo->prepare('INSERT INTO users (id, email, password_hash, display_name, payment_handles)
                           VALUES (?, ?, ?, ?, ?)')
                ->execute([$id, "$n@example.test", 'x', ucfirst($n), '{}']);
        }
        $this->groupId = Ulid::generate();
        $pdo->prepare('INSERT INTO `groups` (id, name, home_currency, currencies, created_by)
                       VALUES (?, ?, ?, ?, ?)')
            ->execute([$this->groupId, 'Ski Trip', 'CAD', '["CAD"]', $this->u['ann']]);
        foreach ($this->u as $id) {
            $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
                ->execute([$this->groupId, $id]);
        }
    }

    /** Ann paid; Bob owes half. `$daysAgo` ages it so the group looks stale. */
    private function oldExpense(int $minor, int $daysAgo): void
    {
        $id = Ulid::generate();
        self::$pdo->prepare(
            "INSERT INTO expenses (id, group_id, description, amount, currency, expense_date,
                                   category, created_by, created_at)
             VALUES (?, ?, 'lift pass', ?, 'CAD', CURDATE(), 'other', ?,
                     DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY))",
        )->execute([$id, $this->groupId, $minor, $this->u['ann'], $daysAgo]);
        self::$pdo->prepare('INSERT INTO expense_payers (expense_id, user_id, amount) VALUES (?, ?, ?)')
            ->execute([$id, $this->u['ann'], $minor]);
        foreach (['ann', 'bob'] as $i => $n) {
            $share = $i === 0 ? intdiv($minor, 2) : $minor - intdiv($minor, 2);
            self::$pdo->prepare('INSERT INTO expense_shares (expense_id, user_id, amount) VALUES (?, ?, ?)')
                ->execute([$id, $this->u[$n], $share]);
        }
    }

    private function pendingSettlement(int $daysAgo): void
    {
        self::$pdo->prepare(
            "INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, status, created_at)
             VALUES (?, ?, ?, ?, 2500, 'CAD', 'pending', DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY))",
        )->execute([Ulid::generate(), $this->groupId, $this->u['bob'], $this->u['ann'], $daysAgo]);
    }

    public function testTheDebtorIsRemindedAndTheCreditorIsNot(): void
    {
        $this->oldExpense(10000, 40);   // Bob owes Ann 50.00

        $r = $this->svc->sweep();

        self::assertSame(1, $r['stale']);
        self::assertCount(1, $this->mailer->sent);
        self::assertSame('bob@example.test', $this->mailer->sent[0]['to'],
            'the person who owes is reminded — never the one who is owed');
        self::assertStringContainsString('50.00 CAD', $this->mailer->sent[0]['body']);
        self::assertStringContainsString('Ann', $this->mailer->sent[0]['subject']);
    }

    public function testAFreshGroupIsLeftAlone(): void
    {
        $this->oldExpense(10000, 2);    // yesterday-ish: not stale

        self::assertSame(0, $this->svc->sweep()['stale']);
        self::assertSame([], $this->mailer->sent);
    }

    public function testNobodyIsNaggedTwice(): void
    {
        $this->oldExpense(10000, 40);
        $this->svc->sweep();
        $this->mailer->sent = [];

        $second = $this->svc->sweep();

        self::assertSame(0, $second['stale'], 'the cooling-off period holds');
        self::assertSame([], $this->mailer->sent);
    }

    public function testSmallDebtsAreNotWorthAnEmail(): void
    {
        $this->oldExpense(400, 40);     // 2.00 owed — under the floor

        self::assertSame(0, $this->svc->sweep()['stale']);
        self::assertSame([], $this->mailer->sent);
    }

    public function testSomeoneWhoAskedForSilenceGetsIt(): void
    {
        self::$pdo->prepare("UPDATE users SET notify_level = 'none' WHERE id = ?")
            ->execute([$this->u['bob']]);
        $this->oldExpense(10000, 40);

        self::assertSame(0, $this->svc->sweep()['stale']);
        self::assertSame([], $this->mailer->sent);
    }

    public function testAnUnconfirmedPaymentNudgesThePersonWhoMustConfirm(): void
    {
        $this->pendingSettlement(5);

        $r = $this->svc->sweep();

        self::assertSame(1, $r['unconfirmed']);
        self::assertSame('ann@example.test', $this->mailer->sent[0]['to'],
            'Ann has to confirm, so Ann is the one asked');
        self::assertStringContainsString('confirm', strtolower($this->mailer->sent[0]['subject']));
    }

    public function testARecentlyRecordedPaymentIsGivenTimeToBeConfirmed(): void
    {
        $this->pendingSettlement(1);

        self::assertSame(0, $this->svc->sweep()['unconfirmed']);
    }

    /** Every reminder must offer a way to stop receiving them. */
    public function testEveryReminderCanBeUnsubscribedFrom(): void
    {
        $this->oldExpense(10000, 40);
        $this->pendingSettlement(5);

        $this->svc->sweep();

        self::assertNotEmpty($this->mailer->sent);
        foreach ($this->mailer->sent as $m) {
            self::assertStringContainsString('/notify/unsubscribe?u=', $m['body']);
        }
    }
}
