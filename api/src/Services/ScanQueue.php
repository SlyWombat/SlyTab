<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Who gets to scan next (#123, requirement 2).
 *
 * Two things live here: the SLOTS, which are how many receipts may be at the
 * model at once, and the LINE, which is who is waiting for one and in what
 * order.
 *
 * SLOTS are flock()ed files, one per backend (`LOCAL_LLM_PARALLEL`, default
 * 1). flock is the right primitive because the kernel releases it when the
 * process dies: a crashed parse cannot leave a slot wedged, which a database
 * flag could. A slot is held for exactly the duration of one parse.
 *
 * THE LINE is a table of tickets. This API runs on shared hosting with no
 * worker process — nothing can sit and wait on a user's behalf, and holding a
 * PHP request open while waiting is what took the whole app down with 508s
 * (see ReceiptService::ingest). So the line is stateless from the server's
 * side: a client that cannot be admitted is given a ticket and a time to ask
 * again; each time it asks, its ticket is refreshed and it is told its
 * position. Turns go oldest ticket first. A ticket nobody has refreshed in
 * TICKET_TTL_SECONDS belongs to someone who left, and is purged so the people
 * behind them are not stuck behind a ghost.
 *
 * The client's job is the visible half: show "2 ahead · about 40 s", ask
 * again when told to, and turn the whole thing into a scan that simply took a
 * little longer. Fails OPEN like the old lock did: if the lock directory is
 * unwritable the parse proceeds unguarded and says so in the log.
 */
final class ScanQueue
{
    /** A client that has not asked again in this long has gone away. */
    public const TICKET_TTL_SECONDS = 45;

    /** Beyond this the honest answer is "not now", not "you are 40th". */
    public const MAX_WAITING = 25;

    public function __construct(
        private readonly PDO $pdo,
        private readonly ?string $lockDir = null,
    ) {}

    /** How many receipts may be at the model at once — one per backend. */
    public static function slots(): int
    {
        return max(1, min(16, (int) Env::get('LOCAL_LLM_PARALLEL', '1')));
    }

    /**
     * Ask for a turn.
     *
     * Returns a held slot (`slot` is a resource — pass it to release() when the
     * parse is done) OR a `queued` payload for the client, never both.
     *
     * @param ?string $ticket the ticket this client was given last time, if any
     * @return array{slot: resource|null, queued: array<string,mixed>|null}
     */
    public function admit(string $receiptId, string $userId, ?string $ticket, int $typicalMs): array
    {
        $this->purge();
        $mine = $this->find($receiptId, $userId, $ticket);
        $ahead = $this->countAhead($mine);

        if ($ahead === 0) {
            $slot = $this->acquireSlot();
            if ($slot !== null) {
                if ($mine !== null) {
                    $this->pdo->prepare('DELETE FROM scan_queue WHERE ticket = ?')->execute([$mine['ticket']]);
                }
                return ['slot' => $slot, 'queued' => null];
            }
        }

        // Not our turn: either people are ahead, or every backend is busy.
        if ($mine === null) {
            if ($this->waiting() >= self::MAX_WAITING) {
                throw new ApiException(
                    'SCAN_BUSY',
                    'too many receipts are waiting to be read right now — the photo is attached, try Rescan in a few minutes',
                    429,
                );
            }
            $mine = [
                'ticket' => Ulid::generate(),
                'receipt_id' => $receiptId,
                'user_id' => $userId,
            ];
            $this->pdo->prepare(
                'INSERT INTO scan_queue (ticket, receipt_id, user_id, created_at, last_seen_at)
                 VALUES (?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
            )->execute([$mine['ticket'], $receiptId, $userId]);
        } else {
            $this->pdo->prepare('UPDATE scan_queue SET last_seen_at = UTC_TIMESTAMP(3) WHERE ticket = ?')
                ->execute([$mine['ticket']]);
        }

        $slots = self::slots();
        $inFlight = $this->busySlots();
        // Rounds of the model until this receipt is DONE: everyone ahead plus
        // whatever is in flight now, spread over the backends, then our own
        // parse. Honest rather than precise — typicalMs is a median and the
        // in-flight parse is part way through — and the client says "about".
        $rounds = intdiv($ahead + $inFlight, $slots) + 1;
        return ['slot' => null, 'queued' => [
            'ticket' => $mine['ticket'],
            'position' => $ahead + 1,
            'ahead' => $ahead,
            'inFlight' => $inFlight,
            'slots' => $slots,
            'etaMs' => $rounds * $typicalMs,
            // Ask again well inside the TTL, sooner when next in line. Polls
            // are cheap (no parse, no cost-guard charge), so erring quick is
            // fine; a slot sitting idle while the next person waits to ask is
            // the cost of quiet.
            'retryAfterMs' => $ahead === 0
                ? max(2500, min(6000, intdiv($typicalMs, 3)))
                : max(5000, min(12000, intdiv($typicalMs, 2))),
        ]];
    }

    /** @param resource $slot */
    public function release($slot): void
    {
        if (is_resource($slot)) {
            flock($slot, LOCK_UN);
            fclose($slot);
        }
    }

    /** The client gave up: let the people behind move up now, not in 45 s. */
    public function cancel(string $ticket, string $userId): void
    {
        $this->pdo->prepare('DELETE FROM scan_queue WHERE ticket = ? AND user_id = ?')->execute([$ticket, $userId]);
    }

    /** Live tickets, all of them. */
    public function waiting(): int
    {
        return (int) $this->pdo->query('SELECT COUNT(*) FROM scan_queue')->fetchColumn();
    }

    /** Slots currently held by a parse, measured by trying each lock. */
    public function busySlots(): int
    {
        $busy = 0;
        for ($i = 0; $i < self::slots(); $i++) {
            $fh = @fopen($this->lockPath($i), 'c');
            if ($fh === false) {
                continue;
            }
            if (flock($fh, LOCK_EX | LOCK_NB)) {
                flock($fh, LOCK_UN);
            } else {
                $busy++;
            }
            fclose($fh);
        }
        return $busy;
    }

    // ------------------------------------------------------------------ line

    private function purge(): void
    {
        $this->pdo->prepare(
            'DELETE FROM scan_queue WHERE last_seen_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND)',
        )->execute([self::TICKET_TTL_SECONDS]);
    }

    /**
     * This client's ticket, if it has one. A ticket is honoured only for the
     * receipt and person it was issued to — a ticket string is not a
     * credential, and a receipt has at most one place in line.
     *
     * @return array{ticket: string, receipt_id: string, user_id: string}|null
     */
    private function find(string $receiptId, string $userId, ?string $ticket): ?array
    {
        $stmt = $this->pdo->prepare(
            'SELECT ticket, receipt_id, user_id FROM scan_queue WHERE receipt_id = ? AND user_id = ? ORDER BY created_at LIMIT 1',
        );
        $stmt->execute([$receiptId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        // A stale or foreign $ticket is simply ignored: the receipt's real place
        // in line wins, so a client cannot jump the queue by editing a string.
        return ['ticket' => $row['ticket'], 'receipt_id' => $row['receipt_id'], 'user_id' => $row['user_id']];
    }

    /** Live tickets that were issued before ours — or all of them, if we hold none. */
    private function countAhead(?array $mine): int
    {
        if ($mine === null) {
            return $this->waiting();
        }
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) FROM scan_queue WHERE created_at < (SELECT created_at FROM scan_queue WHERE ticket = ?)',
        );
        $stmt->execute([$mine['ticket']]);
        return (int) $stmt->fetchColumn();
    }

    // ----------------------------------------------------------------- slots

    /** @return resource|null a held lock, or null when every slot is taken */
    private function acquireSlot()
    {
        $anyOpened = false;
        for ($i = 0; $i < self::slots(); $i++) {
            $fh = @fopen($this->lockPath($i), 'c');
            if ($fh === false) {
                continue;
            }
            $anyOpened = true;
            if (flock($fh, LOCK_EX | LOCK_NB)) {
                return $fh;
            }
            fclose($fh);
        }
        if (!$anyOpened) {
            // Fail OPEN, as the old single lock did: a guard that cannot be
            // taken must not become an outage of its own.
            error_log('receipt parse slots unavailable under ' . $this->dir() . ' — parsing unguarded');
            return tmpfile() ?: null;
        }
        return null;
    }

    private function lockPath(int $slot): string
    {
        // Slot 0 keeps the pre-queue file name so an in-flight parse across a
        // deploy still excludes the next one.
        return $this->dir() . ($slot === 0 ? '/receipt-parse.lock' : "/receipt-parse.{$slot}.lock");
    }

    private function dir(): string
    {
        return rtrim($this->lockDir ?? Env::get('DATA_DIR', dirname(__DIR__, 3) . '/slytab-data'), '/');
    }
}
