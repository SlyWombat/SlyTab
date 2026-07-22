<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Settlements — FR-7.x. SlyTab never moves money: the payer records
 * "I sent it" (pending), the payee confirms receipt (confirmed). Only
 * confirmed settlements move balances. v1 settlements are always in the
 * group's home currency.
 */
final class SettlementService
{
    private const METHODS = ['interac', 'paypal', 'venmo', 'cash', 'other'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly ActivityService $activity,
    ) {}

    /** @param array<string,mixed> $data @return array<string,mixed> */
    public function create(string $groupId, string $fromUserId, array $data): array
    {
        $this->groups->assertWritable($groupId);
        $toUserId = (string) ($data['toUserId'] ?? '');
        $amount = $data['amountMinor'] ?? null;
        $method = (string) ($data['method'] ?? 'other');

        if ($toUserId === '' || $toUserId === $fromUserId) {
            throw new ApiException('VALIDATION', 'toUserId must be another group member');
        }
        if (!is_int($amount) || $amount <= 0) {
            throw new ApiException('VALIDATION', 'amountMinor must be a positive integer');
        }
        if (!in_array($method, self::METHODS, true)) {
            throw new ApiException('VALIDATION', 'unknown payment method');
        }
        $this->groups->assertMemberParticipant($groupId, $toUserId);

        $group = $this->groups->get($groupId);
        $id = Ulid::generate();
        $this->pdo->prepare(
            'INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, method, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )->execute([
            $id, $groupId, $fromUserId, $toUserId, $amount, $group['homeCurrency'],
            $method, isset($data['note']) ? mb_substr((string) $data['note'], 0, 500) : null,
        ]);
        $this->activity->record($groupId, $fromUserId, 'settled', 'settlement', $id, [
            'toUserId' => $toUserId, 'amount' => $amount, 'status' => 'pending',
        ]);
        return $this->get($id);
    }

    /** Only the payee can confirm receipt. @return array<string,mixed> */
    public function confirm(string $settlementId, string $userId): array
    {
        $s = $this->get($settlementId);
        if ($s['toUserId'] !== $userId) {
            throw new ApiException('FORBIDDEN', 'only the recipient can confirm a settlement', 403);
        }
        if ($s['status'] === 'confirmed') {
            return $s;
        }
        $this->pdo->prepare("UPDATE settlements SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
            ->execute([Db::now(), $settlementId]);
        $this->activity->record($s['groupId'], $userId, 'confirmed', 'settlement', $settlementId);
        return $this->get($settlementId);
    }

    /** Payer can withdraw a pending settlement; payee can decline it. */
    public function delete(string $settlementId, string $userId): void
    {
        $s = $this->get($settlementId);
        if ($s['status'] === 'confirmed') {
            throw new ApiException('CONFLICT', 'confirmed settlements cannot be deleted', 409);
        }
        if ($userId !== $s['fromUserId'] && $userId !== $s['toUserId']) {
            throw new ApiException('FORBIDDEN', 'not your settlement', 403);
        }
        $this->pdo->prepare('DELETE FROM settlements WHERE id = ?')->execute([$settlementId]);
        $this->activity->record($s['groupId'], $userId, 'declined', 'settlement', $settlementId);
    }

    /** @return array<string,mixed> */
    public function get(string $settlementId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM settlements WHERE id = ?');
        $stmt->execute([$settlementId]);
        $s = $stmt->fetch();
        if (!$s) {
            throw new ApiException('NOT_FOUND', 'settlement not found', 404);
        }
        return [
            'id' => $s['id'],
            'groupId' => $s['group_id'],
            'fromUserId' => $s['from_user'],
            'toUserId' => $s['to_user'],
            'amountMinor' => (int) $s['amount'],
            'currency' => $s['currency'],
            'method' => $s['method'],
            'note' => $s['note'],
            'status' => $s['status'],
            'createdAt' => $s['created_at'],
            'confirmedAt' => $s['confirmed_at'],
        ];
    }

    /** @return list<array<string,mixed>> pending settlements involving the user */
    public function pendingFor(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT id FROM settlements WHERE status = 'pending' AND (from_user = ? OR to_user = ?) ORDER BY id DESC",
        );
        $stmt->execute([$userId, $userId]);
        return array_map($this->get(...), $stmt->fetchAll(PDO::FETCH_COLUMN));
    }
}
