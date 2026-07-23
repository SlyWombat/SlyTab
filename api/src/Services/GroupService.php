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
        private readonly Mailer $mailer = new Mailer(),
    ) {}

    /** @return array<string,mixed> */
    /** @param list<string> $currencies favorite quick-pick currencies */
    public function create(string $userId, string $name, string $emoji, string $homeCurrency, array $currencies = []): array
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
            'INSERT INTO `groups` (id, name, emoji, home_currency, currencies, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        )->execute([$id, $name, mb_substr($emoji, 0, 8), $homeCurrency,
            json_encode(self::cleanCurrencies($currencies, $homeCurrency), JSON_THROW_ON_ERROR), $userId]);
        $this->pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
            ->execute([$id, $userId]);
        $this->activity->record($id, $userId, 'created', 'group', $id);
        return $this->get($id);
    }

    /**
     * PATCH /groups/{id} — name, emoji, and favorite currencies. The home
     * currency is fixed for life: changing it would re-denominate every
     * balance.
     *
     * @param array<string,mixed> $data @return array<string,mixed>
     */
    public function update(string $groupId, string $userId, array $data): array
    {
        $this->assertMember($groupId, $userId);
        $this->assertWritable($groupId);
        $group = $this->get($groupId);
        $sets = [];
        $args = [];
        if (array_key_exists('name', $data)) {
            $name = trim((string) $data['name']);
            if ($name === '' || mb_strlen($name) > 80) {
                throw new ApiException('VALIDATION', 'group name must be 1-80 characters');
            }
            $sets[] = 'name = ?';
            $args[] = $name;
        }
        if (array_key_exists('emoji', $data)) {
            $sets[] = 'emoji = ?';
            $args[] = mb_substr((string) $data['emoji'], 0, 8);
        }
        if (array_key_exists('currencies', $data)) {
            if (!is_array($data['currencies'])) {
                throw new ApiException('VALIDATION', 'currencies must be a list of 3-letter codes');
            }
            $sets[] = 'currencies = ?';
            $args[] = json_encode(
                self::cleanCurrencies($data['currencies'], $group['homeCurrency']),
                JSON_THROW_ON_ERROR,
            );
        }
        if ($sets !== []) {
            $args[] = $groupId;
            $this->pdo->prepare('UPDATE `groups` SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
            $this->activity->record($groupId, $userId, 'edited', 'group', $groupId);
        }
        return $this->get($groupId);
    }

    /**
     * Favorites: valid ISO-shaped codes, deduped, home currency excluded
     * (it is always offered first anyway), capped at 8.
     *
     * @param list<mixed> $currencies @return list<string>
     */
    private static function cleanCurrencies(array $currencies, string $homeCurrency): array
    {
        $out = [];
        foreach ($currencies as $cur) {
            $cur = strtoupper(trim((string) $cur));
            if (!preg_match(self::CURRENCY_RE, $cur)) {
                throw new ApiException('VALIDATION', 'currencies must be 3-letter codes');
            }
            if ($cur !== $homeCurrency && !in_array($cur, $out, true)) {
                $out[] = $cur;
            }
        }
        return array_slice($out, 0, 8);
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
            'currencies' => json_decode($g['currencies'] ?? '[]', true) ?: [],
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

    /**
     * Mint an invite link; when $email is given, also send it as an email
     * invitation from the inviter (issue #1 item 4).
     *
     * @return array{token:string, expiresAt:string, emailed:bool}
     */
    /**
     * Issue #2: bring someone into the group before they have an account.
     * If the email already belongs to a member, nothing to do; an existing
     * non-member gets added directly (and emailed); an unknown email gets
     * a placeholder account that holds their history until they register
     * (or sign in with Google/Apple) using that email — which claims it.
     *
     * @return string the member's user id (real or placeholder)
     */
    public function addMemberByEmail(string $groupId, string $inviterId, string $email, string $displayName = ''): string
    {
        $this->assertWritable($groupId);
        $email = strtolower(trim($email));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ApiException('VALIDATION', 'a valid email address is required');
        }
        $stmt = $this->pdo->prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL');
        $stmt->execute([$email]);
        $userId = $stmt->fetchColumn();

        if ($userId === false) {
            $userId = Ulid::generate();
            $name = trim($displayName) !== '' ? mb_substr(trim($displayName), 0, 80) : explode('@', $email)[0];
            $this->pdo->prepare(
                'INSERT INTO users (id, email, password_hash, display_name, payment_handles, placeholder_at)
                 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            )->execute([
                $userId, $email,
                password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT),
                $name, '{}',
            ]);
        }

        $member = $this->pdo->prepare(
            'SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
        );
        $member->execute([$groupId, $userId]);
        if ($member->fetchColumn() === false) {
            // Rejoin support: revive an old membership row if one exists.
            $upd = $this->pdo->prepare('UPDATE memberships SET left_at = NULL WHERE group_id = ? AND user_id = ?');
            $upd->execute([$groupId, $userId]);
            if ($upd->rowCount() === 0) {
                $this->pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
                    ->execute([$groupId, $userId]);
            }
            $this->activity->record($groupId, $inviterId, 'added', 'member', (string) $userId);
            $this->createInvite($groupId, $inviterId, $email, historyWaiting: true);
        }
        return (string) $userId;
    }

    public function createInvite(string $groupId, string $userId, ?string $email = null, bool $historyWaiting = false): array
    {
        $this->assertWritable($groupId);
        if ($email !== null && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ApiException('VALIDATION', 'a valid email address is required');
        }
        $token = bin2hex(random_bytes(16));
        $expires = gmdate('Y-m-d H:i:s', time() + self::INVITE_DAYS * 86400);
        $this->pdo->prepare(
            'INSERT INTO invites (id, group_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
        )->execute([Ulid::generate(), $groupId, self::hashInvite($token), $userId, $expires]);

        if ($email !== null) {
            $group = $this->get($groupId);
            $inviter = 'A SlyTab member';
            foreach ($group['members'] as $m) {
                if ($m['id'] === $userId) {
                    $inviter = $m['displayName'];
                }
            }
            $base = Env::get('APP_URL', 'https://electricrv.ca/slytab');
            $this->mailer->send(
                strtolower(trim($email)),
                "{$inviter} invited you to \"{$group['name']}\" on SlyTab",
                "{$inviter} wants to split expenses with you in \"{$group['name']}\".\n\n"
                . ($historyWaiting
                    ? "Your share of the group's expenses is already loaded - create your\n"
                    . "account with this email address and it will all be there.\n\n"
                    : '')
                . "Join here (link works for 7 days):\n\n{$base}/join/{$token}\n\n"
                . "SlyTab is the private expense splitter at {$base} - free, no ads,\n"
                . "no tracking.\n",
            );
        }
        return ['token' => $token, 'expiresAt' => $expires, 'emailed' => $email !== null];
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
