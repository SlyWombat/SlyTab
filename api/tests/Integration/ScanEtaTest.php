<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\ReceiptService;
use SlyTab\Support\Ulid;

/**
 * "About N seconds" has to be about how long it takes NOW (#123, FR-4.10).
 *
 * The reader's speed is a property of the hardware behind the door, and that
 * hardware changes. On 2026-09-03 it moved from kdocker2's iGPU to kdocker3's
 * R9700 and a receipt went from ~19 s to ~3.2 s (#124). The estimate was a
 * median over the last 20 parses of all time, so the app kept promising people
 * "about 19s" for something that finished in three — a stale number wearing
 * feedback's clothes, and the queue's position/ETA is the whole point of the
 * fair line.
 */
final class ScanEtaTest extends TestCase
{
    private static ?\PDO $pdo = null;

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
        self::$pdo->exec('DELETE FROM receipt_metrics');
    }

    /** @param int $daysAgo 0 = now */
    private static function record(int $parseMs, int $daysAgo, string $outcome = 'parsed'): void
    {
        self::$pdo->prepare(
            'INSERT INTO receipt_metrics (id, receipt_id, group_id, upload_bytes, normalized_bytes,
                                          normalize_ms, engine, parse_ms, outcome, confidence, error, created_at)
             VALUES (?, ?, ?, 1000, 1000, 1, ?, ?, ?, ?, NULL,
                     UTC_TIMESTAMP() - INTERVAL ? DAY)',
        )->execute([
            Ulid::generate(), Ulid::generate(), Ulid::generate(),
            'local', $parseMs, $outcome, 'high', $daysAgo,
        ]);
    }

    /**
     * The case that actually happened: months of slow parses, then the box
     * changes and a handful of fast ones arrive. The estimate must follow the
     * new hardware, not average it with hardware we no longer run on.
     */
    public function testAHardwareChangeMovesTheEstimateWithinAFewScans(): void
    {
        for ($i = 0; $i < 20; $i++) {
            self::record(19000, 30);          // the iGPU era, a month ago
        }
        for ($i = 0; $i < 4; $i++) {
            self::record(3200, 0);            // the R9700, today
        }

        $eta = ReceiptService::eta(self::$pdo);
        self::assertSame(4, $eta['samples'], 'only the recent parses should count');
        self::assertSame(3200, $eta['typicalMs']);
    }

    /** With nothing recent at all, an old number still beats no number. */
    public function testItFallsBackToOlderSamplesWhenTheWeekIsEmpty(): void
    {
        for ($i = 0; $i < 5; $i++) {
            self::record(19000, 30);
        }
        $eta = ReceiptService::eta(self::$pdo);
        self::assertSame(5, $eta['samples']);
        self::assertSame(19000, $eta['typicalMs']);
    }

    /** One or two recent samples are not a median; keep the longer history. */
    public function testASingleRecentSampleDoesNotSpeakForTheWholeReader(): void
    {
        for ($i = 0; $i < 5; $i++) {
            self::record(19000, 30);
        }
        self::record(3200, 0);
        $eta = ReceiptService::eta(self::$pdo);
        self::assertSame(6, $eta['samples'], 'too few recent samples — fall back to the last ten');
        self::assertSame(19000, $eta['typicalMs']);
    }

    /** No history at all is a static guess, not a division by zero. */
    public function testNoHistoryGivesTheStaticDefault(): void
    {
        $eta = ReceiptService::eta(self::$pdo);
        self::assertSame(0, $eta['samples']);
        self::assertSame(15000, $eta['typicalMs']);
        self::assertSame(40000, $eta['slowMs']);
    }

    /** A parse that failed took no time worth quoting; it must not drag the median. */
    public function testFailuresAndZeroesAreNotSamples(): void
    {
        for ($i = 0; $i < 4; $i++) {
            self::record(3200, 0);
        }
        self::record(0, 0, 'failed');
        self::record(90000, 0, 'failed');
        $eta = ReceiptService::eta(self::$pdo);
        self::assertSame(4, $eta['samples']);
        self::assertSame(3200, $eta['typicalMs']);
    }
}
