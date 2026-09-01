<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\ScanQueue;
use SlyTab\Support\ApiException;

/**
 * The waiting line for receipt scans (#123, requirement 2).
 *
 * What matters is the order and the honesty of the feedback: the person who
 * asked first goes first, nobody jumps the line by re-uploading or by editing a
 * ticket, and someone who left does not hold everyone else up for ever.
 */
final class ScanQueueTest extends TestCase
{
    private static ?\PDO $pdo = null;
    private string $dir;

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
        self::$pdo->exec('DELETE FROM scan_queue');
        $this->dir = sys_get_temp_dir() . '/slytab-scanq-' . bin2hex(random_bytes(4));
        mkdir($this->dir, 0700, true);
        putenv('LOCAL_LLM_PARALLEL=1');
    }

    protected function tearDown(): void
    {
        putenv('LOCAL_LLM_PARALLEL');
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
    }

    private function queue(): ScanQueue
    {
        return new ScanQueue(self::$pdo, $this->dir);
    }

    /** A distinct 26-char id per seed (ULID alphabet), so "w1" and "w10" never collide. */
    private static function id(string $seed): string
    {
        return strtoupper(substr(md5($seed), 0, 26));
    }

    public function testFirstComerIsAdmittedAndTheNextTwoWaitInOrder(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 20000);
        self::assertNotNull($a['slot'], 'an idle model admits the first receipt');
        self::assertNull($a['queued']);

        $b = $q->admit(self::id('rB'), self::id('uB'), null, 20000);
        self::assertNull($b['slot']);
        self::assertSame(1, $b['queued']['position']);
        self::assertSame(0, $b['queued']['ahead']);
        self::assertSame(1, $b['queued']['inFlight'], 'A is at the model');
        self::assertSame(1, $b['queued']['slots']);
        self::assertSame(40000, $b['queued']['etaMs'], 'until DONE: the parse in flight, then ours');
        self::assertGreaterThanOrEqual(2500, $b['queued']['retryAfterMs']);
        self::assertLessThan(ScanQueue::TICKET_TTL_SECONDS * 1000, $b['queued']['retryAfterMs']);

        $c = $q->admit(self::id('rC'), self::id('uC'), null, 20000);
        self::assertSame(2, $c['queued']['position']);
        self::assertSame(1, $c['queued']['ahead']);
        self::assertSame(60000, $c['queued']['etaMs'], 'A in flight, then B, then ours');

        // A finishes. B asks again with its ticket and gets the slot; C is
        // still behind B until B is actually admitted, then moves up.
        $q->release($a['slot']);
        $c2 = $q->admit(self::id('rC'), self::id('uC'), $c['queued']['ticket'], 20000);
        self::assertNull($c2['slot'], 'C must not overtake B just by asking first');
        self::assertSame(2, $c2['queued']['position']);

        $b2 = $q->admit(self::id('rB'), self::id('uB'), $b['queued']['ticket'], 20000);
        self::assertNotNull($b2['slot']);
        self::assertSame(1, $q->waiting(), 'B left the line when admitted');

        $c3 = $q->admit(self::id('rC'), self::id('uC'), $c['queued']['ticket'], 20000);
        self::assertSame(1, $c3['queued']['position']);
        $q->release($b2['slot']);
        $c4 = $q->admit(self::id('rC'), self::id('uC'), $c['queued']['ticket'], 20000);
        self::assertNotNull($c4['slot']);
        self::assertSame(0, $q->waiting());
        $q->release($c4['slot']);
    }

    /** A free slot is not a free pass: someone already in line goes first. */
    public function testANewcomerQueuesBehindAnExistingTicketEvenWhenTheModelIsIdle(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        $b = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        $q->release($a['slot']);
        self::assertSame(0, $q->busySlots());

        $c = $q->admit(self::id('rC'), self::id('uC'), null, 10000);
        self::assertNull($c['slot']);
        self::assertSame(2, $c['queued']['position']);
        self::assertSame(0, $c['queued']['inFlight']);
        $b2 = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        self::assertNotNull($b2['slot'], 'B, first in line, is admitted on its next ask — ticket or not');
        $q->release($b2['slot']);
    }

    /** Uploading the same receipt again, or asking without the ticket, keeps the same place. */
    public function testAReceiptHoldsOnePlaceInLineHoweverItAsks(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        $b = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        $again = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        $withOddTicket = $q->admit(self::id('rB'), self::id('uB'), self::id('forged'), 10000);
        self::assertSame($b['queued']['ticket'], $again['queued']['ticket']);
        self::assertSame($b['queued']['ticket'], $withOddTicket['queued']['ticket']);
        self::assertSame(1, $q->waiting());
        $q->release($a['slot']);
    }

    public function testCancelLetsThePeopleBehindMoveUp(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        $b = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        $c = $q->admit(self::id('rC'), self::id('uC'), null, 10000);
        self::assertSame(2, $c['queued']['position']);

        $q->cancel($b['queued']['ticket'], self::id('uX'));
        self::assertSame(2, $q->waiting(), 'only the ticket holder may cancel it');
        $q->cancel($b['queued']['ticket'], self::id('uB'));
        self::assertSame(1, $q->admit(self::id('rC'), self::id('uC'), $c['queued']['ticket'], 10000)['queued']['position']);
        $q->release($a['slot']);
    }

    /** A client that stopped asking has gone; it must not hold the line for ever. */
    public function testAStaleTicketIsPurged(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        $b = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        self::$pdo->prepare('UPDATE scan_queue SET last_seen_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND) WHERE ticket = ?')
            ->execute([ScanQueue::TICKET_TTL_SECONDS + 5, $b['queued']['ticket']]);
        $q->release($a['slot']);

        $c = $q->admit(self::id('rC'), self::id('uC'), null, 10000);
        self::assertNotNull($c['slot'], 'B vanished; C is admitted straight away');
        self::assertSame(0, $q->waiting());
        $q->release($c['slot']);
    }

    public function testTwoBackendsAdmitTwoAtOnce(): void
    {
        putenv('LOCAL_LLM_PARALLEL=2');
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        $b = $q->admit(self::id('rB'), self::id('uB'), null, 10000);
        self::assertNotNull($a['slot']);
        self::assertNotNull($b['slot']);
        self::assertSame(2, $q->busySlots());

        $c = $q->admit(self::id('rC'), self::id('uC'), null, 10000);
        self::assertNull($c['slot']);
        self::assertSame(2, $c['queued']['inFlight']);
        self::assertSame(2, $c['queued']['slots']);
        self::assertSame(20000, $c['queued']['etaMs'], 'two in flight over two slots is one round, then ours');
        $q->release($a['slot']);
        $q->release($b['slot']);
    }

    public function testTheLineHasAnEnd(): void
    {
        $q = $this->queue();
        $a = $q->admit(self::id('rA'), self::id('uA'), null, 10000);
        for ($i = 0; $i < ScanQueue::MAX_WAITING; $i++) {
            $q->admit(self::id("w{$i}"), self::id("u{$i}"), null, 10000);
        }
        try {
            $q->admit(self::id('late'), self::id('ulate'), null, 10000);
            self::fail('expected SCAN_BUSY');
        } catch (ApiException $e) {
            self::assertSame('SCAN_BUSY', $e->errorCode);
            self::assertSame(429, $e->status);
        }
        $q->release($a['slot']);
    }
}
