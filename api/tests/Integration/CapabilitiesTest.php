<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\ScanAvailabilityService;

/**
 * FR-4.8: the capabilities endpoint clients use to decide whether to offer receipt
 * scanning (#123).
 *
 * ScanAvailabilityTest covers the decision; this covers the wiring, which is the part
 * that fails silently. A route returning the wrong SHAPE would leave every client
 * falling back to "unavailable" and scanning would look broken estate-wide while every
 * unit test still passed.
 */
final class CapabilitiesTest extends TestCase
{
    private static ?SlimApp $app = null;

    public static function setUpBeforeClass(): void
    {
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        self::$app = App::create();
    }

    protected function setUp(): void
    {
        ScanAvailabilityService::forget();
    }

    protected function tearDown(): void
    {
        ScanAvailabilityService::forget();
        putenv('RECEIPT_ENGINE');
        putenv('LOCAL_LLM_URL');
        putenv('ANTHROPIC_API_KEY');
    }

    private function get(string $path): ResponseInterface
    {
        return self::$app->handle((new ServerRequestFactory())->createServerRequest('GET', $path));
    }

    /** @return array<string,mixed> */
    private function body(ResponseInterface $res): array
    {
        $res->getBody()->rewind();
        return (array) json_decode((string) $res->getBody()->getContents(), true);
    }

    public function testItAnswersWithoutAuthentication(): void
    {
        // No Authorization header: a client must be able to ask what the server can do
        // before, or without, signing in.
        $res = $this->get('/api/v1/capabilities');
        self::assertSame(200, $res->getStatusCode());
    }

    public function testShapeIsExactlyWhatClientsParse(): void
    {
        putenv('RECEIPT_ENGINE=auto');
        putenv('LOCAL_LLM_URL=');
        putenv('ANTHROPIC_API_KEY=');

        $json = $this->body($this->get('/api/v1/capabilities'));
        self::assertArrayHasKey('receiptScanning', $json);
        self::assertIsArray($json['receiptScanning']);
        self::assertArrayHasKey('available', $json['receiptScanning']);
        self::assertArrayHasKey('reason', $json['receiptScanning']);
        self::assertIsBool($json['receiptScanning']['available']);
    }

    /** Nothing configured is the honest "off" case, and it must say why. */
    public function testUnconfiguredReportsUnavailableWithAReason(): void
    {
        putenv('RECEIPT_ENGINE=auto');
        putenv('LOCAL_LLM_URL=');
        putenv('ANTHROPIC_API_KEY=');

        $scan = $this->body($this->get('/api/v1/capabilities'))['receiptScanning'];
        self::assertFalse($scan['available']);
        self::assertIsString($scan['reason']);
        self::assertNotSame('', $scan['reason']);
    }

    /**
     * The reason reaches end users, so it must not name hosts, ports or engines —
     * the privacy claim in #108 rests on not advertising how parsing is done.
     */
    public function testTheReasonDoesNotLeakInfrastructure(): void
    {
        putenv('RECEIPT_ENGINE=auto');
        putenv('LOCAL_LLM_URL=http://llm.invalid:11434');
        putenv('ANTHROPIC_API_KEY=');

        $reason = (string) ($this->body($this->get('/api/v1/capabilities'))['receiptScanning']['reason'] ?? '');
        foreach (['11434', 'ollama', 'http://', 'llm.invalid', 'claude', 'anthropic'] as $leak) {
            self::assertStringNotContainsStringIgnoringCase($leak, $reason);
        }
    }
}
