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

    /**
     * An amount as PRINTED on a receipt → minor units of $currency.
     *
     * The separators are the whole problem (issue #75). "88.930" is 88,930
     * pesos in Chile and 88 dollars 93 cents in the US, and the digits
     * alone cannot tell you which — so the currency decides:
     *
     *  · zero-decimal currency (CLP, JPY, …): sub-units do not exist, so
     *    EVERY separator is grouping. "88.930" → 88930.
     *  · otherwise: a separator followed by exactly two digits (and no
     *    further separator) is the decimal point; the rest is grouping.
     *    "1.234,56" → 123456, "1,234.56" → 123456, "1.234" → 123400.
     *
     * The last case is the deliberate one: with two decimal places
     * available, a lone "1.234" is far more likely to be twelve hundred
     * than one euro twenty-three, because printed prices carry both
     * decimals ("1.23", never "1.234").
     *
     * Returns null when the text holds no digits.
     */
    public static function parsePrinted(string $printed, string $currency): ?int
    {
        // Keep digits and separators; drop symbols, spaces, letters.
        $s = preg_replace('/[^0-9.,\-]/u', '', $printed) ?? '';
        $negative = str_starts_with($s, '-');
        $s = ltrim($s, '-');
        if ($s === '' || preg_match('/\d/', $s) !== 1 && !preg_match('/\d/', $s)) {
            return null;
        }

        $scale = self::scale($currency);
        $digits = str_replace(['.', ','], '', $s);
        if ($digits === '' || !ctype_digit($digits)) {
            return null;
        }

        if ($scale === 1) {
            // No sub-units exist in this currency: every separator groups.
            $minor = (int) $digits;
            return $negative ? -$minor : $minor;
        }

        // Two-decimal currency: is the LAST separator a decimal point?
        $frac = '';
        if (preg_match('/[.,](\d{1,2})$/', $s, $m) === 1) {
            $tail = $m[1];
            // ".5" means 50 cents, ".56" means 56.
            $frac = strlen($tail) === 1 ? $tail . '0' : $tail;
            $digits = substr($digits, 0, -strlen($tail));
        }
        $whole = $digits === '' ? '0' : $digits;
        $minor = (int) $whole * $scale + (int) ($frac === '' ? '0' : $frac);
        return $negative ? -$minor : $minor;
    }
}
