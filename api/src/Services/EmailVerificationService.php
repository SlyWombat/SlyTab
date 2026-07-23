<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Email verification (issue #1). Soft enforcement: unverified accounts
 * work, the clients show a banner. Tokens are single-use, 48h, hashed.
 */
final class EmailVerificationService
{
    private const TOKEN_TTL_SECONDS = 48 * 3600;

    public function __construct(
        private readonly PDO $pdo,
        private readonly Mailer $mailer,
    ) {}

    public function request(string $userId): void
    {
        $stmt = $this->pdo->prepare(
            'SELECT email, display_name, email_verified_at FROM users WHERE id = ? AND deleted_at IS NULL',
        );
        $stmt->execute([$userId]);
        $user = $stmt->fetch();
        if (!$user || $user['email_verified_at'] !== null) {
            return; // nothing to do
        }

        $token = bin2hex(random_bytes(32));
        $this->pdo->prepare(
            'INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        )->execute([
            Ulid::generate(), $userId, self::hash($token),
            gmdate('Y-m-d H:i:s', time() + self::TOKEN_TTL_SECONDS),
        ]);

        $base = Env::get('APP_URL', 'https://electricrv.ca/slytab');
        $this->mailer->send(
            $user['email'],
            'Confirm your SlyTab email',
            "Hi {$user['display_name']},\n\n"
            . "Confirm this email address for your SlyTab account by opening\n"
            . "this link within 48 hours:\n\n{$base}/verify/{$token}\n\n"
            . "If you didn't create a SlyTab account, ignore this email.\n",
        );
    }

    public function verify(string $token): void
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?',
        );
        $stmt->execute([self::hash($token)]);
        $row = $stmt->fetch();
        if (!$row || $row['used_at'] !== null || $row['expires_at'] <= Db::now()) {
            throw new ApiException('VERIFY_INVALID', 'this confirmation link has expired — request a new one', 410);
        }
        $this->pdo->prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
            ->execute([Db::now(), $row['user_id']]);
        $this->pdo->prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?')
            ->execute([Db::now(), $row['id']]);
    }

    private static function hash(string $token): string
    {
        return hash_hmac('sha256', $token, Env::require('SESSION_PEPPER'));
    }
}
