<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Activity alerts by email (issue #77).
 *
 * The counterpart to NotificationService: same events, same notify_level
 * preference, but reaching people who never installed the app. Push cannot
 * do that — its recipient query inner-joins push_tokens, so a member
 * without a device is simply absent from it.
 *
 * Two speeds, because volume differs by kind:
 *  - settlements and joins are rare and time-sensitive → sent immediately;
 *  - expenses and comments arrive in bursts → queued and swept into one
 *    digest per person, so a dinner entered as six expenses is one mail.
 *
 * Best-effort throughout: a mail failure is logged, never surfaced to the
 * caller. Nobody should fail to record an expense because the MTA is down.
 */
class EmailNotificationService
{
    /** Sent the moment they happen; everything else waits for the sweep. */
    private const IMMEDIATE = ['settlement_in', 'settlement_confirmed', 'settlement_declined',
                               'settlement_recorded', 'joined'];

    /** Mirrors NotificationService::IMPORTANT — 'important' means these. */
    private const IMPORTANT = ['settlement_in', 'settlement_confirmed', 'settlement_declined',
                               'settlement_recorded', 'joined'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly Mailer $mailer = new Mailer(),
    ) {}

    /**
     * Record (and for important kinds, send) an alert for every group member
     * except the actor.
     *
     * @param list<string>|null $onlyUserIds restrict recipients
     */
    public function queue(
        string $groupId,
        string $actorId,
        string $kind,
        string $title,
        string $body,
        ?array $onlyUserIds = null,
    ): void {
        try {
            // Deliberately no push_tokens join — reaching the device-less is
            // the entire point of this service.
            $stmt = $this->pdo->prepare(
                'SELECT u.id, u.email, u.notify_level, u.email_verified_at, g.name AS group_name
                 FROM memberships m
                 JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
                 JOIN `groups` g ON g.id = m.group_id
                 WHERE m.group_id = ? AND m.left_at IS NULL AND m.user_id != ?',
            );
            $stmt->execute([$groupId, $actorId]);

            foreach ($stmt->fetchAll() as $r) {
                if ($onlyUserIds !== null && !in_array($r['id'], $onlyUserIds, true)) {
                    continue;
                }
                if (!self::wants($r['notify_level'], $kind)) {
                    continue;
                }
                if (!filter_var((string) $r['email'], FILTER_VALIDATE_EMAIL)) {
                    continue;
                }

                // An unconfirmed address may be a typo for someone outside
                // the group, so it never receives expense descriptions or
                // amounts — only that there is something to look at.
                $confirmed = $r['email_verified_at'] !== null;
                $groupName = (string) ($r['group_name'] ?? '');
                $safeBody = $confirmed ? $body : 'Open SlyTab to see what changed.';
                $safeTitle = $confirmed ? $title : 'New activity in SlyTab';

                $id = Ulid::generate();
                $immediate = in_array($kind, self::IMMEDIATE, true);
                $this->pdo->prepare(
                    'INSERT INTO notification_emails
                        (id, user_id, group_id, kind, title, body, group_name, sent_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ' . ($immediate ? 'UTC_TIMESTAMP()' : 'NULL') . ')',
                )->execute([
                    $id, $r['id'], $groupId, $kind,
                    mb_substr($safeTitle, 0, 200), mb_substr($safeBody, 0, 500), mb_substr($groupName, 0, 120),
                ]);

                if ($immediate) {
                    $this->deliver(
                        (string) $r['email'],
                        (string) $r['id'],
                        $safeTitle,
                        self::oneOffBody($safeTitle, $safeBody, $groupName, (string) $r['id']),
                    );
                }
            }
        } catch (\Throwable $e) {
            error_log('email notify failed: ' . $e->getMessage());
        }
    }

    /**
     * Send one digest per person for everything queued and still unsent.
     *
     * @param int $graceMinutes leave very recent rows alone so a burst of
     *                          expenses lands in one digest rather than two
     * @return int digests sent
     */
    public function flushDigests(int $graceMinutes = 10): int
    {
        $sent = 0;
        try {
            $stmt = $this->pdo->prepare(
                'SELECT n.id, n.user_id, n.title, n.body, n.group_name, u.email
                 FROM notification_emails n
                 JOIN users u ON u.id = n.user_id AND u.deleted_at IS NULL
                 WHERE n.sent_at IS NULL
                   AND n.created_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
                 ORDER BY n.user_id, n.created_at',
            );
            $stmt->execute([max(0, $graceMinutes)]);

            /** @var array<string, array{email: string, ids: list<string>, lines: list<string>, groups: array<string,true>}> $byUser */
            $byUser = [];
            foreach ($stmt->fetchAll() as $r) {
                $uid = (string) $r['user_id'];
                $byUser[$uid] ??= ['email' => (string) $r['email'], 'ids' => [], 'lines' => [], 'groups' => []];
                $byUser[$uid]['ids'][] = (string) $r['id'];
                $group = (string) $r['group_name'];
                $byUser[$uid]['lines'][] = ($group !== '' ? "[{$group}] " : '') . $r['title'] . ' — ' . $r['body'];
                if ($group !== '') {
                    $byUser[$uid]['groups'][$group] = true;
                }
            }

            foreach ($byUser as $uid => $d) {
                if (!filter_var($d['email'], FILTER_VALIDATE_EMAIL)) {
                    $this->markSent($d['ids']); // unmailable: drop it rather than retry forever
                    continue;
                }
                $count = count($d['lines']);
                $groups = array_keys($d['groups']);
                $subject = $count === 1
                    ? 'SlyTab: 1 update'
                    : "SlyTab: {$count} updates" . (count($groups) === 1 ? " in {$groups[0]}" : '');

                $this->deliver($d['email'], $uid, $subject, self::digestBody($d['lines'], $uid));
                $this->markSent($d['ids']);
                $sent++;
            }
        } catch (\Throwable $e) {
            error_log('email digest failed: ' . $e->getMessage());
        }
        return $sent;
    }

    /** @param list<string> $ids */
    private function markSent(array $ids): void
    {
        if ($ids === []) {
            return;
        }
        $in = implode(',', array_fill(0, count($ids), '?'));
        $this->pdo->prepare("UPDATE notification_emails SET sent_at = UTC_TIMESTAMP() WHERE id IN ({$in})")
            ->execute($ids);
    }

    private function deliver(string $to, string $userId, string $subject, string $body): void
    {
        if (!$this->mailer->dispatch($to, $subject, $body)) {
            error_log("email notify: mail() returned false for {$to}");
        }
    }

    /** Does this preference want this kind? Same rules push applies. */
    private static function wants(?string $level, string $kind): bool
    {
        return match ($level) {
            'none' => false,
            'important' => in_array($kind, self::IMPORTANT, true),
            default => true,
        };
    }

    private static function oneOffBody(string $title, string $body, string $group, string $userId): string
    {
        $where = $group !== '' ? " in \"{$group}\"" : '';
        return "{$title}{$where}\n\n{$body}\n\n"
            . 'Open SlyTab: ' . self::appUrl() . "\n\n" . self::footer($userId);
    }

    /** @param list<string> $lines */
    private static function digestBody(array $lines, string $userId): string
    {
        return "Here's what happened in SlyTab:\n\n"
            . implode("\n", array_map(static fn(string $l): string => "  • {$l}", $lines))
            . "\n\nOpen SlyTab: " . self::appUrl() . "\n\n" . self::footer($userId);
    }

    private static function footer(string $userId): string
    {
        return "—\nYou're getting this because you share expenses on SlyTab.\n"
            . 'Change what you hear about, or stop these emails: '
            . self::unsubscribeUrl($userId);
    }

    private static function appUrl(): string
    {
        return Env::get('APP_URL', 'https://electricrv.ca/slytab');
    }

    /** Signed so it works without a login — the recipient may have no account yet. */
    public static function unsubscribeUrl(string $userId): string
    {
        return self::appUrl() . '/api/v1/notify/unsubscribe?u=' . urlencode($userId)
            . '&t=' . self::token($userId);
    }

    public static function token(string $userId): string
    {
        return hash_hmac('sha256', 'unsubscribe:' . $userId, Env::require('INVITE_HMAC_KEY'));
    }

    /** @return bool whether the signature checked out and the preference was set */
    public function unsubscribe(string $userId, string $token): bool
    {
        if ($userId === '' || !hash_equals(self::token($userId), $token)) {
            return false;
        }
        $stmt = $this->pdo->prepare(
            "UPDATE users SET notify_level = 'none' WHERE id = ? AND deleted_at IS NULL",
        );
        $stmt->execute([$userId]);
        return true;
    }
}
