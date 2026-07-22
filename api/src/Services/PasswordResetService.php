<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Password reset — FR-1.3. Identical responses whether or not the account
 * exists (no user enumeration); tokens are single-use, 1-hour, stored
 * hashed; a successful reset revokes every session.
 */
final class PasswordResetService
{
    private const TOKEN_TTL_SECONDS = 3600;

    public function __construct(
        private readonly PDO $pdo,
        private readonly Mailer $mailer,
    ) {}

    public function request(string $email): void
    {
        $stmt = $this->pdo->prepare('SELECT id, display_name FROM users WHERE email = ? AND deleted_at IS NULL');
        $stmt->execute([strtolower(trim($email))]);
        $user = $stmt->fetch();
        if (!$user) {
            return; // same outward behaviour either way
        }

        $token = bin2hex(random_bytes(32));
        $this->pdo->prepare(
            'INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        )->execute([
            Ulid::generate(), $user['id'], self::hash($token),
            gmdate('Y-m-d H:i:s', time() + self::TOKEN_TTL_SECONDS),
        ]);

        $base = Env::get('APP_URL', 'https://electricrv.ca/slytab');
        $this->mailer->send(
            strtolower(trim($email)),
            'Reset your SlyTab password',
            "Hi {$user['display_name']},\n\n"
            . "Someone asked to reset the password for this SlyTab account. If it\n"
            . "was you, open this link within an hour:\n\n{$base}/reset/{$token}\n\n"
            . "If it wasn't you, ignore this email — nothing changes.\n",
        );
    }

    public function reset(string $token, string $newPassword): void
    {
        if (strlen($newPassword) < 10) {
            throw new ApiException('VALIDATION', 'password must be at least 10 characters');
        }
        $stmt = $this->pdo->prepare(
            'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
        );
        $stmt->execute([self::hash($token)]);
        $row = $stmt->fetch();
        if (!$row || $row['used_at'] !== null || $row['expires_at'] <= Db::now()) {
            throw new ApiException('RESET_INVALID', 'this reset link has expired — request a new one', 410);
        }

        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
        $this->pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($newPassword, $algo), $row['user_id']]);
        $this->pdo->prepare('UPDATE password_resets SET used_at = ? WHERE id = ?')
            ->execute([Db::now(), $row['id']]);
        // Every existing session dies with the old password.
        $this->pdo->prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
            ->execute([Db::now(), $row['user_id']]);
    }

    private static function hash(string $token): string
    {
        return hash_hmac('sha256', $token, Env::require('SESSION_PEPPER'));
    }
}
