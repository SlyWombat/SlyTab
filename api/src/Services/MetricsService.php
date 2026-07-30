<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;

/**
 * Management metrics for the owner's Homepage dashboard.
 *
 * Every user-facing count excludes accounts flagged `is_test`, deleted
 * accounts, and placeholders (people invited by email who never signed up).
 * That is the whole point: at the time of writing, nine accounts existed and
 * four were real people. A dashboard that says "9" is worse than no dashboard,
 * because it feels like information.
 *
 * Read-only and cheap — a handful of COUNTs against small tables. Safe to poll
 * every minute from a widget.
 */
final class MetricsService
{
    public function __construct(private readonly PDO $pdo) {}

    /** @return array<string, mixed> */
    public function snapshot(): array
    {
        $real = 'deleted_at IS NULL AND placeholder_at IS NULL AND is_test = 0';

        $users = $this->one("SELECT COUNT(*) FROM users WHERE {$real}");
        $verified = $this->one("SELECT COUNT(*) FROM users WHERE {$real} AND email_verified_at IS NOT NULL");
        $active7 = $this->one(
            "SELECT COUNT(DISTINCT s.user_id) FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE u.deleted_at IS NULL AND u.placeholder_at IS NULL AND u.is_test = 0
               AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)",
        );
        $active30 = $this->one(
            "SELECT COUNT(DISTINCT s.user_id) FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE u.deleted_at IS NULL AND u.placeholder_at IS NULL AND u.is_test = 0
               AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)",
        );

        // Expenses and groups are counted only where a real person created
        // them, so a test run cannot inflate the activity figures either.
        $realCreator = "e.created_by IN (SELECT id FROM users WHERE {$real})";
        $expenses = $this->one("SELECT COUNT(*) FROM expenses e WHERE e.deleted_at IS NULL AND {$realCreator}");
        $expenses7 = $this->one(
            "SELECT COUNT(*) FROM expenses e WHERE e.deleted_at IS NULL AND {$realCreator}
               AND e.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)",
        );
        $groups = $this->one(
            "SELECT COUNT(*) FROM `groups` g WHERE g.archived_at IS NULL
               AND g.created_by IN (SELECT id FROM users WHERE {$real})",
        );

        $settlements = $this->one('SELECT COUNT(*) FROM settlements');
        $receipts = $this->one('SELECT COUNT(*) FROM receipts');
        $bugsOpen = $this->one("SELECT COUNT(*) FROM bug_reports WHERE status <> 'closed'");
        $push = $this->one(
            "SELECT COUNT(*) FROM push_tokens t
             WHERE t.user_id IN (SELECT id FROM users WHERE {$real})",
        );

        return [
            'users' => $users,
            'verified' => $verified,
            'active7d' => $active7,
            'active30d' => $active30,
            'groups' => $groups,
            'expenses' => $expenses,
            'expenses7d' => $expenses7,
            'settlements' => $settlements,
            'receipts' => $receipts,
            'openBugReports' => $bugsOpen,
            'pushDevices' => $push,
            // Shown so the dashboard can be honest about what it is hiding
            // rather than quietly dropping rows.
            'excludedTestAccounts' => $this->one(
                'SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND is_test = 1',
            ),
            'generatedAt' => gmdate('c'),
        ];
    }

    private function one(string $sql): int
    {
        return (int) $this->pdo->query($sql)->fetchColumn();
    }
}
