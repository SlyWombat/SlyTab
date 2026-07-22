<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Expenses — FR-3.x/5.x. The client computes concrete payer/share amounts
 * (using @slytab/core); the server re-validates every invariant: positive
 * integer amounts, payers sum == total, shares sum == total, all
 * participants are active members, currency/rate rules.
 */
final class ExpenseService
{
    private const CATEGORIES = ['food', 'home', 'travel', 'fun', 'utilities', 'other'];
    private const SPLIT_METHODS = ['equal', 'exact', 'shares', 'percent', 'adjustment'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly FxService $fx,
        private readonly ActivityService $activity,
    ) {}

    /** @param array<string,mixed> $data @return array<string,mixed> */
    public function create(string $groupId, string $userId, array $data): array
    {
        $this->groups->assertWritable($groupId);
        $v = $this->validate($groupId, $data);

        $id = Ulid::generate();
        $this->pdo->beginTransaction();
        try {
            $this->pdo->prepare(
                'INSERT INTO expenses (id, group_id, description, amount, currency, fx_rate, fx_rate_source,
                                       expense_date, category, notes, receipt_id, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )->execute([
                $id, $groupId, $v['description'], $v['amount'], $v['currency'],
                $v['fxRate'], $v['fxRateSource'], $v['date'], $v['category'],
                $v['notes'], $v['receiptId'], $userId,
            ]);
            $this->insertParticipants($id, $v);
            $this->activity->record($groupId, $userId, 'added', 'expense', $id, [
                'description' => $v['description'], 'amount' => $v['amount'], 'currency' => $v['currency'],
            ]);
            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        return $this->get($id);
    }

    /** @param array<string,mixed> $data @return array<string,mixed> */
    public function update(string $expenseId, string $userId, array $data): array
    {
        $existing = $this->get($expenseId);
        $groupId = $existing['groupId'];
        $this->groups->assertMember($groupId, $userId);
        $this->groups->assertWritable($groupId);
        $v = $this->validate($groupId, $data);

        $this->pdo->beginTransaction();
        try {
            $this->pdo->prepare(
                'UPDATE expenses SET description=?, amount=?, currency=?, fx_rate=?, fx_rate_source=?,
                        expense_date=?, category=?, notes=?, receipt_id=? WHERE id=?',
            )->execute([
                $v['description'], $v['amount'], $v['currency'], $v['fxRate'], $v['fxRateSource'],
                $v['date'], $v['category'], $v['notes'], $v['receiptId'], $expenseId,
            ]);
            $this->pdo->prepare('DELETE FROM expense_payers WHERE expense_id = ?')->execute([$expenseId]);
            $this->pdo->prepare('DELETE FROM expense_shares WHERE expense_id = ?')->execute([$expenseId]);
            $this->insertParticipants($expenseId, $v);
            $this->activity->record($groupId, $userId, 'edited', 'expense', $expenseId, [
                'description' => $v['description'], 'amount' => $v['amount'], 'currency' => $v['currency'],
            ]);
            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        return $this->get($expenseId);
    }

    /** @return array<string,mixed> */
    public function get(string $expenseId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$expenseId]);
        $e = $stmt->fetch();
        if (!$e) {
            throw new ApiException('NOT_FOUND', 'expense not found', 404);
        }
        return $this->shape($e);
    }

    /** @return array{items: list<array<string,mixed>>, nextCursor: ?string} */
    public function listForGroup(string $groupId, ?string $cursor, int $limit = 30): array
    {
        $sql = 'SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL'
            . ($cursor !== null ? ' AND id < ?' : '')
            . ' ORDER BY id DESC LIMIT ' . ($limit + 1);
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($cursor !== null ? [$groupId, $cursor] : [$groupId]);
        $rows = $stmt->fetchAll();

        $next = null;
        if (count($rows) > $limit) {
            array_pop($rows);
            $next = $rows[array_key_last($rows)]['id'];
        }
        return ['items' => array_map($this->shape(...), $rows), 'nextCursor' => $next];
    }

    public function softDelete(string $expenseId, string $userId): void
    {
        $e = $this->get($expenseId);
        $this->groups->assertMember($e['groupId'], $userId);
        $this->groups->assertWritable($e['groupId']);
        $this->pdo->prepare('UPDATE expenses SET deleted_at = ? WHERE id = ?')->execute([Db::now(), $expenseId]);
        $this->activity->record($e['groupId'], $userId, 'deleted', 'expense', $expenseId, [
            'description' => $e['description'],
        ]);
    }

    public function restore(string $expenseId, string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT group_id, deleted_at FROM expenses WHERE id = ? AND deleted_at IS NOT NULL
             AND deleted_at > DATE_SUB(?, INTERVAL 30 DAY)',
        );
        $stmt->execute([$expenseId, Db::now()]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new ApiException('NOT_FOUND', 'expense not found or past the 30-day restore window', 404);
        }
        $this->groups->assertMember($row['group_id'], $userId);
        $this->pdo->prepare('UPDATE expenses SET deleted_at = NULL WHERE id = ?')->execute([$expenseId]);
        $this->activity->record($row['group_id'], $userId, 'restored', 'expense', $expenseId);
        return $this->get($expenseId);
    }

    // ---- internals ----

    /** @param array<string,mixed> $data @return array<string,mixed> validated */
    private function validate(string $groupId, array $data): array
    {
        $description = trim((string) ($data['description'] ?? ''));
        if ($description === '' || mb_strlen($description) > 200) {
            throw new ApiException('VALIDATION', 'description must be 1-200 characters');
        }
        $amount = $data['amountMinor'] ?? null;
        if (!is_int($amount) || $amount <= 0) {
            throw new ApiException('VALIDATION', 'amountMinor must be a positive integer');
        }
        $currency = (string) ($data['currency'] ?? '');
        if (!preg_match('/^[A-Z]{3}$/', $currency)) {
            throw new ApiException('VALIDATION', 'currency must be a 3-letter code');
        }
        $date = (string) ($data['expenseDate'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            throw new ApiException('VALIDATION', 'expenseDate must be YYYY-MM-DD');
        }
        $category = (string) ($data['category'] ?? 'other');
        if (!in_array($category, self::CATEGORIES, true)) {
            throw new ApiException('VALIDATION', 'unknown category');
        }
        $splitMethod = (string) ($data['splitMethod'] ?? '');
        if (!in_array($splitMethod, self::SPLIT_METHODS, true)) {
            throw new ApiException('VALIDATION', 'unknown split method');
        }

        $payers = self::participantList($data['payers'] ?? null, 'payers');
        $shares = self::participantList($data['shares'] ?? null, 'shares');
        if (array_sum(array_column($payers, 'amountMinor')) !== $amount) {
            throw new ApiException('VALIDATION', 'payer amounts must sum to the total');
        }
        if (array_sum(array_column($shares, 'amountMinor')) !== $amount) {
            throw new ApiException('VALIDATION', 'share amounts must sum to the total');
        }
        foreach ([...$payers, ...$shares] as $p) {
            $this->groups->assertMemberParticipant($groupId, $p['userId']);
        }

        // FX: same-currency expenses carry no rate; foreign ones lock one now.
        $group = $this->groups->get($groupId);
        $fxRate = null;
        $fxRateSource = null;
        if ($currency !== $group['homeCurrency']) {
            $override = $data['fxRateOverride'] ?? null;
            if ($override !== null) {
                if (!is_numeric($override) || (float) $override <= 0) {
                    throw new ApiException('VALIDATION', 'fxRateOverride must be a positive number');
                }
                $fxRate = (float) $override;
                $fxRateSource = 'manual';
            } else {
                $fxRate = $this->fx->rateFor($date, $currency, $group['homeCurrency']);
                $fxRateSource = 'ecb';
            }
        }

        return [
            'description' => $description,
            'amount' => $amount,
            'currency' => $currency,
            'date' => $date,
            'category' => $category,
            'notes' => isset($data['notes']) ? mb_substr((string) $data['notes'], 0, 2000) : null,
            'receiptId' => isset($data['receiptId']) ? (string) $data['receiptId'] : null,
            'splitMethod' => $splitMethod,
            'splitInput' => $data['splitInput'] ?? null,
            'payers' => $payers,
            'shares' => $shares,
            'fxRate' => $fxRate,
            'fxRateSource' => $fxRateSource,
        ];
    }

    /** @return list<array{userId:string, amountMinor:int}> */
    private static function participantList(mixed $raw, string $label): array
    {
        if (!is_array($raw) || $raw === []) {
            throw new ApiException('VALIDATION', "{$label} must be a non-empty list");
        }
        $out = [];
        $seen = [];
        foreach ($raw as $p) {
            $uid = $p['userId'] ?? null;
            $amt = $p['amountMinor'] ?? null;
            if (!is_string($uid) || $uid === '' || !is_int($amt) || $amt < 0) {
                throw new ApiException('VALIDATION', "each of {$label} needs userId and a non-negative integer amountMinor");
            }
            if (isset($seen[$uid])) {
                throw new ApiException('VALIDATION', "duplicate user in {$label}");
            }
            $seen[$uid] = true;
            $out[] = ['userId' => $uid, 'amountMinor' => $amt];
        }
        return $out;
    }

    /** @param array<string,mixed> $v */
    private function insertParticipants(string $expenseId, array $v): void
    {
        $payer = $this->pdo->prepare('INSERT INTO expense_payers (expense_id, user_id, amount) VALUES (?, ?, ?)');
        foreach ($v['payers'] as $p) {
            $payer->execute([$expenseId, $p['userId'], $p['amountMinor']]);
        }
        $share = $this->pdo->prepare(
            'INSERT INTO expense_shares (expense_id, user_id, amount, split_method, split_input) VALUES (?, ?, ?, ?, ?)',
        );
        $splitInput = $v['splitInput'] === null ? null : json_encode($v['splitInput'], JSON_THROW_ON_ERROR);
        foreach ($v['shares'] as $s) {
            $share->execute([$expenseId, $s['userId'], $s['amountMinor'], $v['splitMethod'], $splitInput]);
        }
    }

    /** @param array<string,mixed> $e @return array<string,mixed> */
    private function shape(array $e): array
    {
        $payers = $this->pdo->prepare('SELECT user_id, amount FROM expense_payers WHERE expense_id = ? ORDER BY user_id');
        $payers->execute([$e['id']]);
        $shares = $this->pdo->prepare(
            'SELECT user_id, amount, split_method, split_input FROM expense_shares WHERE expense_id = ? ORDER BY user_id',
        );
        $shares->execute([$e['id']]);
        $shareRows = $shares->fetchAll();

        return [
            'id' => $e['id'],
            'groupId' => $e['group_id'],
            'description' => $e['description'],
            'amountMinor' => (int) $e['amount'],
            'currency' => $e['currency'],
            'fxRate' => $e['fx_rate'] === null ? null : (float) $e['fx_rate'],
            'fxRateSource' => $e['fx_rate_source'],
            'expenseDate' => $e['expense_date'],
            'category' => $e['category'],
            'notes' => $e['notes'],
            'receiptId' => $e['receipt_id'],
            'createdBy' => $e['created_by'],
            'createdAt' => $e['created_at'],
            'updatedAt' => $e['updated_at'],
            'splitMethod' => $shareRows[0]['split_method'] ?? 'equal',
            'payers' => array_map(static fn(array $p): array => [
                'userId' => $p['user_id'], 'amountMinor' => (int) $p['amount'],
            ], $payers->fetchAll()),
            'shares' => array_map(static fn(array $s): array => [
                'userId' => $s['user_id'], 'amountMinor' => (int) $s['amount'],
            ], $shareRows),
        ];
    }
}
