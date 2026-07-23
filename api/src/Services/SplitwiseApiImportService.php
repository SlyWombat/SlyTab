<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Direct Splitwise import over their REST API (v3.0) using the user's
 * personal API key (secure.splitwise.com/apps). Unlike the CSV export,
 * the API returns each member's exact paid_share/owed_share per expense,
 * so no reconstruction is needed — rows import verbatim.
 *
 * The key is used for the requests in hand and never stored.
 */
class SplitwiseApiImportService
{
    private const BASE = 'https://secure.splitwise.com/api/v3.0';

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly ExpenseService $expenses,
        private readonly ActivityService $activity,
    ) {}

    /**
     * The user's Splitwise groups, for the picker.
     * @return list<array{id:int, name:string, members:list<array{id:int, name:string}>}>
     */
    public function listGroups(string $apiKey): array
    {
        $data = $this->fetch($apiKey, 'get_groups');
        $out = [];
        foreach ($data['groups'] ?? [] as $g) {
            $out[] = [
                'id' => (int) ($g['id'] ?? 0),
                'name' => (string) ($g['name'] ?? ''),
                'members' => array_values(array_map(
                    static fn(array $m): array => [
                        'id' => (int) ($m['id'] ?? 0),
                        'name' => trim(($m['first_name'] ?? '') . ' ' . ($m['last_name'] ?? '')),
                    ],
                    $g['members'] ?? [],
                )),
            ];
        }
        return $out;
    }

    /**
     * Import every non-deleted expense of a Splitwise group.
     *
     * Mapping values are either an existing member's user id, or (issue
     * #2) an object {email, name}: that person isn't on SlyTab yet, so a
     * placeholder member is created to hold their history and an invite
     * email goes out; registering with the email claims the account.
     *
     * @param array<string,mixed> $mapping Splitwise user id => user id | {email, name}
     * @return array{imported: array{expenses:int, settlements:int, skipped:int}, invited: list<string>, errors: list<string>}
     */
    public function import(string $groupId, string $userId, string $apiKey, int $swGroupId, array $mapping): array
    {
        $this->groups->assertWritable($groupId);
        $resolved = [];
        $invited = [];
        foreach ($mapping as $swId => $mapped) {
            if (is_array($mapped) && isset($mapped['email'])) {
                $resolved[(string) $swId] = $this->groups->addMemberByEmail(
                    $groupId, $userId, (string) $mapped['email'], (string) ($mapped['name'] ?? ''),
                );
                $invited[] = strtolower(trim((string) $mapped['email']));
            } elseif (is_string($mapped) && $mapped !== '') {
                $this->groups->assertMemberParticipant($groupId, $mapped);
                $resolved[(string) $swId] = $mapped;
            } else {
                throw new ApiException('VALIDATION', 'each Splitwise member needs a group member or an email', 422);
            }
        }
        $mapping = $resolved;
        if (count(array_unique(array_values($mapping))) !== count($mapping)) {
            throw new ApiException('VALIDATION', 'each Splitwise member must map to a different group member', 422);
        }
        $group = $this->groups->get($groupId);

        $imported = ['expenses' => 0, 'settlements' => 0, 'skipped' => 0];
        $errors = [];
        $offset = 0;
        do {
            $data = $this->fetch($apiKey, "get_expenses?group_id={$swGroupId}&limit=100&offset={$offset}");
            $batch = $data['expenses'] ?? [];
            foreach ($batch as $e) {
                if (($e['deleted_at'] ?? null) !== null) {
                    continue;
                }
                $label = "{$e['date']} ({$e['description']})";
                try {
                    $this->importOne($group, $userId, $e, $mapping, $imported);
                } catch (ApiException $ex) {
                    $errors[] = "{$label}: {$ex->getMessage()}";
                }
            }
            $offset += count($batch);
        } while (count($batch) === 100);

        $this->activity->record($groupId, $userId, 'imported', 'group', $groupId, [
            'source' => 'splitwise-api',
        ] + $imported);
        return ['imported' => $imported, 'invited' => $invited, 'errors' => $errors];
    }

    /**
     * @param array<string,mixed> $group @param array<string,mixed> $e
     * @param array<string,string> $mapping @param array<string,int> $imported
     */
    private function importOne(array $group, string $userId, array $e, array $mapping, array &$imported): void
    {
        $payers = [];
        $shares = [];
        foreach ($e['users'] ?? [] as $u) {
            $swId = (string) ($u['user_id'] ?? $u['user']['id'] ?? '');
            $mapped = $mapping[$swId] ?? null;
            $paid = self::cents((string) ($u['paid_share'] ?? '0'));
            $owed = self::cents((string) ($u['owed_share'] ?? '0'));
            if ($mapped === null) {
                if ($paid !== 0 || $owed !== 0) {
                    throw new ApiException('VALIDATION', "Splitwise member {$swId} is not mapped", 422);
                }
                continue;
            }
            if ($paid > 0) {
                $payers[] = ['userId' => $mapped, 'amountMinor' => $paid];
            }
            if ($owed > 0) {
                $shares[] = ['userId' => $mapped, 'amountMinor' => $owed];
            }
        }
        if ($payers === [] && $shares === []) {
            $imported['skipped']++;
            return;
        }

        $date = substr((string) $e['date'], 0, 10);
        $cost = self::cents((string) $e['cost']);
        $currency = strtoupper((string) ($e['currency_code'] ?? $group['homeCurrency']));

        if (($e['payment'] ?? false) === true) {
            if (count($payers) !== 1 || count($shares) !== 1) {
                throw new ApiException('VALIDATION', 'payment must involve exactly two members', 422);
            }
            if ($currency !== $group['homeCurrency']) {
                throw new ApiException('VALIDATION', 'payment currency differs from the group home currency', 422);
            }
            $this->pdo->prepare(
                "INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, method, note, status, confirmed_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'other', 'Imported from Splitwise', 'confirmed', ?)",
            )->execute([
                Ulid::generate(), $group['id'], $payers[0]['userId'], $shares[0]['userId'],
                $cost, $currency, Db::now(),
            ]);
            $imported['settlements']++;
            return;
        }

        $this->expenses->create($group['id'], $userId, [
            'description' => (string) $e['description'],
            'amountMinor' => $cost,
            'currency' => $currency,
            'expenseDate' => $date,
            'category' => ImportService::mapCategory((string) ($e['category']['name'] ?? '')),
            'splitMethod' => 'exact',
            'splitInput' => ['imported' => 'splitwise-api'],
            'payers' => $payers,
            'shares' => $shares,
        ], recordActivity: false);
        $imported['expenses']++;
    }

    /** Splitwise decimals arrive as strings ("12.34") — convert exactly. */
    private static function cents(string $decimal): int
    {
        return (int) round(((float) $decimal) * 100);
    }

    /**
     * GET an endpoint with the personal API key. Overridden in tests.
     * @return array<string,mixed>
     */
    protected function fetch(string $apiKey, string $endpoint): array
    {
        $ch = curl_init(self::BASE . '/' . $endpoint);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $apiKey],
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($status === 401 || $status === 403) {
            throw new ApiException('SPLITWISE_AUTH', 'Splitwise rejected the API key', 401);
        }
        if ($body === false || $status !== 200) {
            throw new ApiException('SPLITWISE_ERROR', 'could not reach Splitwise — try again', 502);
        }
        $data = json_decode((string) $body, true);
        if (!is_array($data)) {
            throw new ApiException('SPLITWISE_ERROR', 'unexpected response from Splitwise', 502);
        }
        return $data;
    }
}
