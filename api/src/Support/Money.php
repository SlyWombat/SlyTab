<?php

declare(strict_types=1);

namespace SlyTab\Support;

/**
 * Minor-unit scales. Most currencies store cents (scale 100); the
 * zero-decimal set stores whole units (scale 1) — mirror of
 * packages/core/src/money.ts ZERO_DECIMAL_CURRENCIES. Cross-currency
 * conversion must bridge the scales: a 4,240-peso Cabify ride is 4240
 * CLP-minor but ≈452 USD-minor (issue: it showed as US$0.05).
 */
final class Money
{
    private const ZERO_DECIMAL = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'];

    public static function scale(string $currency): int
    {
        return in_array($currency, self::ZERO_DECIMAL, true) ? 1 : 100;
    }

    /** Convert minor units across currencies with a value rate (to per from). */
    public static function convert(int $minor, float $rate, string $from, string $to): int
    {
        return (int) round($minor / self::scale($from) * $rate * self::scale($to), 0, PHP_ROUND_HALF_UP);
    }
}
