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

    /** What the host said it had loaded when we started — the diagnosis for a timeout. */
    private static ?string $resident = null;
    private static bool $preflightDone = false;

    /**
     * Ask the host what it is serving BEFORE parsing anything, so a failure has
     * a cause attached rather than ninety seconds of silence (#123).
     *
     * On 2026-09-01 this suite "errored" twice with `local model unreachable:
     * Operation timed out after 90002 ms` while /api/tags answered in 2 ms —
     * another consumer had a 37 GB model on the GPU and ours was being evicted.
     * Availability and capacity are different questions; this preflight makes
     * the suite answer both: an unadvertised model FAILS here, immediately, and
     * a slow parse fails below with what was resident at the time.
     */
    private static function preflight(string $base): void
    {
        if (self::$preflightDone) {
            return;
        }
        self::$preflightDone = true;
        $want = getenv('LOCAL_LLM_MODEL') ?: 'qwen2.5vl:7b';
        $tags = self::get($base . '/api/tags', 5);
        if ($tags === null) {
            self::fail("model host {$base} did not answer /api/tags — receipt scanning is DOWN, not slow");
        }
        $names = array_map(
            static fn(array $m): string => (string) ($m['name'] ?? ''),
            (array) (json_decode($tags, true)['models'] ?? []),
        );
        $wanted = str_contains($want, ':') ? $want : $want . ':latest';
        if (!in_array($want, $names, true) && !in_array($wanted, $names, true)) {
            self::fail("host {$base} does not advertise {$want}; it has: " . implode(', ', $names));
        }
        $ps = self::get($base . '/api/ps', 5);
        $loaded = array_map(
            static fn(array $m): string => sprintf('%s (%.1f GB%s)', $m['name'] ?? '?', ((int) ($m['size'] ?? 0)) / 1e9,
                isset($m['size_vram']) && (int) $m['size_vram'] < (int) ($m['size'] ?? 0) ? ', partly on CPU' : ''),
            (array) (json_decode((string) $ps, true)['models'] ?? []),
        );
        self::$resident = $loaded === [] ? 'nothing' : implode(', ', $loaded);
    }

    private static function get(string $url, int $timeout): ?string
    {
        // The same doors parseLocal goes through, or the preflight reports a
        // host down that is merely shut to us: the front door's bearer token
        // (#119) and, when the host is reached over the tunnel, the Cloudflare
        // Access service token (#124). Both optional — a LAN address needs
        // neither.
        $headers = [];
        $token = getenv('LOCAL_LLM_TOKEN') ?: '';
        if ($token !== '') {
            $headers[] = "Authorization: Bearer {$token}";
        }
        $cfId = getenv('LOCAL_LLM_CF_ACCESS_ID') ?: '';
        $cfSecret = getenv('LOCAL_LLM_CF_ACCESS_SECRET') ?: '';
        if ($cfId !== '' && $cfSecret !== '') {
            $headers[] = "CF-Access-Client-Id: {$cfId}";
            $headers[] = "CF-Access-Client-Secret: {$cfSecret}";
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => $timeout,
            CURLOPT_TIMEOUT => $timeout,
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $code === 200 && is_string($body) ? $body : null;
    }

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

        self::preflight($base);

        $parse = new ReflectionMethod(ReceiptService::class, 'parseLocal');
        $parse->setAccessible(true);
        $svc = new ReceiptService(new \PDO('sqlite::memory:'));
        $t0 = microtime(true);
        try {
            $doc = $parse->invoke($svc, $image, 'image/jpeg', $base, (string) $expected['currency']);
        } catch (\RuntimeException $e) {
            // A failure with its cause, not an error with a stack trace. "The
            // door answered but the model did not" is capacity: look at what
            // else was resident.
            self::fail(sprintf(
                "%s did not parse after %.0f s: %s\nResident on the host at start: %s\n"
                . 'The host advertised the model, so this is capacity or engine health, not availability.',
                $id,
                microtime(true) - $t0,
                $e->getMessage(),
                self::$resident ?? 'unknown',
            ));
        }

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
