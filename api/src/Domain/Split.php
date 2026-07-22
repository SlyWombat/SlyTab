<?php

declare(strict_types=1);

namespace SlyTab\Domain;

use InvalidArgumentException;

/**
 * Split math — PHP twin of packages/core/src/split.ts.
 *
 * Both implementations must pass packages/core/test-vectors/split.json.
 * If you change one, change the other and update the vectors.
 *
 * All amounts are integer minor units. Remainder cents distribute by
 * largest remainder, ties broken by member id ascending. Integer math
 * only — no floats touch money (percent weights are pre-scaled to ints).
 */
final class Split
{
    private const PCT_SCALE = 10_000;

    /**
     * @param string $method  equal|exact|shares|percent|adjustment
     * @param int    $totalMinor
     * @param list<array{id:string, exactMinor?:int, shares?:int, percent?:float|int, adjustMinor?:int}> $members
     * @return array<string,int> member id => amount in minor units
     */
    public static function compute(string $method, int $totalMinor, array $members): array
    {
        if ($totalMinor < 0) {
            throw new InvalidArgumentException('total must not be negative');
        }
        if ($members === []) {
            throw new InvalidArgumentException('at least one member required');
        }
        $ids = array_column($members, 'id');
        if (count($ids) !== count(array_unique($ids))) {
            throw new InvalidArgumentException('duplicate member ids');
        }

        switch ($method) {
            case 'equal':
                return self::apportion($totalMinor, array_map(
                    static fn(array $m): array => ['id' => $m['id'], 'weight' => 1],
                    $members,
                ));

            case 'exact':
                $out = [];
                $sum = 0;
                foreach ($members as $m) {
                    if (!isset($m['exactMinor']) || !is_int($m['exactMinor'])) {
                        throw new InvalidArgumentException("missing exactMinor for {$m['id']}");
                    }
                    if ($m['exactMinor'] < 0) {
                        throw new InvalidArgumentException('exact amounts must not be negative');
                    }
                    $out[$m['id']] = $m['exactMinor'];
                    $sum += $m['exactMinor'];
                }
                if ($sum !== $totalMinor) {
                    throw new InvalidArgumentException("exact amounts sum to {$sum}, expected {$totalMinor}");
                }
                return $out;

            case 'shares':
                return self::apportion($totalMinor, array_map(
                    static function (array $m): array {
                        if (!isset($m['shares']) || !is_int($m['shares']) || $m['shares'] < 0) {
                            throw new InvalidArgumentException("shares must be a non-negative integer for {$m['id']}");
                        }
                        return ['id' => $m['id'], 'weight' => $m['shares']];
                    },
                    $members,
                ));

            case 'percent':
                $entries = array_map(
                    static function (array $m): array {
                        if (!isset($m['percent']) || $m['percent'] < 0) {
                            throw new InvalidArgumentException("percent must be provided and non-negative for {$m['id']}");
                        }
                        return ['id' => $m['id'], 'weight' => (int) round($m['percent'] * self::PCT_SCALE)];
                    },
                    $members,
                );
                $totalPct = array_sum(array_column($entries, 'weight'));
                if ($totalPct !== 100 * self::PCT_SCALE) {
                    $pretty = $totalPct / self::PCT_SCALE;
                    throw new InvalidArgumentException("percentages sum to {$pretty}, expected 100");
                }
                return self::apportion($totalMinor, $entries);

            case 'adjustment':
                $adjSum = 0;
                foreach ($members as $m) {
                    $adjSum += $m['adjustMinor'] ?? 0;
                }
                $pool = $totalMinor - $adjSum;
                if ($pool < 0) {
                    throw new InvalidArgumentException('adjustments exceed the total');
                }
                $base = self::apportion($pool, array_map(
                    static fn(array $m): array => ['id' => $m['id'], 'weight' => 1],
                    $members,
                ));
                $out = [];
                foreach ($members as $m) {
                    $out[$m['id']] = $base[$m['id']] + ($m['adjustMinor'] ?? 0);
                }
                return $out;

            default:
                throw new InvalidArgumentException("unknown split method: {$method}");
        }
    }

    /**
     * Integer largest-remainder apportionment.
     *
     * @param list<array{id:string, weight:int}> $entries
     * @return array<string,int>
     */
    private static function apportion(int $totalMinor, array $entries): array
    {
        $totalWeight = array_sum(array_column($entries, 'weight'));
        if ($totalWeight <= 0) {
            throw new InvalidArgumentException('total weight must be positive');
        }

        $rows = [];
        foreach ($entries as $e) {
            $num = $totalMinor * $e['weight'];
            $rows[] = [
                'id' => $e['id'],
                'base' => intdiv($num, $totalWeight),
                'rem' => $num % $totalWeight,
            ];
        }

        $leftover = $totalMinor - array_sum(array_column($rows, 'base'));

        $order = $rows;
        usort($order, static fn(array $a, array $b): int =>
            [$b['rem'], $a['id']] <=> [$a['rem'], $b['id']]);

        $out = [];
        foreach ($rows as $r) {
            $out[$r['id']] = $r['base'];
        }
        foreach ($order as $r) {
            if ($leftover === 0) {
                break;
            }
            $out[$r['id']]++;
            $leftover--;
        }
        return $out;
    }
}
