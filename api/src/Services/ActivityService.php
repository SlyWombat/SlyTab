<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\Ulid;

/** Append-only activity feed — FR-8.1. */
final class ActivityService
{
    public function __construct(private readonly PDO $pdo) {}

    /** @param array<string,mixed>|null $diff */
    public function record(string $groupId, string $userId, string $verb, string $entityType, string $entityId, ?array $diff = null): void
    {
        $this->pdo->prepare(
            'INSERT INTO activity (id, group_id, user_id, verb, entity_type, entity_id, diff)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
        )->execute([
            Ulid::generate(), $groupId, $userId, $verb, $entityType, $entityId,
            $diff === null ? null : json_encode($diff, JSON_THROW_ON_ERROR),
        ]);
    }

    /** @return array{items: list<array<string,mixed>>, nextCursor: ?string} */
    public function forGroup(string $groupId, ?string $cursor, int $limit = 50): array
    {
        $sql = 'SELECT a.id, a.user_id, u.display_name, a.verb, a.entity_type, a.entity_id, a.diff, a.created_at
                FROM activity a JOIN users u ON u.id = a.user_id
                WHERE a.group_id = ?' . ($cursor !== null ? ' AND a.id < ?' : '') . '
                ORDER BY a.id DESC LIMIT ' . ($limit + 1);
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($cursor !== null ? [$groupId, $cursor] : [$groupId]);
        $rows = $stmt->fetchAll();

        $next = null;
        if (count($rows) > $limit) {
            array_pop($rows);
            $next = $rows[array_key_last($rows)]['id'];
        }
        return [
            'items' => array_map(static fn(array $r): array => [
                'id' => $r['id'],
                'userId' => $r['user_id'],
                'userName' => $r['display_name'],
                'verb' => $r['verb'],
                'entityType' => $r['entity_type'],
                'entityId' => $r['entity_id'],
                'diff' => $r['diff'] === null ? null : json_decode($r['diff'], true),
                'createdAt' => $r['created_at'],
            ], $rows),
            'nextCursor' => $next,
        ];
    }
}
