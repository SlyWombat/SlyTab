<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\Mailer;
use SlyTab\Services\OpsAlertService;
use SlyTab\Support\Ulid;

/**
 * Alerts to the owner about the service itself (owner, 2026-09-04: tell me if
 * more than five people are ever waiting to scan, and when we reach 10 and 100
 * signups).
 *
 * What these pin down is the *not sending*: an alert that repeats is an alert
 * that gets filtered into a folder and then missed when it matters. A
 * milestone must fire exactly once ever, and a threshold at most once per
 * cooldown, however many times the condition is met in between.
 */
final class OpsAlertTest extends TestCase
{
    private static ?\PDO $pdo = null;
    private OpsCapturingMailer $mail;

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
        self::$pdo->exec('DELETE FROM ops_alerts');
        self::$pdo->exec('DELETE FROM users');
        $this->mail = new OpsCapturingMailer();
    }

    private function svc(): OpsAlertService
    {
        return new OpsAlertService(self::$pdo, $this->mail);
    }

    private static function addUsers(int $n, string $flavour = 'real'): void
    {
        for ($i = 0; $i < $n; $i++) {
            $id = Ulid::generate();
            self::$pdo->prepare(
                'INSERT INTO users (id, email, password_hash, display_name, payment_handles,
                                    is_test, placeholder_at, deleted_at)
                 VALUES (?, ?, "x", "Someone", "{}", ?, ?, ?)',
            )->execute([
                $id,
                $id . '@example.com',
                $flavour === 'test' ? 1 : 0,
                $flavour === 'placeholder' ? '2026-01-01 00:00:00' : null,
                $flavour === 'deleted' ? '2026-01-01 00:00:00' : null,
            ]);
        }
    }

    // ------------------------------------------------------------ milestones

    public function testTheTenthSignupSendsOneMailAndTheEleventhSendsNone(): void
    {
        self::addUsers(9);
        $this->svc()->userMilestone();
        self::assertSame([], $this->mail->sent, 'nine is not ten');

        self::addUsers(1);
        $this->svc()->userMilestone();
        self::assertCount(1, $this->mail->sent);
        self::assertStringContainsString('10 people signed up', $this->mail->sent[0]['subject']);

        // Every later signup recomputes the count and must stay quiet.
        for ($i = 0; $i < 5; $i++) {
            self::addUsers(1);
            $this->svc()->userMilestone();
        }
        self::assertCount(1, $this->mail->sent, 'a milestone is news exactly once');
    }

    /** 100 is its own milestone and must still fire after 10 already has. */
    public function testTheHundredthIsASecondSeparateMilestone(): void
    {
        self::addUsers(100);
        $this->svc()->userMilestone();
        $subjects = array_column($this->mail->sent, 'subject');
        self::assertCount(2, $subjects, 'crossing both at once owes both mails');
        self::assertStringContainsString('10 people', $subjects[0]);
        self::assertStringContainsString('100 people', $subjects[1]);
    }

    /**
     * The count has to mean what the metrics dashboard means, or the alert
     * says 10 while the dashboard says 7 and neither can be trusted again.
     */
    public function testPlaceholdersTestAccountsAndDeletedPeopleAreNotSignups(): void
    {
        self::addUsers(9);
        self::addUsers(4, 'placeholder');
        self::addUsers(4, 'test');
        self::addUsers(4, 'deleted');
        $this->svc()->userMilestone();
        self::assertSame([], $this->mail->sent, 'only real, live, non-test accounts count');

        self::addUsers(1);
        $this->svc()->userMilestone();
        self::assertCount(1, $this->mail->sent);
    }

    // --------------------------------------------------------- queue depth

    public function testTheQueueAlertsOnlyWhenItIsOverFive(): void
    {
        $this->svc()->scanQueueDeep(5);
        self::assertSame([], $this->mail->sent, 'five is not over five');

        $this->svc()->scanQueueDeep(6);
        self::assertCount(1, $this->mail->sent);
        self::assertStringContainsString('6 people are waiting', $this->mail->sent[0]['subject']);
    }

    /**
     * The queue drains in seconds, so a busy minute crosses the threshold over
     * and over. One mail an hour, not one per crossing.
     */
    public function testABusyMinuteIsOneMailNotTwenty(): void
    {
        for ($i = 0; $i < 20; $i++) {
            $this->svc()->scanQueueDeep(6 + $i);
        }
        self::assertCount(1, $this->mail->sent);
    }

    /** Once the cooldown has passed it is news again. */
    public function testItAlertsAgainAfterTheCooldown(): void
    {
        $this->svc()->scanQueueDeep(6);
        self::assertCount(1, $this->mail->sent);

        self::$pdo->prepare(
            'UPDATE ops_alerts SET last_fired_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND
              WHERE alert_key = "scan_queue_deep"',
        )->execute([OpsAlertService::QUEUE_ALERT_COOLDOWN_SECONDS + 60]);

        $this->svc()->scanQueueDeep(7);
        self::assertCount(2, $this->mail->sent);
        self::assertSame(
            2,
            (int) self::$pdo->query('SELECT times FROM ops_alerts WHERE alert_key = "scan_queue_deep"')
                ->fetchColumn(),
        );
    }

    // -------------------------------------------------------------- safety

    /**
     * These run inside a signup and inside a receipt upload. Neither is worth
     * failing for an email, so a broken alert path must be silent, not fatal.
     */
    public function testAMissingTableCannotBreakTheRequestItRunsIn(): void
    {
        self::$pdo->exec('DROP TABLE ops_alerts');
        try {
            $this->svc()->scanQueueDeep(9);
            self::addUsers(10);
            $this->svc()->userMilestone();
            self::assertSame([], $this->mail->sent);
        } finally {
            (new Migrator(self::$pdo))->fresh();
        }
    }
}

/** Captures instead of mailing, so the tests assert on what would be sent. */
final class OpsCapturingMailer extends Mailer
{
    /** @var list<array{to:string, subject:string, body:string}> */
    public array $sent = [];

    public function send(string $to, string $subject, string $body): void
    {
        $this->sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
    }
}
