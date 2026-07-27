<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Money;
use SlyTab\Support\Ulid;

/**
 * Splitwise group-CSV import.
 *
 * The export format is: Date,Description,Category,Cost,Currency,<member…>
 * where each member column holds that row's NET effect on the member
 * (paid − share, decimal). Exact payer/share attribution is not present in
 * the export, so rows are reconstructed BALANCE-EXACTLY:
 *
 *   · members with negative net owe exactly −net (share = −net, paid 0)
 *   · members with positive net are the payers; the cost not covered by
 *     the negative shares (their own consumption) is distributed among
 *     them proportionally to their nets, largest-remainder, id-ordered
 *
 * Every imported row reproduces the CSV's per-member nets to the cent.
 * "Payment" rows become confirmed settlements. Rows with no balance
 * effect (personal expenses) are skipped and reported.
 */
final class ImportService
{
    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
        private readonly ExpenseService $expenses,
        private readonly ActivityService $activity,
    ) {}

    /**
     * Inspect a CSV without writing anything — returns what the client
     * needs to build the member-mapping UI.
     *
     * @return array<string,mixed>
     */
    public function inspect(string $csv): array
    {
        $doc = self::parse($csv);
        return [
            'members' => $doc['members'],
            'expenseRows' => count(array_filter($doc['rows'], fn(array $r): bool => !$r['isPayment'])),
            'paymentRows' => count(array_filter($doc['rows'], fn(array $r): bool => $r['isPayment'])),
            'currencies' => array_values(array_unique(array_column($doc['rows'], 'currency'))),
            'dateRange' => $doc['rows'] === [] ? null : [
                'from' => min(array_column($doc['rows'], 'date')),
                'to' => max(array_column($doc['rows'], 'date')),
            ],
        ];
    }

    /**
     * Import the CSV into a group. $mapping: csv member name → userId
     * (every CSV member must be mapped to an active group member).
     *
     * @param array<string,string> $mapping
     * @return array<string,mixed>
     */
    public function import(string $groupId, string $userId, string $csv, array $mapping): array
    {
        $this->groups->assertWritable($groupId);
        $doc = self::parse($csv);

        foreach ($doc['members'] as $name) {
            $mapped = $mapping[$name] ?? null;
            if (!is_string($mapped) || $mapped === '') {
                throw new ApiException('VALIDATION', "CSV member '{$name}' is not mapped to a group member", 422);
            }
            $this->groups->assertMemberParticipant($groupId, $mapped);
        }
        if (count(array_unique(array_values($mapping))) !== count($doc['members'])) {
            throw new ApiException('VALIDATION', 'each CSV member must map to a different group member', 422);
        }

        $group = $this->groups->get($groupId);
        $imported = ['expenses' => 0, 'settlements' => 0, 'skipped' => 0, 'duplicates' => 0];
        $errors = [];

        foreach ($doc['rows'] as $n => $row) {
            $label = "row {$row['line']} ({$row['description']})";
            try {
                $nets = [];
                foreach ($row['nets'] as $name => $cents) {
                    $nets[$mapping[$name]] = $cents;
                }
                self::fixResidual($nets, $label);

                if ($row['isPayment']) {
                    $this->importPayment($groupId, $group['homeCurrency'], $row, $nets, $label);
                    $imported['settlements']++;
                    continue;
                }

                $active = array_filter($nets, fn(int $v): bool => $v !== 0);
                if ($active === []) {
                    $imported['skipped']++; // personal expense — no balance effect
                    continue;
                }
                [$payers, $shares] = self::reconstruct($row['cost'], $nets, $label);
                // Re-importing the same export must not double the group's
                // spending: rows already present are dropped, not re-filed
                // (owner, issue #76).
                if ($this->alreadyImported($groupId, $row)) {
                    $imported['duplicates']++;
                    continue;
                }
                $this->expenses->create($groupId, $userId, [
                    'description' => $row['description'],
                    'amountMinor' => $row['cost'],
                    'currency' => $row['currency'],
                    'expenseDate' => $row['date'],
                    'category' => self::mapCategory($row['category']),
                    'splitMethod' => 'exact',
                    'splitInput' => ['imported' => 'splitwise'],
                    'payers' => $payers,
                    'shares' => $shares,
                    // The dedup above already compared this row against what
                    // the group holds. Two IDENTICAL rows within one export
                    // are legitimate (the same round bought twice), so the
                    // per-expense guard must not reject the second one.
                    'allowDuplicate' => true,
                ], recordActivity: false);
                $imported['expenses']++;
            } catch (ApiException $e) {
                $errors[] = "{$label}: {$e->getMessage()}";
            }
        }

        $this->activity->record($groupId, $userId, 'imported', 'group', $groupId, [
            'source' => 'splitwise',
        ] + $imported);
        return ['imported' => $imported, 'errors' => $errors];
    }

    /**
     * Has this CSV row already been imported into the group? Matched on
     * date + description + amount + currency, the fields the export
     * carries; the split is not compared, since a row whose shares were
     * edited after import is still that row (issue #76).
     *
     * @param array<string,mixed> $row
     */
    private function alreadyImported(string $groupId, array $row): bool
    {
        $stmt = $this->pdo->prepare(
            'SELECT 1 FROM expenses
             WHERE group_id = ? AND deleted_at IS NULL AND expense_date = ?
               AND description = ? AND amount = ? AND currency = ? LIMIT 1',
        );
        $stmt->execute([
            $groupId, $row['date'],
            $row['description'] === '' ? '(no description)' : $row['description'],
            $row['cost'], $row['currency'],
        ]);
        return $stmt->fetchColumn() !== false;
    }

    // ---- reconstruction ----

    /**
     * @param array<string,int> $nets userId => net cents (sum 0)
     * @return array{0: list<array{userId:string,amountMinor:int}>, 1: list<array{userId:string,amountMinor:int}>}
     */
    private static function reconstruct(int $cost, array $nets, string $label): array
    {
        $positives = array_filter($nets, fn(int $v): bool => $v > 0);
        $negatives = array_filter($nets, fn(int $v): bool => $v < 0);
        if ($positives === []) {
            throw new ApiException('VALIDATION', 'no payer implied by the row', 422);
        }
        $covered = -array_sum($negatives);          // shares owed by the borrowers
        $own = $cost - $covered;                    // the payers' own consumption
        if ($own < 0) {
            throw new ApiException('VALIDATION', 'row nets exceed its cost', 422);
        }

        // Distribute the payers' own consumption among them proportionally
        // to their positive nets (largest remainder, id-ordered ties).
        $totalPos = array_sum($positives);
        ksort($positives);
        $ownShares = [];
        $assigned = 0;
        foreach ($positives as $uid => $net) {
            $ownShares[$uid] = intdiv($own * $net, $totalPos);
            $assigned += $ownShares[$uid];
        }
        $rem = $own - $assigned;
        $order = array_keys($positives);
        usort($order, fn(string $a, string $b): int =>
            [($own * $positives[$b]) % $totalPos, $a] <=> [($own * $positives[$a]) % $totalPos, $b]);
        foreach ($order as $uid) {
            if ($rem === 0) {
                break;
            }
            $ownShares[$uid]++;
            $rem--;
        }

        $payers = [];
        $shares = [];
        foreach ($positives as $uid => $net) {
            $payers[] = ['userId' => $uid, 'amountMinor' => $net + $ownShares[$uid]];
            if ($ownShares[$uid] > 0) {
                $shares[] = ['userId' => $uid, 'amountMinor' => $ownShares[$uid]];
            }
        }
        foreach ($negatives as $uid => $net) {
            $shares[] = ['userId' => $uid, 'amountMinor' => -$net];
        }
        return [$payers, $shares];
    }

    /** @param array<string,int> $nets */
    private function importPayment(string $groupId, string $homeCurrency, array $row, array $nets, string $label): void
    {
        $from = array_keys(array_filter($nets, fn(int $v): bool => $v > 0));
        $to = array_keys(array_filter($nets, fn(int $v): bool => $v < 0));
        if (count($from) !== 1 || count($to) !== 1) {
            throw new ApiException('VALIDATION', 'payment row must involve exactly two members', 422);
        }
        if ($row['currency'] !== $homeCurrency) {
            throw new ApiException('VALIDATION', 'payment currency differs from the group home currency', 422);
        }
        $this->pdo->prepare(
            "INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, method, note, status, confirmed_at)
             VALUES (?, ?, ?, ?, ?, ?, 'other', 'Imported from Splitwise', 'confirmed', ?)",
        )->execute([
            Ulid::generate(), $groupId, $from[0], $to[0], $row['cost'], $row['currency'], Db::now(),
        ]);
    }

    /**
     * Splitwise rounds per-member columns independently; nudge tiny
     * residuals onto the largest participant so nets sum to zero.
     *
     * @param array<string,int> $nets
     */
    private static function fixResidual(array &$nets, string $label): void
    {
        $residual = array_sum($nets);
        if ($residual === 0) {
            return;
        }
        if (abs($residual) > count($nets)) {
            throw new ApiException('VALIDATION', "row nets are off by more than rounding ({$residual}¢)", 422);
        }
        $target = null;
        foreach ($nets as $uid => $v) {
            if ($target === null || abs($v) > abs($nets[$target])
                || (abs($v) === abs($nets[$target]) && $uid < $target)) {
                $target = $uid;
            }
        }
        $nets[$target] -= $residual;
    }

    // ---- CSV parsing ----

    /**
     * Uploads are not always the UTF-8 CSV Splitwise handed out: people
     * open it in Excel first, which re-saves as Windows-1252 (any accented
     * name then breaks) or as a .xlsx workbook. Both used to reach the BOM
     * strip below, where preg_* with /u returns null on invalid UTF-8 and
     * the request 500'd. Fail with something the user can act on instead.
     */
    private static function asUtf8Text(string $csv): string
    {
        if (str_starts_with($csv, "PK\x03\x04") || str_contains($csv, "\0")) {
            throw new ApiException(
                'VALIDATION',
                'that looks like a spreadsheet, not a CSV — in Splitwise use Export as CSV and upload that file',
                422,
            );
        }
        if (mb_check_encoding($csv, 'UTF-8')) {
            return $csv;
        }
        $converted = mb_convert_encoding($csv, 'UTF-8', 'Windows-1252');
        if (!mb_check_encoding($converted, 'UTF-8')) {
            throw new ApiException(
                'VALIDATION',
                'this file is not readable as text — re-download the CSV export from Splitwise',
                422,
            );
        }
        return $converted;
    }

    /** @return array{members: list<string>, rows: list<array<string,mixed>>} */
    private static function parse(string $csv): array
    {
        $csv = self::asUtf8Text($csv);
        $csv = preg_replace('/^\x{FEFF}/u', '', $csv) ?? $csv; // strip BOM
        $lines = preg_split('/\r\n|\r|\n/', $csv);
        if ($lines === false || count($lines) < 2) {
            throw new ApiException('VALIDATION', 'this does not look like a Splitwise CSV export', 422);
        }

        $header = str_getcsv($lines[0]);
        $expected = ['Date', 'Description', 'Category', 'Cost', 'Currency'];
        if (array_map('trim', array_slice($header, 0, 5)) !== $expected) {
            throw new ApiException('VALIDATION', 'unexpected header — export the group as a CSV from Splitwise', 422);
        }
        $members = array_values(array_filter(array_map('trim', array_slice($header, 5)), fn(string $m): bool => $m !== ''));
        if ($members === []) {
            throw new ApiException('VALIDATION', 'no member columns found in the CSV', 422);
        }

        $rows = [];
        foreach (array_slice($lines, 1) as $i => $line) {
            if (trim($line) === '') {
                continue;
            }
            $f = str_getcsv($line);
            $date = trim($f[0] ?? '');
            $description = trim($f[1] ?? '');
            if ($date === '' || strcasecmp($description, 'Total balance') === 0) {
                continue; // summary/footer rows
            }
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
                throw new ApiException('VALIDATION', 'unrecognised date on line ' . ($i + 2), 422);
            }
            $currency = strtoupper(trim($f[4] ?? ''));
            if (!preg_match('/^[A-Z]{3}$/', $currency)) {
                throw new ApiException('VALIDATION', 'unrecognised currency on line ' . ($i + 2), 422);
            }
            $nets = [];
            foreach ($members as $k => $name) {
                $nets[$name] = self::minor($f[5 + $k] ?? '0', $currency);
            }
            $rows[] = [
                'line' => $i + 2,
                'date' => $date,
                'description' => $description === '' ? '(no description)' : $description,
                'category' => trim($f[2] ?? ''),
                'cost' => self::minor($f[3] ?? '0', $currency),
                'currency' => $currency,
                'nets' => $nets,
                'isPayment' => strcasecmp(trim($f[2] ?? ''), 'Payment') === 0,
            ];
        }
        return ['members' => $members, 'rows' => $rows];
    }

    /**
     * Decimal text → minor units at the ROW's currency scale. Splitwise
     * writes decimals even for zero-decimal currencies ("-7223.33" CLP),
     * so those round to whole units here and fixResidual() absorbs the
     * leftover; assuming cents made every CLP/JPY/KRW row 100x too big.
     */
    private static function minor(string $value, string $currency): int
    {
        $value = str_replace(',', '', trim($value));
        if ($value === '' || !is_numeric($value)) {
            return 0;
        }
        return (int) round(((float) $value) * Money::scale($currency));
    }

    /**
     * Splitwise's ~50 category names onto our taxonomy (#18). Before
     * subcategories existed this could only reach the five headings, so a
     * third of a real export piled into "other" — Splitwise's catch-all
     * "General" plus everything entertainment-shaped. Leaves fix that.
     *
     * Order matters: the first match wins, so the specific patterns come
     * before the broad ones ("liquor store" before "store").
     */
    public static function mapCategory(string $splitwise): string
    {
        $sw = strtolower(trim($splitwise));
        if ($sw === '' || $sw === 'general' || $sw === 'other') {
            return 'other';
        }
        foreach (self::CATEGORY_PATTERNS as $slug => $needles) {
            foreach ($needles as $needle) {
                if (str_contains($sw, $needle)) {
                    return $slug;
                }
            }
        }
        return 'other';
    }

    /** @var array<string, list<string>> slug => Splitwise substrings, specific first */
    private const CATEGORY_PATTERNS = [
        'drinks.liquor' => ['liquor', 'alcohol'],
        'drinks.wine' => ['wine'],
        'drinks.beer' => ['beer'],
        'drinks.coffee' => ['coffee', 'cafe'],
        'drinks.bar' => ['bar', 'drink', 'pub', 'nightlife'],
        'dining.groceries' => ['grocer', 'market'],
        'dining.restaurant' => ['dining', 'restaurant', 'food'],
        'dining.takeout' => ['takeout', 'delivery'],
        'dining.dessert' => ['dessert', 'ice cream'],
        'dining.snacks' => ['snack'],
        'travel.taxi' => ['taxi', 'uber', 'lyft', 'rideshare', 'cab'],
        'travel.flights' => ['plane', 'flight', 'airfare', 'airline'],
        'travel.lodging' => ['hotel', 'lodging', 'airbnb', 'accommodation'],
        'travel.fuel' => ['gas/fuel', 'fuel', 'petrol'],
        'travel.transit' => ['bus', 'train', 'transit', 'subway', 'metro'],
        'travel.rental' => ['car rental', 'rental car'],
        'travel.parking' => ['parking', 'toll'],
        'adulting.rent' => ['rent', 'mortgage'],
        'adulting.utilities' => ['utilit', 'electric', 'water', 'heat', 'gas bill', 'trash'],
        'adulting.internet' => ['internet', 'phone', 'tv', 'cable'],
        'adulting.insurance' => ['insurance'],
        'adulting.household' => ['household', 'home supplies', 'cleaning'],
        'adulting.maintenance' => ['maintenance', 'repair', 'furniture', 'appliance'],
        'adulting.medical' => ['medical', 'doctor', 'pharmac', 'health'],
        'other.entertainment' => ['entertainment', 'movie', 'music', 'game', 'sport'],
        'other.activities' => ['activit', 'ticket', 'tour', 'museum'],
        'other.shopping' => ['shopping', 'clothing', 'electronics'],
        'other.gifts' => ['gift', 'donation'],
        'other.fees' => ['fee', 'tax', 'service charge', 'bank'],
        'other.pets' => ['pet', 'dog', 'cat'],
        // Broad fallbacks — only reached when nothing specific matched.
        'travel' => ['transport', 'travel', 'car'],
        'adulting' => ['home', 'life'],
    ];
}
