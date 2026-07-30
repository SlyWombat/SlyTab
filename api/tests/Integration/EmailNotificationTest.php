<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\EmailNotificationService;
use SlyTab\Services\Mailer;
use SlyTab\Support\Ulid;

/**
 * Captures dispatch() rather than send() — this service uses the boolean
 * form, and ResetAndLimitsTest already owns the name CapturingMailer.
 */
final class RecordingMailer extends Mailer
{
    /** @var list<array{to: string, subject: string, body: string}> */
    public array $sent = [];

    public function dispatch(string $to, string $subject, string $body): bool
    {
        $this->sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
        return true;
    }
}

/**
 * Issue #77: activity alerts by email, for the members push cannot reach.
 */
final class EmailNotificationTest extends TestCase
{
    private static ?PDO $pdo = null;
    private RecordingMailer $mailer;
    private EmailNotificationService $svc;
    private string $groupId;
    /** @var array<string,string> name => user id */
    private array $users = [];

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
        $pdo->exec('DELETE FROM notification_emails');
        $pdo->exec('DELETE FROM memberships');
        $pdo->exec('DELETE FROM `groups`');
        $pdo->exec('DELETE FROM users');

        $this->mailer = new RecordingMailer();
        $this->svc = new EmailNotificationService($pdo, $this->mailer);

        // Users first: groups.created_by is a foreign key onto them.
        foreach ([
            ['actor', 'actor@example.com', true, 'all'],
            ['confirmed', 'confirmed@example.com', true, 'all'],
            ['unconfirmed', 'unconfirmed@example.com', false, 'all'],
            ['important', 'important@example.com', true, 'important'],
            ['optedout', 'optedout@example.com', true, 'none'],
        ] as [$name, $email, $verified, $level]) {
            $id = Ulid::generate();
            $this->users[$name] = $id;
            $pdo->prepare(
                'INSERT INTO users (id, email, password_hash, display_name, payment_handles,
                                    notify_level, email_verified_at)
                 VALUES (?, ?, ?, ?, ?, ?, ' . ($verified ? 'UTC_TIMESTAMP()' : 'NULL') . ')',
            )->execute([$id, $email, 'x', $name, '{}', $level]);
        }

        $this->groupId = Ulid::generate();
        $pdo->prepare('INSERT INTO `groups` (id, name, home_currency, currencies, created_by)
                       VALUES (?, ?, ?, ?, ?)')
            ->execute([$this->groupId, 'Ski Trip', 'CAD', '["CAD"]', $this->users['actor']]);

        foreach ($this->users as $id) {
            $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
                ->execute([$this->groupId, $id]);
        }
    }

    private function queueExpense(): void
    {
        $this->svc->queue(
            $this->groupId, $this->users['actor'], 'expense_added',
            'Dave added an expense', 'Lift tickets — $240.00',
        );
    }

    /** @return list<string> recipient addresses */
    private function recipients(): array
    {
        return array_map(static fn(array $m): string => $m['to'], $this->mailer->sent);
    }

    public function testChattyKindsAreQueuedNotSentImmediately(): void
    {
        $this->queueExpense();

        self::assertSame([], $this->mailer->sent, 'an added expense must not mail instantly');
        $pending = self::$pdo->query(
            'SELECT COUNT(*) FROM notification_emails WHERE sent_at IS NULL',
        )->fetchColumn();
        // confirmed + unconfirmed; not the actor, not important-only, not opted out
        self::assertSame(2, (int) $pending);
    }

    public function testDigestBatchesManyEventsIntoOneEmail(): void
    {
        $this->queueExpense();
        $this->queueExpense();
        $this->queueExpense();

        $sent = $this->svc->flushDigests(0);

        self::assertSame(2, $sent, 'one digest per person, not one per event');
        $to = $this->recipients();
        sort($to);
        self::assertSame(['confirmed@example.com', 'unconfirmed@example.com'], $to);

        $confirmed = $this->mailer->sent[array_search('confirmed@example.com', $to, true)];
        self::assertStringContainsString('3 updates', $confirmed['subject']);
        self::assertSame(3, substr_count($confirmed['body'], '•'));
    }

    public function testSecondSweepSendsNothingFurther(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);
        $this->mailer->sent = [];

        self::assertSame(0, $this->svc->flushDigests(0), 'already-sent rows must not resend');
    }

    public function testGracePeriodHoldsRecentEventsBack(): void
    {
        $this->queueExpense();

        self::assertSame(0, $this->svc->flushDigests(10), 'a fresh event waits for the burst to settle');
    }

    public function testImportantKindsGoOutImmediately(): void
    {
        $this->svc->queue(
            $this->groupId, $this->users['actor'], 'settlement_in',
            'Dave sent you a payment', 'Confirm it in SlyTab when it arrives.',
            [$this->users['important']],
        );

        self::assertSame(['important@example.com'], $this->recipients());
        // and it is recorded as sent, so the sweep will not send it twice
        self::assertSame(0, $this->svc->flushDigests(0));
    }

    public function testImportantOnlyPreferenceSkipsOrdinaryActivity(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);

        self::assertNotContains('important@example.com', $this->recipients());
    }

    public function testOptingOutStopsEverythingIncludingImportant(): void
    {
        $this->svc->queue(
            $this->groupId, $this->users['actor'], 'settlement_in',
            'Dave sent you a payment', 'Confirm it in SlyTab.',
        );
        $this->svc->flushDigests(0);

        self::assertNotContains('optedout@example.com', $this->recipients());
    }

    public function testTheActorIsNeverToldAboutTheirOwnAction(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);

        self::assertNotContains('actor@example.com', $this->recipients());
    }

    /** An unconfirmed address may be a typo — it must not leak the detail. */
    public function testUnconfirmedAddressesGetNoExpenseDetail(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);

        foreach ($this->mailer->sent as $m) {
            if ($m['to'] === 'unconfirmed@example.com') {
                self::assertStringNotContainsString('Lift tickets', $m['body']);
                self::assertStringNotContainsString('240', $m['body']);
                return;
            }
        }
        self::fail('the unconfirmed member was not emailed at all');
    }

    public function testConfirmedAddressesDoGetTheDetail(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);

        foreach ($this->mailer->sent as $m) {
            if ($m['to'] === 'confirmed@example.com') {
                self::assertStringContainsString('Lift tickets', $m['body']);
                self::assertStringContainsString('Ski Trip', $m['body']);
                return;
            }
        }
        self::fail('the confirmed member was not emailed at all');
    }

    public function testEveryEmailOffersAWayOut(): void
    {
        $this->queueExpense();
        $this->svc->flushDigests(0);

        self::assertNotEmpty($this->mailer->sent);
        foreach ($this->mailer->sent as $m) {
            self::assertStringContainsString('/notify/unsubscribe?u=', $m['body']);
        }
    }

    public function testUnsubscribeLinkSilencesThatPersonOnly(): void
    {
        $id = $this->users['confirmed'];
        self::assertTrue($this->svc->unsubscribe($id, EmailNotificationService::token($id)));

        $level = self::$pdo->query("SELECT notify_level FROM users WHERE id = '{$id}'")->fetchColumn();
        self::assertSame('none', $level);

        $this->queueExpense();
        $this->svc->flushDigests(0);
        self::assertNotContains('confirmed@example.com', $this->recipients());
        self::assertContains('unconfirmed@example.com', $this->recipients());
    }

    public function testAForgedUnsubscribeSignatureIsRejected(): void
    {
        $id = $this->users['confirmed'];

        self::assertFalse($this->svc->unsubscribe($id, 'not-the-real-token'));
        self::assertFalse($this->svc->unsubscribe($id, EmailNotificationService::token('someone-else')));

        $level = self::$pdo->query("SELECT notify_level FROM users WHERE id = '{$id}'")->fetchColumn();
        self::assertSame('all', $level, 'a bad signature must not change anyone\'s settings');
    }

    public function testAMemberWhoLeftIsNotEmailed(): void
    {
        self::$pdo->prepare('UPDATE memberships SET left_at = UTC_TIMESTAMP() WHERE user_id = ?')
            ->execute([$this->users['confirmed']]);

        $this->queueExpense();
        $this->svc->flushDigests(0);

        self::assertNotContains('confirmed@example.com', $this->recipients());
    }
}
