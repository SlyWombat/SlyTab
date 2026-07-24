<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\Env;

/**
 * Push notifications (issue #3) via the Expo push API — no key needed.
 * Best-effort: failures are logged, never surfaced to the caller. The
 * per-user notify_level gates delivery: 'all', 'important' (settlements
 * and invites only), or 'none'.
 */
class NotificationService
{
    private const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
    private const IMPORTANT = ['settlement_in', 'settlement_confirmed', 'settlement_declined', 'joined'];

    public function __construct(private readonly PDO $pdo) {}

    public function registerToken(string $userId, string $token): void
    {
        if (!preg_match('/^(ExponentPushToken|ExpoPushToken)\[[\w-]+\]$/', $token)) {
            return; // not an Expo token — ignore quietly
        }
        $this->pdo->prepare(
            'INSERT INTO push_tokens (token, user_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), created_at = CURRENT_TIMESTAMP',
        )->execute([$token, $userId]);
    }

    /**
     * Notify every group member except the actor.
     * @param list<string>|null $onlyUserIds restrict recipients
     */
    public function notifyGroup(
        string $groupId,
        string $actorId,
        string $kind,
        string $title,
        string $body,
        ?array $onlyUserIds = null,
    ): void {
        try {
            $stmt = $this->pdo->prepare(
                'SELECT u.id, u.notify_level, t.token
                 FROM memberships m
                 JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
                 JOIN push_tokens t ON t.user_id = u.id
                 WHERE m.group_id = ? AND m.left_at IS NULL AND m.user_id != ?',
            );
            $stmt->execute([$groupId, $actorId]);
            $messages = [];
            foreach ($stmt->fetchAll() as $r) {
                if ($onlyUserIds !== null && !in_array($r['id'], $onlyUserIds, true)) {
                    continue;
                }
                if ($r['notify_level'] === 'none') {
                    continue;
                }
                if ($r['notify_level'] === 'important' && !in_array($kind, self::IMPORTANT, true)) {
                    continue;
                }
                $messages[] = [
                    'to' => $r['token'],
                    'title' => $title,
                    'body' => $body,
                    'sound' => 'default',
                    'data' => ['groupId' => $groupId, 'kind' => $kind],
                ];
            }
            if ($messages !== []) {
                $this->send($messages);
            }
        } catch (\Throwable $e) {
            error_log('push notify failed: ' . $e->getMessage());
        }
    }

    /** @param list<array<string,mixed>> $messages */
    protected function send(array $messages): void
    {
        if (Env::get('PUSH_DISABLE') !== '') {
            return;
        }
        $ch = curl_init(self::EXPO_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($messages, JSON_THROW_ON_ERROR),
            CURLOPT_TIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
        // Prune tokens Expo reports as dead.
        if (is_string($raw)) {
            $resp = json_decode($raw, true);
            foreach (($resp['data'] ?? []) as $i => $r) {
                if (($r['details']['error'] ?? '') === 'DeviceNotRegistered' && isset($messages[$i]['to'])) {
                    $this->pdo->prepare('DELETE FROM push_tokens WHERE token = ?')->execute([$messages[$i]['to']]);
                }
            }
        }
    }
}
