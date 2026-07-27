<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use SlyTab\Services\ReceiptService;

/**
 * End-to-end receipt parsing over the real images users have uploaded
 * (owner request, 2026-07-27) — the vision model included, not just the
 * arithmetic that PrintedAmountTest covers.
 *
 * Needs two things that CI does not have, so it SKIPS rather than fails
 * without them:
 *   · LOCAL_LLM_URL pointing at the Ollama host
 *   · the images, which are not committed (real receipts, card tails) —
 *     run scripts/dev/fetch-receipt-fixtures.sh to pull them from prod
 *
 * The totals are asserted exactly: this is the money, and a receipt that
 * parses 1000x small is exactly the bug being guarded (#75). Item-level
 * detail is checked as a containment, since a vision model may reasonably
 * split or merge lines.
 */
final class ReceiptCorpusTest extends TestCase
{
    private const DIR = __DIR__ . '/fixtures/receipts';

    /** @return iterable<string, array{0:string, 1:array<string,mixed>}> */
    public static function corpus(): iterable
    {
        $path = self::DIR . '/expected.json';
        if (!is_file($path)) {
            return;
        }
        $spec = json_decode((string) file_get_contents($path), true, 16, JSON_THROW_ON_ERROR);
        foreach ($spec['receipts'] ?? [] as $id => $expected) {
            yield $id => [$id, $expected];
        }
    }

    /** @param array<string,mixed> $expected */
    #[DataProvider('corpus')]
    public function testReceiptParsesToItsPrintedTotal(string $id, array $expected): void
    {
        $base = getenv('LOCAL_LLM_URL') ?: '';
        if ($base === '') {
            self::markTestSkipped('LOCAL_LLM_URL not set — no vision model to parse against');
        }
        $image = self::DIR . "/{$id}.jpg";
        if (!is_file($image)) {
            self::markTestSkipped("fixture image missing — run scripts/dev/fetch-receipt-fixtures.sh");
        }

        $parse = new ReflectionMethod(ReceiptService::class, 'parseLocal');
        $parse->setAccessible(true);
        $svc = new ReceiptService(new \PDO('sqlite::memory:'));
        $doc = $parse->invoke($svc, $image, 'image/jpeg', $base, (string) $expected['currency']);

        self::assertSame($expected['currency'], $doc['currency'], 'currency');
        self::assertSame(
            $expected['totalMinor'],
            $doc['totalMinor'],
            sprintf(
                "total for %s (%s)\nexpected %d, got %s — a mis-read separator is the usual cause",
                $id,
                $expected['note'] ?? '',
                $expected['totalMinor'],
                var_export($doc['totalMinor'], true),
            ),
        );

        // Subtotal and tip are classification, not arithmetic: a WRONG value
        // is a defect and fails here, but a value the model declines to
        // classify only fails unless the fixture records it as a known miss.
        // Getting the total right is what protects the money.
        foreach (['subtotalMinor', 'tipMinor'] as $field) {
            if (!array_key_exists($field, $expected)) {
                continue;
            }
            $got = $doc[$field] ?? null;
            if ($got === null && in_array($field, $expected['mayMiss'] ?? [], true)) {
                continue;
            }
            self::assertSame($expected[$field], $got, $field);
        }
        if (isset($expected['merchantContains'])) {
            self::assertStringContainsStringIgnoringCase(
                $expected['merchantContains'],
                (string) ($doc['merchant'] ?? ''),
                'merchant',
            );
        }
        foreach ($expected['itemsIncludeMinor'] ?? [] as $amount) {
            self::assertContains(
                $amount,
                array_column($doc['items'] ?? [], 'totalMinor'),
                "expected a line item of {$amount}",
            );
        }
    }
}
