<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\Env;

/**
 * Mail to the owner when something worth knowing happens to the service
 * itself, rather than to one person's expenses (owner, 2026-09-04).
 *
 * Two shapes, and the difference is the whole design:
 *
 *   · once()     — a MILESTONE. Fires exactly once, ever. "You have 10 users"
 *                  is not news twice, and the count is recomputed on every
 *                  signup, so without the memory every later signup re-sends.
 *   · throttled() — a THRESHOLD. Fires at most once per cooldown. The scan
 *                  queue drains in seconds, so a busy minute crosses "over
 *                  five waiting" again and again; a mail per crossing is a
 *                  stampede about a stampede.
 *
 * EVERY PATH HERE IS BEST-EFFORT. These are called from inside a user's
 * request — a signup, a receipt upload — and an alert is never worth failing
 * one of those for. A missing `ops_alerts` table, an MTA that will not take
 * the message, a database that has gone away: all of it is swallowed and
 * logged. The rule is the same one `recordMetrics()` follows, and for the same
 * reason: telemetry that can break the thing it measures is worse than none.
 *
 * Mail goes through the same `mail()` hand-off the rest of the app uses, which
 * returns as soon as the local MTA accepts it — no SMTP round trip on the
 * request. `MAIL_DISABLE` (tests, dev) turns it into a log line.
 */
final class OpsAlertService
{
    /** Over this many waiting and the owner hears about it (owner: "over 5"). */
    public const QUEUE_WAITING_ALERT_OVER = 5;

    /** An hour between queue alerts: enough to say "it got busy", not a pager. */
    public const QUEUE_ALERT_COOLDOWN_SECONDS = 3600;

    /** Signup counts worth an email, each exactly once (owner: 10 and 100). */
    public const USER_MILESTONES = [10, 100];

    public function __construct(
        private readonly PDO $pdo,
        private readonly ?Mailer $mailer = null,
    ) {}

    /**
     * The scan queue went over the threshold. Called from ScanQueue::admit()
     * when a ticket has just been created, so `$waiting` is a count that
     * already includes the person who caused it.
     */
    public function scanQueueDeep(int $waiting): void
    {
        if ($waiting <= self::QUEUE_WAITING_ALERT_OVER) {
            return;
        }
        $this->throttled(
            'scan_queue_deep',
            self::QUEUE_ALERT_COOLDOWN_SECONDS,
            "SlyTab: {$waiting} people are waiting to scan a receipt",
            "{$waiting} receipts are queued for the reader right now — more than the "
            . self::QUEUE_WAITING_ALERT_OVER . " this alerts above.\n\n"
            . "That is a lot of real people scanning at once for a beta this size, so it is\n"
            . "either good news or a stuck queue. The reader serves one receipt at a time at\n"
            . "roughly 3 seconds each, so a line this long clears in well under a minute; if\n"
            . "it is still long when you read this, something is not draining.\n\n"
            . "Where to look:\n"
            . "  - https://electricrv.ca/slytab/api/v1/capabilities — is the reader up at all\n"
            . "  - the door's /slytab/status — are both backends healthy\n"
            . "  - docs/llm-requirements.md — one parse at a time is by design, not a fault\n\n"
            . "You will not get another of these for an hour, however busy it stays.",
        );
    }

    /**
     * Have we just crossed a signup milestone? Called after a registration of
     * any kind — password, Google, Apple, or a placeholder claiming its
     * account, which is a signup too.
     *
     * Counts REAL people, using the same definition the metrics dashboard
     * uses. An alert that says 10 while the dashboard says 7 is worse than no
     * alert, so the two must never drift apart.
     */
    public function userMilestone(): void
    {
        try {
            $count = (int) $this->pdo->query(
                'SELECT COUNT(*) FROM users
                  WHERE deleted_at IS NULL AND placeholder_at IS NULL AND is_test = 0',
            )->fetchColumn();
        } catch (\Throwable $e) {
            error_log('ops alert: could not count users: ' . $e->getMessage());
            return;
        }

        // Every threshold at or below the count, not just the one we landed
        // on: a milestone added later, or a count that jumped, still gets its
        // one mail rather than being skipped for ever.
        foreach (self::USER_MILESTONES as $milestone) {
            if ($count < $milestone) {
                continue;
            }
            $this->once(
                "users_{$milestone}",
                "SlyTab has {$milestone} people signed up",
                "SlyTab just passed {$milestone} real signups — {$count} accounts, not counting\n"
                . "placeholders, test accounts or deleted ones (the same count the metrics\n"
                . "dashboard shows).\n\n"
                . ($milestone >= 100
                    ? "At this size the things that were comfortable at ten are worth re-checking:\n"
                      . "the receipt reader still serves one scan at a time (~19/minute), and the\n"
                      . "queue refuses past 26 people at once. See docs/llm-requirements.md.\n\n"
                    : '')
                . "This is a one-off — you will not get another mail for {$milestone}.",
            );
        }
    }

    // ------------------------------------------------------------------ guts

    /** Fire once, ever, for this key. */
    private function once(string $key, string $subject, string $body): void
    {
        try {
            // INSERT IGNORE against the primary key: the row either appears
            // (ours to send) or it does not (someone already did). Atomic, no
            // transaction, no read-then-write race between two signups.
            $stmt = $this->pdo->prepare(
                'INSERT IGNORE INTO ops_alerts (alert_key, first_fired_at, last_fired_at, times)
                 VALUES (?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)',
            );
            $stmt->execute([$key]);
            if ($stmt->rowCount() === 1) {
                $this->send($subject, $body);
            }
        } catch (\Throwable $e) {
            error_log("ops alert {$key} failed: " . $e->getMessage());
        }
    }

    /** Fire at most once per `$cooldown` seconds for this key. */
    private function throttled(string $key, int $cooldown, string $subject, string $body): void
    {
        try {
            // Claim the slot with a conditional UPDATE first: it matches only
            // if the cooldown has expired, so exactly one caller wins.
            $upd = $this->pdo->prepare(
                'UPDATE ops_alerts
                    SET last_fired_at = UTC_TIMESTAMP(3), times = times + 1
                  WHERE alert_key = ?
                    AND last_fired_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND',
            );
            $upd->execute([$key, $cooldown]);
            if ($upd->rowCount() === 1) {
                $this->send($subject, $body);
                return;
            }
            // No row updated: either it is not due yet, or this key has never
            // fired. INSERT IGNORE tells the two apart without a read.
            $ins = $this->pdo->prepare(
                'INSERT IGNORE INTO ops_alerts (alert_key, first_fired_at, last_fired_at, times)
                 VALUES (?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)',
            );
            $ins->execute([$key]);
            if ($ins->rowCount() === 1) {
                $this->send($subject, $body);
            }
        } catch (\Throwable $e) {
            error_log("ops alert {$key} failed: " . $e->getMessage());
        }
    }

    private function send(string $subject, string $body): void
    {
        $to = Env::get('OPS_ALERT_EMAIL', Env::get('BUG_REPORT_EMAIL', 'dave@drscapital.com'));
        if ($to === '') {
            return;
        }
        // send(), not dispatch(): if the MTA will not take an alert we want
        // that in the log, because nobody is going to notice its absence.
        ($this->mailer ?? new Mailer())->send($to, $subject, $body . "\n\n— SlyTab\n");
    }
}
