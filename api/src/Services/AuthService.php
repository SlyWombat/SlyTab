<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Accounts and sessions — FR-1.x. Passwords are argon2id; session tokens
 * are 256-bit opaque values stored only as peppered HMAC-SHA256 hashes.
 */
final class AuthService
{
    private const SESSION_DAYS = 180;
    private const MIN_PASSWORD_LENGTH = 10;

    public function __construct(private readonly PDO $pdo) {}

    /** @return array{token:string, user:array<string,mixed>} */
    public function register(string $email, string $password, string $displayName, string $deviceLabel = ''): array
    {
        $email = strtolower(trim($email));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ApiException('VALIDATION', 'a valid email address is required');
        }
        if (strlen($password) < self::MIN_PASSWORD_LENGTH) {
            throw new ApiException('VALIDATION', 'password must be at least 10 characters');
        }
        $displayName = trim($displayName);
        if ($displayName === '' || mb_strlen($displayName) > 80) {
            throw new ApiException('VALIDATION', 'display name must be 1-80 characters');
        }

        $id = Ulid::generate();
        try {
            $this->pdo->prepare(
                'INSERT INTO users (id, email, password_hash, display_name, payment_handles)
                 VALUES (?, ?, ?, ?, ?)',
            )->execute([$id, $email, self::hashPassword($password), $displayName, '{}']);
        } catch (\PDOException $e) {
            if (($e->errorInfo[1] ?? 0) === 1062) { // duplicate key
                // Issue #2: a placeholder created by an import/invite is
                // claimed by registering with its email — history intact.
                $claim = $this->pdo->prepare(
                    'SELECT id FROM users WHERE email = ? AND placeholder_at IS NOT NULL AND deleted_at IS NULL',
                );
                $claim->execute([$email]);
                $placeholderId = $claim->fetchColumn();
                if ($placeholderId === false) {
                    throw new ApiException('EMAIL_TAKEN', 'an account with this email already exists', 409);
                }
                $this->pdo->prepare(
                    'UPDATE users SET password_hash = ?, display_name = ?, placeholder_at = NULL WHERE id = ?',
                )->execute([self::hashPassword($password), $displayName, $placeholderId]);
                $id = (string) $placeholderId;
            } else {
                throw $e;
            }
        }

        return ['token' => $this->createSession($id, $deviceLabel), 'user' => $this->userById($id)];
    }

    /** @return array{token:string, user:array<string,mixed>} */
    public function login(string $email, string $password, string $deviceLabel = ''): array
    {
        $row = $this->pdo->prepare('SELECT id, password_hash, deleted_at FROM users WHERE email = ?');
        $row->execute([strtolower(trim($email))]);
        $user = $row->fetch();

        // Verify against a dummy hash on unknown emails so response timing
        // doesn't reveal whether the account exists.
        $hash = $user['password_hash'] ?? self::hashPassword('timing-equalizer');
        $ok = password_verify($password, $hash) && $user && $user['deleted_at'] === null;
        if (!$ok) {
            throw new ApiException('INVALID_CREDENTIALS', 'email or password is incorrect', 401);
        }

        return ['token' => $this->createSession($user['id'], $deviceLabel), 'user' => $this->userById($user['id'])];
    }

    /** @return array<string,mixed> the authenticated user row (public shape) */
    public function verifyToken(string $token): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.id, u.email, u.email_verified_at, u.display_name,
                    u.avatar, u.default_currency, u.payment_handles, u.notify_level, u.deleted_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?',
        );
        $stmt->execute([self::hashToken($token)]);
        $row = $stmt->fetch();

        $valid = $row
            && $row['revoked_at'] === null
            && $row['deleted_at'] === null
            && $row['expires_at'] > Db::now();
        if (!$valid) {
            throw new ApiException('UNAUTHENTICATED', 'sign in to continue', 401);
        }

        // Rolling expiry: seeing the token slides last_seen and expiry.
        $this->pdo->prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
            ->execute([Db::now(), self::expiry(), $row['session_id']]);

        return self::publicUser($row) + ['sessionId' => $row['session_id']];
    }

    public function logout(string $sessionId): void
    {
        $this->pdo->prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
            ->execute([Db::now(), $sessionId]);
    }

    /** @return list<array<string,mixed>> */
    public function listSessions(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, device_label, created_at, last_seen_at
             FROM sessions
             WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
             ORDER BY last_seen_at DESC',
        );
        $stmt->execute([$userId, Db::now()]);
        return array_map(static fn(array $s): array => [
            'id' => $s['id'],
            'deviceLabel' => $s['device_label'],
            'createdAt' => $s['created_at'],
            'lastSeenAt' => $s['last_seen_at'],
        ], $stmt->fetchAll());
    }

    public function revokeSession(string $userId, string $sessionId): void
    {
        $stmt = $this->pdo->prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL');
        $stmt->execute([Db::now(), $sessionId, $userId]);
        if ($stmt->rowCount() === 0) {
            throw new ApiException('NOT_FOUND', 'session not found', 404);
        }
    }

    /** @return array<string,mixed> */
    public function userById(string $id): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, email, email_verified_at, display_name, avatar, default_currency, payment_handles, notify_level
             FROM users WHERE id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new ApiException('NOT_FOUND', 'user not found', 404);
        }
        return self::publicUser($row);
    }

    /** PATCH /me — FR-1.4. @param array<string,mixed> $data @return array<string,mixed> */
    public function updateProfile(string $userId, array $data): array
    {
        $sets = [];
        $args = [];
        if (array_key_exists('displayName', $data)) {
            $name = trim((string) $data['displayName']);
            if ($name === '' || mb_strlen($name) > 80) {
                throw new ApiException('VALIDATION', 'display name must be 1-80 characters');
            }
            $sets[] = 'display_name = ?';
            $args[] = $name;
        }
        if (array_key_exists('avatar', $data)) {
            $sets[] = 'avatar = ?';
            $args[] = mb_substr((string) $data['avatar'], 0, 16);
        }
        if (array_key_exists('defaultCurrency', $data)) {
            $cur = strtoupper((string) $data['defaultCurrency']);
            if (!preg_match('/^[A-Z]{3}$/', $cur)) {
                throw new ApiException('VALIDATION', 'defaultCurrency must be a 3-letter code');
            }
            $sets[] = 'default_currency = ?';
            $args[] = $cur;
        }
        if (array_key_exists('paymentHandles', $data)) {
            $sets[] = 'payment_handles = ?';
            $args[] = json_encode(self::validateHandles($data['paymentHandles']), JSON_THROW_ON_ERROR);
        }
        if (array_key_exists('notifyLevel', $data)) {
            $level = (string) $data['notifyLevel'];
            if (!in_array($level, ['all', 'important', 'none'], true)) {
                throw new ApiException('VALIDATION', 'notifyLevel must be all, important, or none');
            }
            $sets[] = 'notify_level = ?';
            $args[] = $level;
        }
        if ($sets !== []) {
            $args[] = $userId;
            $this->pdo->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
        }
        return $this->userById($userId);
    }

    /** @return array<string,string> */
    private static function validateHandles(mixed $handles): array
    {
        if (!is_array($handles)) {
            throw new ApiException('VALIDATION', 'paymentHandles must be an object');
        }
        $out = [];
        if (isset($handles['interacEmail']) && $handles['interacEmail'] !== '') {
            if (!filter_var($handles['interacEmail'], FILTER_VALIDATE_EMAIL)) {
                throw new ApiException('VALIDATION', 'interacEmail must be a valid email address');
            }
            $out['interacEmail'] = strtolower((string) $handles['interacEmail']);
        }
        foreach (['paypalMe', 'venmo'] as $key) {
            if (isset($handles[$key]) && $handles[$key] !== '') {
                if (!preg_match('/^[A-Za-z0-9._-]{1,50}$/', (string) $handles[$key])) {
                    throw new ApiException('VALIDATION', "{$key} may only contain letters, numbers, dots, dashes");
                }
                $out[$key] = (string) $handles[$key];
            }
        }
        return $out;
    }

    /**
     * FR-1.5 account deletion. The user row is anonymized, not removed, so
     * historical expenses keep their references and other members' balances
     * stay correct. Confirmation = retyping the account email.
     */
    public function deleteAccount(string $userId, string $confirmEmail): void
    {
        $stmt = $this->pdo->prepare('SELECT email FROM users WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$userId]);
        $email = $stmt->fetchColumn();
        if ($email === false) {
            throw new ApiException('NOT_FOUND', 'user not found', 404);
        }
        if (strtolower(trim($confirmEmail)) !== $email) {
            throw new ApiException('VALIDATION', 'type your account email exactly to confirm deletion');
        }

        $this->pdo->beginTransaction();
        try {
            $this->pdo->prepare(
                "UPDATE users SET email = CONCAT('deleted-', id, '@invalid.slytab'),
                        display_name = 'Deleted user', avatar = '', payment_handles = '{}',
                        password_hash = ?, deleted_at = ? WHERE id = ?",
            )->execute([self::hashPassword(bin2hex(random_bytes(32))), Db::now(), $userId]);
            $this->pdo->prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
                ->execute([Db::now(), $userId]);
            $this->pdo->prepare('UPDATE memberships SET left_at = ? WHERE user_id = ? AND left_at IS NULL')
                ->execute([Db::now(), $userId]);
            foreach (['oauth_identities', 'email_verifications', 'password_resets'] as $table) {
                $this->pdo->prepare("DELETE FROM {$table} WHERE user_id = ?")->execute([$userId]);
            }
            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Issue a session for an already-authenticated user (OAuth flows).
     * @return array{token:string, user:array<string,mixed>}
     */
    public function issueSession(string $userId, string $deviceLabel = ''): array
    {
        return ['token' => $this->createSession($userId, $deviceLabel), 'user' => $this->userById($userId)];
    }

    private function createSession(string $userId, string $deviceLabel): string
    {
        // Issue #26: a browser that re-logs-in orphans its old session
        // (the token is gone client-side but the row lived on for 180
        // days). Any fresh login sweeps the user's sessions that have
        // been idle for 30+ days — nobody re-authenticates on a device
        // they used this month.
        $this->pdo->prepare(
            'UPDATE sessions SET revoked_at = ?
             WHERE user_id = ? AND revoked_at IS NULL AND last_seen_at < ?',
        )->execute([Db::now(), $userId, gmdate('Y-m-d H:i:s', time() - 30 * 86400)]);

        $token = bin2hex(random_bytes(32));
        $this->pdo->prepare(
            'INSERT INTO sessions (id, user_id, token_hash, device_label, expires_at)
             VALUES (?, ?, ?, ?, ?)',
        )->execute([
            Ulid::generate(),
            $userId,
            self::hashToken($token),
            mb_substr(trim($deviceLabel), 0, 120),
            self::expiry(),
        ]);
        return $token;
    }

    private static function expiry(): string
    {
        return gmdate('Y-m-d H:i:s', time() + self::SESSION_DAYS * 86400);
    }

    private static function hashToken(string $token): string
    {
        return hash_hmac('sha256', $token, Env::require('SESSION_PEPPER'));
    }

    private static function hashPassword(string $password): string
    {
        // argon2id per NFR-2; PASSWORD_DEFAULT (bcrypt) only if the host's
        // PHP was built without libargon2 — flag that host before launch.
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
        return password_hash($password, $algo);
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function publicUser(array $row): array
    {
        return [
            'id' => $row['id'],
            'email' => $row['email'],
            'emailVerifiedAt' => $row['email_verified_at'] ?? null,
            'displayName' => $row['display_name'],
            'avatar' => $row['avatar'],
            'defaultCurrency' => $row['default_currency'],
            'paymentHandles' => json_decode($row['payment_handles'] ?: '{}', true),
            'notifyLevel' => $row['notify_level'] ?? 'all',
        ];
    }
}
