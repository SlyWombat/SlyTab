<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;

/**
 * ECB reference rates — FR-5.x. The fx_rates table is filled by
 * bin/fetch-rates.php (daily cPanel cron) with EUR-base rows; cross rates
 * derive through EUR. Rates are looked up for the expense date, falling
 * back up to 7 prior days (weekends/holidays).
 */
final class FxService
{
    private const MAX_FALLBACK_DAYS = 7;

    public function __construct(private readonly PDO $pdo) {}

    public function rateFor(string $date, string $from, string $to): float
    {
        if ($from === $to) {
            return 1.0;
        }
        $fromEur = $this->eurRate($date, $from); // 1 EUR = X from-units
        $toEur = $this->eurRate($date, $to);
        return $toEur / $fromEur;
    }

    private function eurRate(string $date, string $currency): float
    {
        if ($currency === 'EUR') {
            return 1.0;
        }
        $stmt = $this->pdo->prepare(
            'SELECT rate FROM fx_rates
             WHERE base = ? AND quote = ? AND rate_date <= ? AND rate_date >= DATE_SUB(?, INTERVAL ? DAY)
             ORDER BY rate_date DESC LIMIT 1',
        );
        $stmt->execute(['EUR', $currency, $date, $date, self::MAX_FALLBACK_DAYS]);
        $rate = $stmt->fetchColumn();
        if ($rate === false) {
            throw new ApiException(
                'FX_RATE_UNAVAILABLE',
                "no exchange rate available for {$currency} on {$date} — enter the rate manually",
                422,
            );
        }
        return (float) $rate;
    }
}
