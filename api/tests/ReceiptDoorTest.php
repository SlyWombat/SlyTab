<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use SlyTab\Services\ReceiptService;

/**
 * The doors in front of the model host, from SlyTab's side (#119, #124).
 *
 * Two of them now: Cloudflare Access on the tunnel that publishes the host,
 * and SlyTab's own nginx front door behind it. Both refuse with something that
 * is not JSON, so without classification a shut door surfaces as a
 * JsonException about a syntax error at offset 0 — which names neither the
 * door nor the variable that would reopen it. These cases pin the naming.
 *
 * No network: the classifier is a pure function of the status code and body.
 */
final class ReceiptDoorTest extends TestCase
{
    /** @var list<string> */
    private const KEYS = ['LOCAL_LLM_TOKEN', 'LOCAL_LLM_CF_ACCESS_ID', 'LOCAL_LLM_CF_ACCESS_SECRET'];

    protected function setUp(): void
    {
        foreach (self::KEYS as $k) {
            putenv($k);
        }
    }

    protected function tearDown(): void
    {
        foreach (self::KEYS as $k) {
            putenv($k);
        }
    }

    private static function call(string $method, mixed ...$args): mixed
    {
        $m = new ReflectionMethod(ReceiptService::class, $method);
        $m->setAccessible(true);
        return $m->invoke(null, ...$args);
    }

    /** Cloudflare answers 403 with an HTML page when the service token is wrong. */
    public function testAccessRefusalNamesTheAccessVariables(): void
    {
        $msg = (string) self::call('describeRefusal', 403, '<!DOCTYPE html><title>Access denied</title>');
        self::assertStringContainsString('Cloudflare Access', $msg);
        self::assertStringContainsString('LOCAL_LLM_CF_ACCESS_ID', $msg);
        self::assertStringContainsString('LOCAL_LLM_CF_ACCESS_SECRET', $msg);
        self::assertStringNotContainsString('LOCAL_LLM_TOKEN —', $msg);
    }

    /** Without a service token at all it redirects to its own login page instead. */
    public function testAccessLoginRedirectIsAlsoAnAccessRefusal(): void
    {
        $msg = (string) self::call('describeRefusal', 302, '');
        self::assertStringContainsString('Cloudflare Access', $msg);
    }

    /** The front door answers 401 with one word; that one is LOCAL_LLM_TOKEN's. */
    public function testFrontDoorRefusalNamesTheBearerToken(): void
    {
        $msg = (string) self::call('describeRefusal', 401, "unauthorized\n");
        self::assertSame('local model refused the token — check LOCAL_LLM_TOKEN', $msg);
        self::assertStringNotContainsString('Cloudflare', $msg);
    }

    /**
     * curl reports no status code at all for some transport failures, and the
     * door's body is the only evidence left. It was the original signal, so it
     * keeps working on its own.
     */
    public function testTheDoorsBodyAloneStillReadsAsARefusal(): void
    {
        self::assertNotNull(self::call('describeRefusal', 0, 'unauthorized'));
    }

    /** A real answer is not a refusal, whatever it says inside. */
    public function testAModelAnswerIsNotARefusal(): void
    {
        self::assertNull(self::call('describeRefusal', 200, '{"message":{"content":"{}"}}'));
        self::assertNull(self::call('describeRefusal', 500, '{"error":"model is loading"}'));
        self::assertNull(self::call('describeRefusal', 404, 'not found'));
    }

    /** A dev Ollama with no doors in front of it must be sent nothing extra. */
    public function testNoCredentialsMeansNoHeaders(): void
    {
        self::assertSame([], self::call('localHeaders'));
    }

    public function testBothDoorsContributeTheirHeader(): void
    {
        putenv('LOCAL_LLM_TOKEN=door-token-1234');
        putenv('LOCAL_LLM_CF_ACCESS_ID=abc123.access');
        putenv('LOCAL_LLM_CF_ACCESS_SECRET=cf-service-token');
        self::assertSame([
            'Authorization: Bearer door-token-1234',
            'CF-Access-Client-Id: abc123.access',
            'CF-Access-Client-Secret: cf-service-token',
        ], self::call('localHeaders'));
    }

    /**
     * Must match ScanAvailabilityService's set exactly. They probe and parse
     * through the same doors; if they disagree the app advertises scanning it
     * cannot do, or hides scanning that works.
     */
    public function testTheProbeAndTheParseSendTheSameHeaders(): void
    {
        putenv('LOCAL_LLM_TOKEN=door-token-1234');
        putenv('LOCAL_LLM_CF_ACCESS_ID=abc123.access');
        putenv('LOCAL_LLM_CF_ACCESS_SECRET=cf-service-token');
        $probe = new ReflectionMethod(\SlyTab\Services\ScanAvailabilityService::class, 'headers');
        $probe->setAccessible(true);
        self::assertSame(self::call('localHeaders'), $probe->invoke(null));
    }
}
