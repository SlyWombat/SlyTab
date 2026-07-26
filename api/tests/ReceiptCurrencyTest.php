<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SlyTab\Services\ReceiptService;

/**
 * The currency ranking rule for scanned receipts: a currency the model
 * actually read off the paper wins; a model guess loses to the caller's
 * hint (EXIF-GPS country, else the buyer's chosen currency). Regression
 * for report 01KYFV22E099CMFNW7867SW0FV — a Chilean "$"-only receipt
 * parsed as ARS over a correct GPS-derived CLP hint.
 */
final class ReceiptCurrencyTest extends TestCase
{
    public static function cases(): iterable
    {
        // [model currency, explicit on receipt?, hint, expected]
        yield 'guess loses to GPS hint (the Chile bug)' => ['ARS', false, 'CLP', 'CLP'];
        yield 'printed currency beats the hint' => ['EUR', true, 'CLP', 'EUR'];
        yield 'guess kept when there is no hint' => ['ARS', false, '', 'ARS'];
        yield 'printed currency kept with no hint' => ['CLP', true, '', 'CLP'];
        yield 'no model currency falls back to hint' => [null, false, 'CLP', 'CLP'];
        yield 'nothing at all stays null' => [null, false, '', null];
    }

    #[DataProvider('cases')]
    public function testResolveCurrency(?string $model, bool $explicit, string $hint, ?string $expected): void
    {
        self::assertSame($expected, ReceiptService::resolveCurrency($model, $explicit, $hint));
    }
}
