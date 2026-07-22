<?php

declare(strict_types=1);

namespace SlySplit\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SlySplit\Domain\Simplify;
use SlySplit\Domain\Split;

/**
 * The cross-language parity gate (architecture §3): these are the SAME
 * fixtures packages/core asserts with Vitest. If this suite and the Vitest
 * suite both pass, the TS and PHP money math agree.
 */
final class SharedVectorsTest extends TestCase
{
    private static function vectors(string $file): array
    {
        $path = dirname(__DIR__, 2) . '/packages/core/test-vectors/' . $file;
        $json = json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
        return $json['cases'];
    }

    public static function splitCases(): iterable
    {
        foreach (self::vectors('split.json') as $case) {
            yield $case['name'] => [$case];
        }
    }

    public static function simplifyCases(): iterable
    {
        foreach (self::vectors('simplify.json') as $case) {
            yield $case['name'] => [$case];
        }
    }

    #[DataProvider('splitCases')]
    public function testSplitVector(array $case): void
    {
        $result = Split::compute($case['method'], $case['totalMinor'], $case['members']);
        self::assertEquals($case['expected'], $result);
        self::assertSame($case['totalMinor'], array_sum($result), 'split must reconcile to the cent');
    }

    #[DataProvider('simplifyCases')]
    public function testSimplifyVector(array $case): void
    {
        self::assertEquals($case['expected'], Simplify::debts($case['net']));
    }

    public function testSplitRejectsUnreconciledExact(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Split::compute('exact', 5000, [
            ['id' => 'u1', 'exactMinor' => 2000],
            ['id' => 'u2', 'exactMinor' => 2999],
        ]);
    }

    public function testSimplifyRejectsNonZeroSum(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Simplify::debts(['a' => 100, 'b' => -50]);
    }
}
