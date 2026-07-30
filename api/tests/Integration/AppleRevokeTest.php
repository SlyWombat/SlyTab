<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\AuthService;
use SlyTab\Support\Ulid;

/**
 * Issue #81: Apple requires an app offering Sign in with Apple to revoke the
 * account when the user deletes it.
 *
 * The property that matters most here is the failure path. A user who asks to
 * be deleted gets deleted — whether Apple answers, whether the network is up,
 * and whether the Sign in with Apple key has been configured at all. Anything
 * else turns "delete my account" into a promise we might not keep.
 */
final class AppleRevokeTest extends TestCase
{
    private static ?PDO $pdo = null;
    private AuthService $auth;
    private string $userId;

    public static function setUpBeforeClass(): void
    {
        try {
            self::$pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator(self::$pdo))->fresh();
    }

    protected function setUp(): void
    {
        $pdo = self::$pdo;
        $pdo->exec('DELETE FROM oauth_identities');
        $pdo->exec('DELETE FROM users');

        $this->auth = new AuthService($pdo);
        $this->userId = Ulid::generate();
        $pdo->prepare(
            'INSERT INTO users (id, email, password_hash, display_name, payment_handles)
             VALUES (?, ?, ?, ?, ?)',
        )->execute([$this->userId, 'revoke@example.com', 'x', 'Revoke Tester', '{}']);
        $pdo->prepare(
            "INSERT INTO oauth_identities (id, user_id, provider, subject, email, refresh_token)
             VALUES (?, ?, 'apple', ?, ?, ?)",
        )->execute([Ulid::generate(), $this->userId, 'apple-sub-1', 'revoke@example.com', 'rt-abc']);
    }

    private function deleted(): bool
    {
        $stmt = self::$pdo->prepare('SELECT deleted_at FROM users WHERE id = ?');
        $stmt->execute([$this->userId]);
        return $stmt->fetchColumn() !== null;
    }

    /** The migration has to exist for any of this to be storable. */
    public function testTheRefreshTokenColumnExists(): void
    {
        $stmt = self::$pdo->prepare(
            "SELECT refresh_token FROM oauth_identities WHERE user_id = ?",
        );
        $stmt->execute([$this->userId]);

        self::assertSame('rt-abc', $stmt->fetchColumn());
    }

    public function testRevokeIsCalledWithTheUserBeforeDeletion(): void
    {
        $seen = [];
        $this->auth->setAppleRevoke(function (string $uid) use (&$seen): bool {
            // The identity row must still be readable at this point — revoking
            // after the DELETE would leave nothing to revoke with.
            $stmt = self::$pdo->prepare(
                "SELECT refresh_token FROM oauth_identities WHERE user_id = ? AND provider = 'apple'",
            );
            $stmt->execute([$uid]);
            $seen[] = [$uid, $stmt->fetchColumn()];
            return true;
        });

        $this->auth->deleteAccount($this->userId, 'revoke@example.com');

        self::assertSame([[$this->userId, 'rt-abc']], $seen);
        self::assertTrue($this->deleted());
    }

    /** Apple down, or the key not configured: the user still gets deleted. */
    public function testDeletionSucceedsWhenRevocationThrows(): void
    {
        $this->auth->setAppleRevoke(static function (string $uid): bool {
            throw new \RuntimeException('appleid.apple.com unreachable');
        });

        $this->auth->deleteAccount($this->userId, 'revoke@example.com');

        self::assertTrue($this->deleted(), 'a failed revoke must never block deletion');
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM oauth_identities WHERE user_id = ?');
        $stmt->execute([$this->userId]);
        self::assertSame(0, (int) $stmt->fetchColumn(), 'the identity is still removed');
    }

    /** Nothing wired at all — the state before the SIWA key exists. */
    public function testDeletionWorksWithNoRevokeConfigured(): void
    {
        $this->auth->deleteAccount($this->userId, 'revoke@example.com');

        self::assertTrue($this->deleted());
    }

    public function testTheWrongConfirmationEmailStillRefuses(): void
    {
        $called = false;
        $this->auth->setAppleRevoke(function () use (&$called): bool {
            $called = true;
            return true;
        });

        try {
            $this->auth->deleteAccount($this->userId, 'someone-else@example.com');
            self::fail('expected the confirmation check to refuse');
        } catch (\Throwable $e) {
            self::assertFalse($called, 'nothing is revoked when the deletion is refused');
            self::assertFalse($this->deleted());
        }
    }
}
