<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Settlements — FR-7.x. SlyTab never moves money. Two people can record
 * the same payment, from opposite ends:
 *
 *  - **The payer**: "I sent it" — recorded pending, and the payee confirms
 *    receipt. Only then does it move balances.
 *  - **The payee**: "he handed me $20" (#120) — recorded confirmed on the
 *    spot. There is nobody left to confirm receipt to, and the record works
 *    against the recorder's own interest, so waiting protects no one. It
 *    stays deletable by either party, which is the correction path.
 *
 * v1 settlements are always in the group's home currency.
 */
final class SettlementService
{
    private const METHODS = ['interac', 'paypal', 'venmo', 'cash', 'other'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly ActivityService $activity,
    ) {}

    /**
     * @param string $actorId whoever is recording this — payer or payee
     * @param array<string,mixed> $data @return array<string,mixed>
     */
    public function create(string $groupId, string $actorId, array $data): array
    {
        // Deliberately the weaker check: paying each other is exactly what a
        // locked trip is for. Only an archived group refuses settlements.
        $this->groups->assertSettleable($groupId);

        // `toUserId` names the payee (the actor is paying), `fromUserId` the
        // payer (the actor is being paid). Either identifies the other end;
        // the actor is always the end that was left out.
        $fromUserId = (string) ($data['fromUserId'] ?? '');
        $toUserId = (string) ($data['toUserId'] ?? '');
        if ($fromUserId === '') {
            $fromUserId = $actorId;
        }
        if ($toUserId === '') {
            $toUserId = $actorId;
        }
        if ($fromUserId === $toUserId || ($fromUserId !== $actorId && $toUserId !== $actorId)) {
            throw new ApiException('VALIDATION', 'a settlement is between you and another group member');
        }
        $recordedByPayee = $toUserId === $actorId;

        $amount = $data['amountMinor'] ?? null;
        $method = (string) ($data['method'] ?? 'other');
        // No cap against what is owed, on purpose. "Here is $20 toward my
        // tab" is a partial payment, and someone paying more than their share
        // (and being owed the difference) is a real thing that happens on a
        // trip. The balance follows the money, not the plan.
        if (!is_int($amount) || $amount <= 0) {
            throw new ApiException('VALIDATION', 'amountMinor must be a positive integer');
        }
        if (!in_array($method, self::METHODS, true)) {
            throw new ApiException('VALIDATION', 'unknown payment method');
        }
        $this->groups->assertMemberParticipant($groupId, $fromUserId);
        $this->groups->assertMemberParticipant($groupId, $toUserId);

        $group = $this->groups->get($groupId);
        $id = Ulid::generate();
        $now = Db::now();
        $this->pdo->prepare(
            'INSERT INTO settlements
                (id, group_id, from_user, to_user, amount, currency, method, recorded_by, note, status, confirmed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )->execute([
            $id, $groupId, $fromUserId, $toUserId, $amount, $group['homeCurrency'],
            $method, $actorId, isset($data['note']) ? mb_substr((string) $data['note'], 0, 500) : null,
            $recordedByPayee ? 'confirmed' : 'pending',
            $recordedByPayee ? $now : null,
        ]);
        $this->activity->record($groupId, $actorId, $recordedByPayee ? 'received' : 'settled', 'settlement', $id, [
            'fromUserId' => $fromUserId,
            'toUserId' => $toUserId,
            'amount' => $amount,
            'status' => $recordedByPayee ? 'confirmed' : 'pending',
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

    /**
     * Payer can withdraw a pending settlement; payee can decline it.
     *
     * A confirmed settlement is normally final — two people agreed the money
     * moved, and unpicking that behind one of their backs is not a correction
     * but a rewrite. The exception is a payment the payee recorded (#120):
     * that one was confirmed by its author alone, never agreed to by anyone,
     * so a typo in it would otherwise be permanent. Either party can undo it.
     */
    public function delete(string $settlementId, string $userId): void
    {
        $s = $this->get($settlementId);
        if ($userId !== $s['fromUserId'] && $userId !== $s['toUserId']) {
            throw new ApiException('FORBIDDEN', 'not your settlement', 403);
        }
        if ($s['status'] === 'confirmed' && $s['recordedBy'] !== $s['toUserId']) {
            throw new ApiException('CONFLICT', 'confirmed settlements cannot be deleted', 409);
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
            'recordedBy' => $s['recorded_by'],
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
