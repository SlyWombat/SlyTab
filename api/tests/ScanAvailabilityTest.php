<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use SlyTab\Services\ScanAvailabilityService;

/**
 * Availability is a claim the UI acts on, so the failure that matters is the
 * *inverted* one: advertising scanning while the model host is dark leaves users
 * photographing receipts into a 503, which is the exact experience #123 exists to
 * remove. These cases pin both directions.
 *
 * No network: the probe is injected. The real curl path is exercised by
 * ReceiptCorpusTest against a live host.
 */
final class ScanAvailabilityTest extends TestCase
{
    /** Ollama's real /api/tags shape, trimmed to what we read. */
    private const TAGS = '{"models":[{"name":"qwen2.5vl:7b","size":6000000000},{"name":"qwen3:30b-a3b"}]}';

    protected function setUp(): void
    {
        ScanAvailabilityService::forget();
        putenv('RECEIPT_ENGINE=auto');
        putenv('LOCAL_LLM_URL=http://llm.invalid:11434');
        putenv('LOCAL_LLM_MODEL=qwen2.5vl:7b');
        putenv('ANTHROPIC_API_KEY=');
    }

    protected function tearDown(): void
    {
        ScanAvailabilityService::forget();
        foreach (['RECEIPT_ENGINE', 'LOCAL_LLM_URL', 'LOCAL_LLM_MODEL', 'ANTHROPIC_API_KEY', 'LOCAL_LLM_TOKEN'] as $k) {
            putenv($k);
        }
    }

    /** @param array{ok: bool, body: string} $reply */
    private static function svc(array $reply, ?array &$calls = null): ScanAvailabilityService
    {
        $calls ??= [];
        return new ScanAvailabilityService(function (string $url) use ($reply, &$calls): array {
            $calls[] = $url;
            return $reply;
        });
    }

    public function testAvailableWhenHostAnswersAndAdvertisesTheModel(): void
    {
        $status = self::svc(['ok' => true, 'body' => self::TAGS])->status();
        self::assertTrue($status['available']);
        self::assertNull($status['reason']);
    }

    public function testUnavailableWhenTheHostDoesNotAnswer(): void
    {
        $status = self::svc(['ok' => false, 'body' => ''])->status();
        self::assertFalse($status['available']);
        self::assertSame('Receipt scanning is offline right now', $status['reason']);
    }

    /**
     * The nastiest case: the door opens but our model is not behind it. Reporting
     * "available" here would fail at parse time, after the user took the photo.
     */
    public function testUnavailableWhenTheHostLacksTheConfiguredModel(): void
    {
        putenv('LOCAL_LLM_MODEL=qwen3-vl:8b-instruct');
        $status = self::svc(['ok' => true, 'body' => self::TAGS])->status();
        self::assertFalse($status['available']);
    }

    /** Ollama treats a bare tag as :latest; so must we, or a valid host reads as down. */
    public function testBareTagMatchesLatest(): void
    {
        putenv('LOCAL_LLM_MODEL=llava');
        $body = '{"models":[{"name":"llava:latest"}]}';
        self::assertTrue(self::svc(['ok' => true, 'body' => $body])->status()['available']);
    }

    public function testGarbageBodyIsNotAvailable(): void
    {
        self::assertFalse(self::svc(['ok' => true, 'body' => 'not json'])->status()['available']);
    }

    public function testNotConfiguredAtAll(): void
    {
        putenv('LOCAL_LLM_URL=');
        putenv('ANTHROPIC_API_KEY=');
        $status = self::svc(['ok' => true, 'body' => self::TAGS])->status();
        self::assertFalse($status['available']);
        self::assertSame('Receipt scanning is not configured on this server', $status['reason']);
    }

    /** Engine order must match ReceiptService::parse(), or we advertise one and run the other. */
    public function testCloudEngineIsAvailableOnKeyAlone(): void
    {
        putenv('LOCAL_LLM_URL=');
        putenv('ANTHROPIC_API_KEY=sk-test');
        $calls = [];
        $status = self::svc(['ok' => false, 'body' => ''], $calls)->status();
        self::assertTrue($status['available']);
        self::assertSame([], $calls, 'the cloud path must not probe the local host');
    }

    /** Explicit RECEIPT_ENGINE=local ignores a Claude key, exactly as parse() does. */
    public function testExplicitLocalEngineDoesNotFallBackToCloud(): void
    {
        putenv('RECEIPT_ENGINE=local');
        putenv('ANTHROPIC_API_KEY=sk-test');
        self::assertFalse(self::svc(['ok' => false, 'body' => ''])->status()['available']);
    }

    /**
     * The endpoint is public, so a miss must not become one upstream request per hit.
     */
    public function testTheAnswerIsMemoised(): void
    {
        $calls = [];
        $svc = self::svc(['ok' => true, 'body' => self::TAGS], $calls);
        $svc->status();
        $svc->status();
        $svc->status();
        self::assertCount(1, $calls, 'repeated calls must be served from cache');
    }

    public function testForgetClearsTheCache(): void
    {
        $calls = [];
        $svc = self::svc(['ok' => true, 'body' => self::TAGS], $calls);
        $svc->status();
        ScanAvailabilityService::forget();
        $svc->status();
        self::assertCount(2, $calls);
    }

    /**
     * The front door (#119) answers 401 to anything without SlyTab's token,
     * /api/tags included. A probe that forgot the token would report the
     * scanner offline for exactly as long as it was working.
     */
    public function testTheProbeCarriesTheFrontDoorToken(): void
    {
        putenv('LOCAL_LLM_TOKEN=door-token-1234');
        $seen = null;
        $svc = new ScanAvailabilityService(function (string $url, array $headers) use (&$seen): array {
            $seen = $headers;
            return ['ok' => true, 'body' => self::TAGS];
        });
        self::assertTrue($svc->status()['available']);
        self::assertSame(['Authorization: Bearer door-token-1234'], $seen);
    }

    /** A dev Ollama with no door in front of it gets no header at all. */
    public function testNoTokenMeansNoAuthorizationHeader(): void
    {
        putenv('LOCAL_LLM_TOKEN=');
        $seen = null;
        $svc = new ScanAvailabilityService(function (string $url, array $headers) use (&$seen): array {
            $seen = $headers;
            return ['ok' => true, 'body' => self::TAGS];
        });
        $svc->status();
        self::assertSame([], $seen);
    }
}
