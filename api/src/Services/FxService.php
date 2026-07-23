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

    /**
     * Currencies the ECB feed doesn't cover (Chilean peso and friends —
     * issue from real use: a receipt scanned in Chile had no CLP support).
     * Rates come from the open daily currency-api feed instead.
     */
    private const EXTRA_CURRENCIES = [
        'AED', 'ARS', 'BOB', 'CLP', 'COP', 'CRC', 'DOP', 'EGP', 'GTQ', 'JOD',
        'KES', 'LKR', 'MAD', 'PEN', 'PKR', 'QAR', 'RSD', 'SAR', 'TWD', 'UAH',
        'UYU', 'VND',
    ];

    public function __construct(private readonly PDO $pdo) {}

    /**
     * Pull the latest EUR-base ECB reference rates from frankfurter and
     * upsert them. Only currency codes leave the server (NFR-1).
     *
     * @return array{date:string, count:int}
     */
    public function refresh(): array
    {
        $json = @file_get_contents('https://api.frankfurter.dev/v1/latest?base=EUR');
        if ($json === false) {
            throw new ApiException('FX_FETCH_FAILED', 'could not reach the exchange-rate service', 502);
        }
        $data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
        $rates = $data['rates'] + ['EUR' => 1.0];
        $stmt = $this->pdo->prepare(
            'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
        );
        foreach ($rates as $quote => $rate) {
            $stmt->execute([$data['date'], 'EUR', $quote, (string) $rate]);
        }
        $extra = $this->fetchExtraRates(null);
        return ['date' => $data['date'], 'count' => count($rates) + $extra];
    }

    /**
     * Secondary source for EXTRA_CURRENCIES: the keyless daily
     * currency-api feed (EUR base), latest or a specific date.
     * Soft-fails to 0 — a missing rate surfaces later as
     * FX_RATE_UNAVAILABLE with a manual-rate escape hatch.
     */
    private function fetchExtraRates(?string $date): int
    {
        if (\SlyTab\Support\Env::get('FX_OFFLINE') !== '') {
            return 0;
        }
        $tag = $date ?? 'latest';
        $urls = [
            "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{$tag}/v1/currencies/eur.json",
            "https://{$tag}.currency-api.pages.dev/v1/currencies/eur.json",
        ];
        foreach ($urls as $url) {
            $json = @file_get_contents($url);
            if ($json === false) {
                continue;
            }
            try {
                $data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                continue;
            }
            $eur = $data['eur'] ?? [];
            $stamp = $data['date'] ?? $date ?? gmdate('Y-m-d');
            $stmt = $this->pdo->prepare(
                'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
            );
            $count = 0;
            foreach (self::EXTRA_CURRENCIES as $code) {
                $rate = $eur[strtolower($code)] ?? null;
                if (is_numeric($rate) && $rate > 0) {
                    $stmt->execute([$stamp, 'EUR', $code, (string) $rate]);
                    $count++;
                }
            }
            return $count;
        }
        return 0;
    }

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
        $rate = $this->lookup($date, $currency);
        if ($rate === null && $date < gmdate('Y-m-d')) {
            // Historical date (e.g. Splitwise import): fetch that day's ECB
            // reference from frankfurter on demand. Currency codes only.
            $this->fetchHistorical($date);
            $rate = $this->lookup($date, $currency);
        }
        if ($rate === null && in_array($currency, self::EXTRA_CURRENCIES, true)) {
            $this->fetchExtraRates($date < gmdate('Y-m-d') ? $date : null);
            $rate = $this->lookup($date, $currency);
        }
        if ($rate === null) {
            throw new ApiException(
                'FX_RATE_UNAVAILABLE',
                "no exchange rate available for {$currency} on {$date} — enter the rate manually",
                422,
            );
        }
        return $rate;
    }

    private function lookup(string $date, string $currency): ?float
    {
        $stmt = $this->pdo->prepare(
            'SELECT rate FROM fx_rates
             WHERE base = ? AND quote = ? AND rate_date <= ? AND rate_date >= DATE_SUB(?, INTERVAL ? DAY)
             ORDER BY rate_date DESC LIMIT 1',
        );
        $stmt->execute(['EUR', $currency, $date, $date, self::MAX_FALLBACK_DAYS]);
        $rate = $stmt->fetchColumn();
        return $rate === false ? null : (float) $rate;
    }

    private function fetchHistorical(string $date): void
    {
        if (\SlyTab\Support\Env::get('FX_OFFLINE') !== '') {
            return; // tests: never reach for the network
        }
        $json = @file_get_contents("https://api.frankfurter.dev/v1/{$date}?base=EUR");
        if ($json === false) {
            return; // lookup miss will surface as FX_RATE_UNAVAILABLE
        }
        try {
            $data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return;
        }
        $stmt = $this->pdo->prepare(
            'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
        );
        foreach (($data['rates'] ?? []) + ['EUR' => 1.0] as $quote => $rate) {
            $stmt->execute([$data['date'] ?? $date, 'EUR', $quote, (string) $rate]);
        }
    }
}
