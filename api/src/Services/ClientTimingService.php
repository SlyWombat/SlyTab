<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Client-side timing (#111).
 *
 * Two testers called the app laggy, on two platforms, and we had no
 * measurement of either — so the first diagnosis was made by reading code and
 * turned out to be wrong. This exists so the next one is made from evidence.
 *
 * Everything is deliberately coarse. The point is to answer "is a screen slow
 * because of the network, the server, or the rendering", not to follow anyone
 * around. Names are path templates with ids stripped; there is no third-party
 * analytics in this app and this does not introduce one.
 */
final class ClientTimingService
{
    /** A batch bigger than this is a bug or an attack, not a phone. */
    private const MAX_BATCH = 60;
    /** Anything slower than this is a stuck request, not a measurement. */
    private const MAX_MS = 120_000;
    /** Kept long enough to compare a release with the one before it. */
    private const RETENTION_DAYS = 45;

    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Reduce a request path to something safe to group by.
     *
     * `/groups/01KY…/expenses` becomes `/groups/:id/expenses`. Without this the
     * table would hold a row per group per request, which is both useless for
     * percentiles and a record of who opened what.
     */
    public static function template(string $path): string
    {
        $path = parse_url($path, PHP_URL_PATH) ?: $path;
        $path = preg_replace('#^/api/v1#', '', $path) ?? $path;
        // Longest first: a 32-character hex token starts with 26 characters
        // that are all legal ULID digits, so matching ULIDs first would eat
        // most of the token and leave the tail behind.
        $path = preg_replace('#/[0-9a-f]{32}\b#i', '/:token', $path) ?? $path;
        $path = preg_replace('#/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}#i', '/:id', $path) ?? $path;
        $path = preg_replace('#/[0-9A-HJKMNP-TV-Z]{26}\b#i', '/:id', $path) ?? $path;
        $path = preg_replace('#/\d+#', '/:n', $path) ?? $path;
        return substr($path === '' ? '/' : $path, 0, 120);
    }

    /**
     * Record a batch. Returns how many rows were kept.
     *
     * Invalid entries are skipped rather than failing the batch: this is
     * diagnostics, and a phone should never see an error because one of its
     * measurements was malformed.
     *
     * @param array<int,mixed> $items
     */
    public function record(?string $userId, array $items, string $platform, string $appVersion): int
    {
        if (count($items) > self::MAX_BATCH) {
            throw new ApiException('VALIDATION', 'too many timings in one batch', 422);
        }

        $stmt = $this->pdo->prepare(
            'INSERT INTO client_timing (id, user_id, kind, name, ms, status, platform, app_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $kept = 0;
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $kind = (string) ($item['kind'] ?? '');
            $name = (string) ($item['name'] ?? '');
            $ms = $item['ms'] ?? null;
            if (!in_array($kind, ['api', 'screen'], true) || $name === '' || !is_numeric($ms)) {
                continue;
            }
            $ms = (int) round((float) $ms);
            if ($ms < 0 || $ms > self::MAX_MS) {
                continue;
            }
            $stmt->execute([
                Ulid::generate(),
                $userId,
                $kind,
                $kind === 'api' ? self::template($name) : substr($name, 0, 120),
                $ms,
                max(0, min(599, (int) ($item['status'] ?? 0))),
                substr($platform, 0, 16),
                substr($appVersion, 0, 24),
            ]);
            $kept++;
        }
        return $kept;
    }

    /**
     * Percentiles per name over a recent window, for the dashboard.
     *
     * p95 rather than an average: an average hides the tail, and the tail is
     * what people mean when they say something is slow.
     *
     * @return array<string,mixed>
     */
    public function summary(int $hours = 24): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT kind, name, ms FROM client_timing
              WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
              ORDER BY name'
        );
        $stmt->execute([max(1, min(24 * 30, $hours))]);

        $byName = [];
        foreach ($stmt->fetchAll() as $row) {
            $byName[$row['kind'] . ' ' . $row['name']][] = (int) $row['ms'];
        }

        $rows = [];
        foreach ($byName as $key => $values) {
            sort($values);
            [$kind, $name] = explode(' ', $key, 2);
            $rows[] = [
                'kind' => $kind,
                'name' => $name,
                'count' => count($values),
                'p50' => self::percentile($values, 0.50),
                'p95' => self::percentile($values, 0.95),
                'worst' => $values[count($values) - 1],
            ];
        }
        // Slowest first: the dashboard should open on the problem.
        usort($rows, fn(array $a, array $b): int => $b['p95'] <=> $a['p95']);

        return ['hours' => $hours, 'items' => $rows];
    }

    /** @param array<int,int> $sorted */
    private static function percentile(array $sorted, float $q): int
    {
        if ($sorted === []) {
            return 0;
        }
        $i = (int) floor($q * (count($sorted) - 1));
        return $sorted[$i];
    }

    /** Drop old rows. Diagnostics should not become an archive. */
    public function prune(): int
    {
        $stmt = $this->pdo->prepare(
            'DELETE FROM client_timing WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)'
        );
        $stmt->execute([self::RETENTION_DAYS]);
        return $stmt->rowCount();
    }
}
