<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Categories;
use SlyTab\Support\Ulid;

/**
 * Expenses — FR-3.x/5.x. The client computes concrete payer/share amounts
 * (using @slytab/core); the server re-validates every invariant: positive
 * integer amounts, payers sum == total, shares sum == total, all
 * participants are active members, currency/rate rules.
 */
final class ExpenseService
{
    private const SPLIT_METHODS = ['equal', 'exact', 'shares', 'percent', 'adjustment'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly FxService $fx,
        private readonly ActivityService $activity,
    ) {}

    /**
     * Is there already an expense in this group that looks like this one?
     *
     * Same day, same description, same amount and currency, same payer.
     * The SPLIT is deliberately not compared: a row whose shares were
     * edited afterwards is still the same expense, and re-filing it would
     * double someone's spending (issue #76).
     *
     * @param array<string,mixed> $v a validated expense
     */
    private function duplicateOf(string $groupId, array $v): ?string
    {
        $payers = array_column($v['payers'], 'userId');
        sort($payers);
        $stmt = $this->pdo->prepare(
            'SELECT e.id FROM expenses e
             WHERE e.group_id = ? AND e.deleted_at IS NULL
               AND e.expense_date = ? AND e.description = ?
               AND e.amount = ? AND e.currency = ?',
        );
        $stmt->execute([$groupId, $v['date'], $v['description'], $v['amount'], $v['currency']]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $candidateId) {
            $p = $this->pdo->prepare('SELECT user_id FROM expense_payers WHERE expense_id = ?');
            $p->execute([$candidateId]);
            $existing = $p->fetchAll(PDO::FETCH_COLUMN);
            sort($existing);
            if ($existing === $payers) {
                return (string) $candidateId;
            }
        }
        return null;
    }

    /** @param array<string,mixed> $data @return array<string,mixed> */
    public function create(string $groupId, string $userId, array $data, bool $recordActivity = true): array
    {
        $this->groups->assertWritable($groupId);
        $v = $this->validate($groupId, $data);

        // Refuse to file the same expense twice unless the user has been
        // shown the existing one and said to go ahead anyway. This is what
        // stops a double-tapped Save — or a retry on a flaky connection —
        // from quietly doubling someone's spending (issue #76).
        if (($data['allowDuplicate'] ?? false) !== true) {
            $twin = $this->duplicateOf($groupId, $v);
            if ($twin !== null) {
                throw new ApiException(
                    'DUPLICATE_EXPENSE',
                    "\"{$v['description']}\" is already in this group on {$v['date']} for the same amount",
                    409,
                );
            }
        }

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
                $v['notes'], $v['receiptIds'][0] ?? null, $userId,
            ]);
            $this->insertParticipants($id, $v);
            $this->linkReceipts($id, $groupId, $v['receiptIds']);
            if ($recordActivity) {
                $this->activity->record($groupId, $userId, 'added', 'expense', $id, [
                    'description' => $v['description'], 'amount' => $v['amount'], 'currency' => $v['currency'],
                ]);
            }
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
                $v['date'], $v['category'], $v['notes'], $v['receiptIds'][0] ?? null, $expenseId,
            ]);
            $this->linkReceipts($expenseId, $groupId, $v['receiptIds']);
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
    /** @param array<string,string> $filters q, category, member, from, to */
    public function listForGroup(string $groupId, ?string $cursor, int $limit = 30, array $filters = []): array
    {
        $sql = 'SELECT DISTINCT e.* FROM expenses e';
        $args = [$groupId];
        if (($filters['member'] ?? '') !== '') {
            $sql .= ' LEFT JOIN expense_payers ep ON ep.expense_id = e.id
                      LEFT JOIN expense_shares es ON es.expense_id = e.id';
        }
        $sql .= ' WHERE e.group_id = ? AND e.deleted_at IS NULL';
        if (($filters['q'] ?? '') !== '') {
            $sql .= ' AND (e.description LIKE ? OR e.notes LIKE ?)';
            $like = '%' . $filters['q'] . '%';
            $args[] = $like;
            $args[] = $like;
        }
        if (($filters['category'] ?? '') !== '') {
            // Filtering by a heading includes everything under it, so the
            // chips keep working now that expenses can sit on a leaf (#18).
            $category = (string) $filters['category'];
            if (in_array($category, Categories::HEADINGS, true)) {
                $sql .= ' AND (e.category = ? OR e.category LIKE ?)';
                $args[] = $category;
                $args[] = $category . '.%';
            } else {
                $sql .= ' AND e.category = ?';
                $args[] = $category;
            }
        }
        if (($filters['member'] ?? '') !== '') {
            $sql .= ' AND (ep.user_id = ? OR es.user_id = ?)';
            $args[] = $filters['member'];
            $args[] = $filters['member'];
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $filters['from'] ?? '')) {
            $sql .= ' AND e.expense_date >= ?';
            $args[] = $filters['from'];
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $filters['to'] ?? '')) {
            $sql .= ' AND e.expense_date <= ?';
            $args[] = $filters['to'];
        }
        if ($cursor !== null) {
            $sql .= ' AND e.id < ?';
            $args[] = $cursor;
        }
        $sql .= ' ORDER BY e.id DESC LIMIT ' . ($limit + 1);
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($args);
        $rows = $stmt->fetchAll();

        $next = null;
        if (count($rows) > $limit) {
            array_pop($rows);
            $next = $rows[array_key_last($rows)]['id'];
        }
        return ['items' => $this->shapeMany($rows), 'nextCursor' => $next];
    }

    /**
     * Every expense one person's money is in, across all their groups (#101).
     *
     * Two readings, both about money rather than authorship:
     *   'paid'     — they are a PAYER. Their money went out.
     *   'involved' — they hold a SHARE. Their money is owed or spent.
     * (Deliberately not "created_by": you can enter an expense someone else
     * paid for, and the owner's question was about money, not data entry.)
     *
     * @param 'paid'|'involved' $scope
     * @param 'newest'|'oldest'|'largest'|'smallest' $sort
     * @param array<string,string> $filters q, category
     * @return array{items: list<array<string,mixed>>, nextCursor: ?string}
     */
    public function listForUser(
        string $userId,
        string $scope = 'involved',
        string $sort = 'newest',
        ?string $cursor = null,
        int $limit = 30,
        array $filters = [],
    ): array {
        $link = $scope === 'paid' ? 'expense_payers' : 'expense_shares';
        $sql = "SELECT DISTINCT e.*, g.name AS group_name, g.emoji AS group_emoji FROM expenses e
                JOIN {$link} l ON l.expense_id = e.id AND l.user_id = ?
                JOIN memberships m ON m.group_id = e.group_id AND m.user_id = ?
                JOIN `groups` g ON g.id = e.group_id";
        $args = [$userId, $userId];
        // Membership is joined as well as the payer/share link: leaving a group
        // should stop its expenses appearing here, even though the historical
        // share rows stay behind so nobody else's balance moves.
        $sql .= ' WHERE e.deleted_at IS NULL AND m.left_at IS NULL';

        if (($filters['q'] ?? '') !== '') {
            $sql .= ' AND (e.description LIKE ? OR e.notes LIKE ?)';
            $like = '%' . $filters['q'] . '%';
            $args[] = $like;
            $args[] = $like;
        }
        if (($filters['category'] ?? '') !== '') {
            $category = (string) $filters['category'];
            if (in_array($category, Categories::HEADINGS, true)) {
                $sql .= ' AND (e.category = ? OR e.category LIKE ?)';
                $args[] = $category;
                $args[] = $category . '.%';
            } else {
                $sql .= ' AND e.category = ?';
                $args[] = $category;
            }
        }

        // Cursor pagination has to match the sort or the list silently repeats
        // and skips rows as you scroll. For the time sorts the ULID id is
        // already the ordering key. For the amount sorts it is not — two
        // expenses can share an amount — so the cursor is a composite
        // "<amount>:<id>" compared as a tuple.
        [$orderBy, $cmp] = match ($sort) {
            'oldest' => ['e.id ASC', '>'],
            'largest' => ['e.amount DESC, e.id DESC', null],
            'smallest' => ['e.amount ASC, e.id ASC', null],
            default => ['e.id DESC', '<'],
        };

        if ($cursor !== null && $cursor !== '') {
            if ($cmp !== null) {
                $sql .= " AND e.id {$cmp} ?";
                $args[] = $cursor;
            } else {
                [$cAmount, $cId] = array_pad(explode(':', $cursor, 2), 2, '');
                $tuple = $sort === 'largest' ? '<' : '>';
                $sql .= " AND (e.amount {$tuple} ? OR (e.amount = ? AND e.id {$tuple} ?))";
                $args[] = (int) $cAmount;
                $args[] = (int) $cAmount;
                $args[] = $cId;
            }
        }

        $sql .= ' ORDER BY ' . $orderBy . ' LIMIT ' . ($limit + 1);
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($args);
        $rows = $stmt->fetchAll();

        $next = null;
        if (count($rows) > $limit) {
            array_pop($rows);
            $last = $rows[array_key_last($rows)];
            $next = $cmp !== null ? $last['id'] : $last['amount'] . ':' . $last['id'];
        }
        // shapeMany() is the shared expense projection; the group label is
        // extra context this view needs and the per-group lists do not.
        // /me/expenses measured 4582ms on a real device — the slowest call in
        // the whole dataset — largely because this shaped thirty rows at three
        // queries each.
        $shaped = $this->shapeMany($rows);
        $items = [];
        foreach ($rows as $i => $r) {
            $out = $shaped[$i];
            $out['groupName'] = (string) ($r['group_name'] ?? '');
            $out['groupEmoji'] = (string) ($r['group_emoji'] ?? '');
            $items[] = $out;
        }
        return ['items' => $items, 'nextCursor' => $next];
    }

    /**
     * What this person's share of those expenses comes to, in their own
     * currency (#101).
     *
     * Sums SHARES, never expense totals — the headline on a list of things
     * you are part of is what you owe, not what the table spent. Amounts are
     * converted with the shared money helpers; mixed source currencies make
     * the answer approximate and it says so.
     *
     * @return array{count: int, totalMinor: int, currency: string, approximate: bool}
     */
    public function totalForUser(string $userId, string $scope, string $homeCurrency, array $filters = []): array
    {
        $link = $scope === 'paid' ? 'expense_payers' : 'expense_shares';
        $sql = "SELECT l.amount AS share, e.currency, e.expense_date, e.id FROM expenses e
                JOIN {$link} l ON l.expense_id = e.id AND l.user_id = ?
                JOIN memberships m ON m.group_id = e.group_id AND m.user_id = ?
                WHERE e.deleted_at IS NULL AND m.left_at IS NULL";
        $args = [$userId, $userId];
        if (($filters['q'] ?? '') !== '') {
            $sql .= ' AND (e.description LIKE ? OR e.notes LIKE ?)';
            $like = '%' . $filters['q'] . '%';
            $args[] = $like;
            $args[] = $like;
        }
        if (($filters['category'] ?? '') !== '') {
            $category = (string) $filters['category'];
            if (in_array($category, Categories::HEADINGS, true)) {
                $sql .= ' AND (e.category = ? OR e.category LIKE ?)';
                $args[] = $category;
                $args[] = $category . '.%';
            } else {
                $sql .= ' AND e.category = ?';
                $args[] = $category;
            }
        }
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($args);

        $total = 0;
        $count = 0;
        $foreign = false;
        foreach ($stmt->fetchAll() as $r) {
            $count++;
            $from = (string) $r['currency'];
            $share = (int) $r['share'];
            if ($from === $homeCurrency) {
                $total += $share;
                continue;
            }
            // Converted at the rate for the day the money was spent, matching
            // how BalanceService values a foreign expense. A missing rate
            // must not silently count as zero — it is dropped and the answer
            // is already flagged approximate.
            $foreign = true;
            try {
                $rate = $this->fx->rateFor((string) $r['expense_date'], $from, $homeCurrency);
                if ($rate > 0) {
                    $total += Money::convert($share, $rate, $from, $homeCurrency);
                }
            } catch (\Throwable $e) {
                error_log("my-expenses: no rate {$from}->{$homeCurrency}: " . $e->getMessage());
            }
        }
        return [
            'count' => $count,
            'totalMinor' => $total,
            'currency' => $homeCurrency,
            'approximate' => $foreign,
        ];
    }

    /** Issue #15: discussion on an expense. @return list<array<string,mixed>> */
    public function comments(string $expenseId, string $userId): array
    {
        $e = $this->get($expenseId);
        $this->groups->assertMember($e['groupId'], $userId);
        $stmt = $this->pdo->prepare(
            'SELECT c.id, c.user_id, c.body, c.created_at FROM expense_comments c
             WHERE c.expense_id = ? ORDER BY c.id',
        );
        $stmt->execute([$expenseId]);
        return array_map(static fn(array $c): array => [
            'id' => $c['id'],
            'userId' => $c['user_id'],
            'body' => $c['body'],
            'createdAt' => $c['created_at'],
        ], $stmt->fetchAll());
    }

    /** @return array<string,mixed> the new comment */
    public function addComment(string $expenseId, string $userId, string $body): array
    {
        $body = trim($body);
        if ($body === '' || mb_strlen($body) > 1000) {
            throw new ApiException('VALIDATION', 'comment must be 1-1000 characters');
        }
        $e = $this->get($expenseId);
        $this->groups->assertMember($e['groupId'], $userId);
        $id = Ulid::generate();
        $this->pdo->prepare(
            'INSERT INTO expense_comments (id, expense_id, user_id, body) VALUES (?, ?, ?, ?)',
        )->execute([$id, $expenseId, $userId, $body]);
        $this->activity->record($e['groupId'], $userId, 'commented', 'expense', $expenseId, [
            'description' => $e['description'],
        ]);
        return ['id' => $id, 'userId' => $userId, 'body' => $body, 'createdAt' => gmdate('Y-m-d H:i:s')];
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
    /** @param array<string,mixed> $data @return list<string> */
    private static function receiptIds(array $data): array
    {
        $ids = [];
        if (isset($data['receiptId']) && is_string($data['receiptId']) && $data['receiptId'] !== '') {
            $ids[] = $data['receiptId'];
        }
        foreach (($data['receiptIds'] ?? []) as $rid) {
            if (is_string($rid) && $rid !== '' && !in_array($rid, $ids, true)) {
                $ids[] = $rid;
            }
        }
        return $ids;
    }

    /**
     * Reject unknown or cross-group receipt ids up front, before the
     * expense row (whose receipt_id FK would fire first) is written.
     *
     * @param list<string> $ids @return list<string>
     */
    private function checkedReceiptIds(string $groupId, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $in = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->pdo->prepare("SELECT COUNT(*) FROM receipts WHERE group_id = ? AND id IN ({$in})");
        $stmt->execute([$groupId, ...$ids]);
        if ((int) $stmt->fetchColumn() !== count($ids)) {
            throw new ApiException('VALIDATION', 'receipt not found in this group', 422);
        }
        return $ids;
    }

    /**
     * Attach the given receipts to the expense (issue #9: bill + card
     * slip). Ids are pre-validated by checkedReceiptIds().
     *
     * @param list<string> $ids
     */
    private function linkReceipts(string $expenseId, string $groupId, array $ids): void
    {
        $this->pdo->prepare('UPDATE receipts SET expense_id = NULL WHERE expense_id = ?')->execute([$expenseId]);
        foreach ($ids as $rid) {
            $this->pdo->prepare('UPDATE receipts SET expense_id = ? WHERE id = ? AND group_id = ?')
                ->execute([$expenseId, $rid, $groupId]);
        }
    }

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
        if (!Categories::isValid($category)) {
            throw new ApiException('VALIDATION', 'unknown category');
        }
        $splitMethod = (string) ($data['splitMethod'] ?? '');
        if (!in_array($splitMethod, self::SPLIT_METHODS, true)) {
            throw new ApiException('VALIDATION', 'unknown split method');
        }
        if (isset($data['splitInput']) && !is_array($data['splitInput'])) {
            throw new ApiException('VALIDATION', 'splitInput must be an object');
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
            'receiptIds' => $this->checkedReceiptIds($groupId, self::receiptIds($data)),
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

    /**
     * Shape a page of expenses with a fixed number of queries.
     *
     * shape() costs three queries per row, and a thirty-row page therefore
     * cost ninety — about a second of pure round trip, since the database is
     * on another host at ~11ms a query. Prefetching the three child tables in
     * one query each makes a page cost four queries regardless of its size.
     *
     * @param list<array<string,mixed>> $rows
     * @return list<array<string,mixed>>
     */
    private function shapeMany(array $rows): array
    {
        if ($rows === []) {
            return [];
        }
        $ids = array_column($rows, 'id');
        $pre = [
            'payers' => $this->childRows(
                'SELECT expense_id, user_id, amount FROM expense_payers', $ids, 'user_id',
            ),
            'shares' => $this->childRows(
                'SELECT expense_id, user_id, amount, split_method, split_input FROM expense_shares',
                $ids, 'user_id',
            ),
            'receipts' => $this->childRows(
                'SELECT expense_id, id, created_at FROM receipts', $ids, 'created_at',
            ),
        ];
        return array_map(fn(array $r): array => $this->shape($r, $pre), $rows);
    }

    /**
     * One query for a child table across many expenses, grouped by expense id
     * and sorted the way the per-row queries sorted.
     *
     * @param list<string> $ids
     * @return array<string,list<array<string,mixed>>>
     */
    private function childRows(string $select, array $ids, string $orderBy): array
    {
        if ($ids === []) {
            return [];
        }
        $in = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->pdo->prepare("{$select} WHERE expense_id IN ({$in}) ORDER BY {$orderBy}");
        $stmt->execute($ids);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $out[(string) $r['expense_id']][] = $r;
        }
        return $out;
    }

    /**
     * @param array<string,mixed> $e
     * @param array<string,array<string,list<array<string,mixed>>>>|null $pre
     *        prefetched children when shaping a page; null shapes one row on its own
     * @return array<string,mixed>
     */
    private function shape(array $e, ?array $pre = null): array
    {
        $id = (string) $e['id'];
        if ($pre !== null) {
            $payerRows = $pre['payers'][$id] ?? [];
            $shareRows = $pre['shares'][$id] ?? [];
            // Primary receipt first, then by created_at — the same order the
            // per-row query produced with its ORDER BY (id = ?) DESC.
            $rs = $pre['receipts'][$id] ?? [];
            $primary = (string) ($e['receipt_id'] ?? '');
            usort($rs, fn(array $a, array $b): int =>
                ((string) $b['id'] === $primary ? 1 : 0) <=> ((string) $a['id'] === $primary ? 1 : 0));
            $receiptIds = array_column($rs, 'id');
        } else {
            $payers = $this->pdo->prepare('SELECT user_id, amount FROM expense_payers WHERE expense_id = ? ORDER BY user_id');
            $payers->execute([$id]);
            $payerRows = $payers->fetchAll();
            $shares = $this->pdo->prepare(
                'SELECT user_id, amount, split_method, split_input FROM expense_shares WHERE expense_id = ? ORDER BY user_id',
            );
            $shares->execute([$id]);
            $shareRows = $shares->fetchAll();

            // All linked receipts (bill + card slip …), primary first, so the
            // client can offer view/rescan on a previously scanned expense.
            $receipts = $this->pdo->prepare(
                'SELECT id FROM receipts WHERE expense_id = ? ORDER BY (id = ?) DESC, created_at',
            );
            $receipts->execute([$id, $e['receipt_id'] ?? '']);
            $receiptIds = array_column($receipts->fetchAll(), 'id');
        }

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
            'receiptIds' => $receiptIds,
            'createdBy' => $e['created_by'],
            'createdAt' => $e['created_at'],
            'updatedAt' => $e['updated_at'],
            'splitMethod' => $shareRows[0]['split_method'] ?? 'equal',
            // Raw per-member form inputs (shares/percent/adjustment), so
            // editing clients can restore the split form — issue #13.
            'splitInput' => isset($shareRows[0]['split_input']) && $shareRows[0]['split_input'] !== null
                ? json_decode((string) $shareRows[0]['split_input'], true)
                : null,
            'payers' => array_map(static fn(array $p): array => [
                'userId' => $p['user_id'], 'amountMinor' => (int) $p['amount'],
            ], $payerRows),
            'shares' => array_map(static fn(array $s): array => [
                'userId' => $s['user_id'], 'amountMinor' => (int) $s['amount'],
            ], $shareRows),
        ];
    }
}
