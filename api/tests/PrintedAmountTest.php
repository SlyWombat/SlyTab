<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SlyTab\Support\Money;

/**
 * Printed receipt amounts → minor units (issue #75).
 *
 * The separators are the whole problem: "88.930" is 88,930 pesos in Chile
 * and 88 dollars 93 cents in the US. The digits cannot tell you which, so
 * the currency has to. These are the cases that shipped a real receipt
 * 1000x too small.
 */
final class PrintedAmountTest extends TestCase
{
    /** @return list<array{0:string, 1:string, 2:?int}> */
    public static function amounts(): array
    {
        return [
            // --- the receipts that caused the bug (Transbank, Valle Nevado) ---
            'CLP total with grouping dot' => ['$88.930', 'CLP', 88930],
            'CLP subtotal' => ['$69.700', 'CLP', 69700],
            'CLP tip' => ['$19.230', 'CLP', 19230],
            'CLP line item' => ['$58.571', 'CLP', 58571],
            'CLP second receipt total' => ['$80.190', 'CLP', 80190],

            // --- zero-decimal currencies have no sub-units, ever ---
            'JPY grouped' => ['¥1,250', 'JPY', 1250],
            'JPY dotted' => ['1.250', 'JPY', 1250],
            'KRW large' => ['₩1,234,567', 'KRW', 1234567],
            'CLP plain' => ['4240', 'CLP', 4240],
            // Even a "decimal-looking" tail is grouping here — this is the
            // exact reading that produced 89 instead of 88930.
            'CLP never has cents' => ['12.50', 'CLP', 1250],

            // --- two-decimal currencies: last separator + 2 digits = decimal ---
            'USD plain cents' => ['$12.99', 'USD', 1299],
            'USD grouped' => ['$1,234.56', 'USD', 123456],
            'EUR european format' => ['1.234,56', 'EUR', 123456],
            'EUR cents only' => ['0,99', 'EUR', 99],
            'CAD one decimal digit' => ['$4.5', 'CAD', 450],
            'USD no separator' => ['1299', 'USD', 129900],
            'USD grouped no cents' => ['1,234', 'USD', 123400],
            'GBP negative' => ['-£12.99', 'GBP', -1299],

            // --- junk ---
            'empty' => ['', 'USD', null],
            'no digits' => ['n/a', 'USD', null],
        ];
    }

    #[DataProvider('amounts')]
    public function testPrintedAmountsBecomeMinorUnits(string $printed, string $currency, ?int $expected): void
    {
        self::assertSame($expected, Money::parsePrinted($printed, $currency));
    }

    /**
     * The heart of it: identical printed text, different answer, because
     * the currency decides what the separator means.
     */
    public function testTheSameTextMeansDifferentThingsInDifferentCurrencies(): void
    {
        self::assertSame(88930, Money::parsePrinted('88.930', 'CLP'));
        self::assertSame(8893, Money::parsePrinted('88.93', 'USD'));
        // and the CLP reading is NOT reachable by rounding the USD one —
        // which is why this has to happen before the value becomes a number
        self::assertNotSame(
            Money::parsePrinted('88.930', 'CLP'),
            Money::parsePrinted('88.930', 'USD') * 10,
        );
    }
}
