<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;

/**
 * DB-backed fixed-window rate limiter (NFR-2). Shared hosting has no
 * shared memory across PHP workers, so MySQL is the coordination point;
 * at SlyTab's scale a single-row upsert per guarded request is fine.
 */
final class RateLimiter
{
    public function __construct(private readonly PDO $pdo) {}

    /** Throws RATE_LIMITED (429) once the window budget is exhausted. */
    public function guard(string $scope, string $identifier, int $max, int $windowSeconds): void
    {
        $window = intdiv(time(), $windowSeconds);
        $key = hash('sha256', "{$scope}:{$identifier}:{$window}");
        $expires = gmdate('Y-m-d H:i:s', ($window + 1) * $windowSeconds + 60);

        $this->pdo->prepare(
            'INSERT INTO rate_limits (k, hits, expires_at) VALUES (?, 1, ?)
             ON DUPLICATE KEY UPDATE hits = hits + 1',
        )->execute([$key, $expires]);

        $stmt = $this->pdo->prepare('SELECT hits FROM rate_limits WHERE k = ?');
        $stmt->execute([$key]);
        if ((int) $stmt->fetchColumn() > $max) {
            throw new ApiException('RATE_LIMITED', 'too many attempts — wait a bit and try again', 429);
        }

        // Lazy cleanup, roughly once per hundred guarded requests.
        if (random_int(0, 99) === 0) {
            $this->pdo->prepare('DELETE FROM rate_limits WHERE expires_at < ?')
                ->execute([gmdate('Y-m-d H:i:s')]);
        }
    }
}
