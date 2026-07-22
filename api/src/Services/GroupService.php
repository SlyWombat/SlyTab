<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/** Groups, membership, invites — FR-2.x. Friends are 2-person groups. */
final class GroupService
{
    private const INVITE_DAYS = 7;
    private const CURRENCY_RE = '/^[A-Z]{3}$/';

    public function __construct(
        private readonly PDO $pdo,
        private readonly ActivityService $activity,
    ) {}

    /** @return array<string,mixed> */
    public function create(string $userId, string $name, string $emoji, string $homeCurrency): array
    {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 80) {
            throw new ApiException('VALIDATION', 'group name must be 1-80 characters');
        }
        if (!preg_match(self::CURRENCY_RE, $homeCurrency)) {
            throw new ApiException('VALIDATION', 'home currency must be a 3-letter code');
        }
        $id = Ulid::generate();
        $this->pdo->prepare(
            'INSERT INTO `groups` (id, name, emoji, home_currency, created_by) VALUES (?, ?, ?, ?, ?)',
        )->execute([$id, $name, mb_substr($emoji, 0, 8), $homeCurrency, $userId]);
        $this->pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
            ->execute([$id, $userId]);
        $this->activity->record($id, $userId, 'created', 'group', $id);
        return $this->get($id);
    }

    /** @return array<string,mixed> group + active members */
    public function get(string $groupId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM `groups` WHERE id = ?');
        $stmt->execute([$groupId]);
        $g = $stmt->fetch();
        if (!$g) {
            throw new ApiException('NOT_FOUND', 'group not found', 404);
        }
        $m = $this->pdo->prepare(
            'SELECT u.id, u.display_name, u.avatar, u.payment_handles
             FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.joined_at',
        );
        $m->execute([$groupId]);
        return [
            'id' => $g['id'],
            'name' => $g['name'],
            'emoji' => $g['emoji'],
            'homeCurrency' => $g['home_currency'],
            'isDirect' => (bool) $g['is_direct'],
            'archivedAt' => $g['archived_at'],
            'members' => array_map(static fn(array $u): array => [
                'id' => $u['id'],
                'displayName' => $u['display_name'],
                'avatar' => $u['avatar'],
                'paymentHandles' => json_decode($u['payment_handles'] ?: '{}', true),
            ], $m->fetchAll()),
        ];
    }

    /** @return list<array<string,mixed>> */
    public function listForUser(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT group_id FROM memberships WHERE user_id = ? AND left_at IS NULL ORDER BY joined_at DESC',
        );
        $stmt->execute([$userId]);
        return array_map(fn(string $id): array => $this->get($id), $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    public function assertMember(string $groupId, string $userId): void
    {
        $stmt = $this->pdo->prepare(
            'SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
        );
        $stmt->execute([$groupId, $userId]);
        if ($stmt->fetchColumn() === false) {
            throw new ApiException('FORBIDDEN', 'you are not a member of this group', 403);
        }
    }

    /** Like assertMember, but for expense/settlement participants (422). */
    public function assertMemberParticipant(string $groupId, string $userId): void
    {
        $stmt = $this->pdo->prepare(
            'SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
        );
        $stmt->execute([$groupId, $userId]);
        if ($stmt->fetchColumn() === false) {
            throw new ApiException('VALIDATION', 'all participants must be active group members', 422);
        }
    }

    public function assertWritable(string $groupId): void
    {
        $stmt = $this->pdo->prepare('SELECT archived_at FROM `groups` WHERE id = ?');
        $stmt->execute([$groupId]);
        $archived = $stmt->fetchColumn();
        if ($archived === false) {
            throw new ApiException('NOT_FOUND', 'group not found', 404);
        }
        if ($archived !== null) {
            throw new ApiException('GROUP_ARCHIVED', 'this group is archived (read-only)', 409);
        }
    }

    /** @return array{token:string, expiresAt:string} */
    public function createInvite(string $groupId, string $userId): array
    {
        $this->assertWritable($groupId);
        $token = bin2hex(random_bytes(16));
        $expires = gmdate('Y-m-d H:i:s', time() + self::INVITE_DAYS * 86400);
        $this->pdo->prepare(
            'INSERT INTO invites (id, group_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
        )->execute([Ulid::generate(), $groupId, self::hashInvite($token), $userId, $expires]);
        return ['token' => $token, 'expiresAt' => $expires];
    }

    /** @return array<string,mixed> the joined group */
    public function join(string $token, string $userId): array
    {
        $stmt = $this->pdo->prepare('SELECT group_id, expires_at FROM invites WHERE token_hash = ?');
        $stmt->execute([self::hashInvite($token)]);
        $invite = $stmt->fetch();
        if (!$invite || $invite['expires_at'] <= Db::now()) {
            throw new ApiException('INVITE_INVALID', 'this invite link has expired or been revoked', 410);
        }
        $groupId = $invite['group_id'];
        $this->assertWritable($groupId);

        $existing = $this->pdo->prepare('SELECT left_at FROM memberships WHERE group_id = ? AND user_id = ?');
        $existing->execute([$groupId, $userId]);
        $row = $existing->fetch();
        if ($row === false) {
            $this->pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
                ->execute([$groupId, $userId]);
            $this->activity->record($groupId, $userId, 'joined', 'group', $groupId);
        } elseif ($row['left_at'] !== null) {
            $this->pdo->prepare('UPDATE memberships SET left_at = NULL, joined_at = ? WHERE group_id = ? AND user_id = ?')
                ->execute([Db::now(), $groupId, $userId]);
            $this->activity->record($groupId, $userId, 'joined', 'group', $groupId);
        }
        return $this->get($groupId);
    }

    /** FR-2.4: leaving requires a zero balance (checked by the caller). */
    public function leave(string $groupId, string $userId): void
    {
        $this->pdo->prepare('UPDATE memberships SET left_at = ? WHERE group_id = ? AND user_id = ? AND left_at IS NULL')
            ->execute([Db::now(), $groupId, $userId]);
        $this->activity->record($groupId, $userId, 'left', 'group', $groupId);
    }

    public function archive(string $groupId, string $userId): void
    {
        $this->pdo->prepare('UPDATE `groups` SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
            ->execute([Db::now(), $groupId]);
        $this->activity->record($groupId, $userId, 'archived', 'group', $groupId);
    }

    private static function hashInvite(string $token): string
    {
        return hash_hmac('sha256', $token, Env::require('INVITE_HMAC_KEY'));
    }
}
