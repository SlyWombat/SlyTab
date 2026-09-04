<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use SlyTab\Services\ReceiptService;
use SlyTab\Support\ApiException;

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

    private static function refusalMessage(int $code, string $body = ''): string
    {
        $e = self::call('refusal', $code, $body);
        self::assertInstanceOf(\Throwable::class, $e, "expected a refusal for HTTP {$code}");
        return $e->getMessage();
    }

    /** Cloudflare answers 403 with an HTML page when the service token is wrong. */
    public function testAccessRefusalNamesTheAccessVariables(): void
    {
        $msg = self::refusalMessage(403, '<!DOCTYPE html><title>Access denied</title>');
        self::assertStringContainsString('Cloudflare Access', $msg);
        self::assertStringContainsString('LOCAL_LLM_CF_ACCESS_ID', $msg);
        self::assertStringContainsString('LOCAL_LLM_CF_ACCESS_SECRET', $msg);
        self::assertStringNotContainsString('LOCAL_LLM_TOKEN —', $msg);
    }

    /** Without a service token at all it redirects to its own login page instead. */
    public function testAccessLoginRedirectIsAlsoAnAccessRefusal(): void
    {
        self::assertStringContainsString('Cloudflare Access', self::refusalMessage(302));
    }

    /** The front door answers 401 with one word; that one is LOCAL_LLM_TOKEN's. */
    public function testFrontDoorRefusalNamesTheBearerToken(): void
    {
        $msg = self::refusalMessage(401, "unauthorized\n");
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
        self::assertNotNull(self::call('refusal', 0, 'unauthorized'));
    }

    /**
     * The door's rate limiter answers 503 (`limit_req`, one shared bucket for
     * everybody). Busy is not broken, and the user-facing difference is real:
     * "try Rescan in a moment" is true, "enter the details manually" is not.
     * Before this it fell through to json_decode on nginx's HTML error page and
     * surfaced as a syntax error at offset 0.
     */
    public function testTheDoorsRateLimitReadsAsBusyNotBroken(): void
    {
        foreach ([429, 503] as $code) {
            $e = self::call('refusal', $code, '<html><head><title>503 Service Temporarily Unavailable</title>');
            self::assertInstanceOf(ApiException::class, $e, "HTTP {$code}");
            self::assertSame('SCAN_BUSY', $e->errorCode);
            self::assertSame(429, $e->status);
            self::assertStringContainsString('busy', $e->getMessage());
            // It must NOT read as offline: that sends the user to Rescan later
            // rather than in a moment, and it is not what happened.
            self::assertStringNotContainsString('unreachable', $e->getMessage());
        }
    }

    /**
     * No backend serving is the door's 502. That IS offline, and both callers
     * key the user-facing "try Rescan later" off the word `unreachable`.
     */
    public function testNoBackendServingReadsAsUnreachable(): void
    {
        foreach ([502, 504] as $code) {
            $msg = self::refusalMessage($code, '<html><title>502 Bad Gateway</title>');
            self::assertStringContainsString('unreachable', $msg, "HTTP {$code}");
        }
    }

    /** A real answer is not a refusal, whatever it says inside. */
    public function testAModelAnswerIsNotARefusal(): void
    {
        self::assertNull(self::call('refusal', 200, '{"message":{"content":"{}"}}'));
        // Ollama's own 500 carries {"error": ...}, which parseLocal reports with
        // the model's words in it — better than anything this could invent.
        self::assertNull(self::call('refusal', 500, '{"error":"model is loading"}'));
        self::assertNull(self::call('refusal', 404, 'not found'));
    }

    /**
     * A merchant the model could not read must come back absent, not blank.
     *
     * A real scan on 2026-09-03 returned `merchant: ""`, which is a *present*
     * value: it slipped past both clients' `?? 'Receipt'` fallback and past
     * `if (r.merchant) setDescription(...)`, leaving Description empty behind
     * its placeholder and Save refusing to go with nothing said.
     */
    public function testAnUnreadableMerchantIsNullNotEmptyString(): void
    {
        foreach (['', '   ', "\n\t ", null, 42, [], false] as $raw) {
            self::assertNull(
                self::call('normalizeMerchant', $raw),
                'expected null for ' . var_export($raw, true),
            );
        }
    }

    public function testARealMerchantSurvivesTrimmedAndCapped(): void
    {
        self::assertSame('Costco Wholesale', self::call('normalizeMerchant', '  Costco Wholesale  '));
        self::assertSame(120, mb_strlen((string) self::call('normalizeMerchant', str_repeat('a', 300))));
        // A name that is only punctuation is still a name; only blank is absent.
        self::assertSame('-', self::call('normalizeMerchant', '-'));
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
