<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;

/** FR-10.1: report a bug from the profile page, review via internal API. */
final class BugReportTest extends TestCase
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

    private function request(string $method, string $path, ?array $body = null, ?string $token = null, array $headers = []): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        if ($token !== null) {
            $request = $request->withHeader('Authorization', "Bearer {$token}");
        }
        foreach ($headers as $k => $v) {
            $request = $request->withHeader($k, $v);
        }
        return self::$app->handle($request);
    }

    /** @return array<string,mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function testReportListAndGuards(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'bugsy@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Bugsy',
        ]));
        $token = $r['token'];

        // Anonymous reports are rejected.
        $res = $this->request('POST', '/api/v1/bugs', ['message' => 'anon']);
        self::assertSame(401, $res->getStatusCode());

        // Empty message is rejected.
        $res = $this->request('POST', '/api/v1/bugs', ['message' => '   '], $token);
        self::assertSame(400, $res->getStatusCode());

        // A text-only report lands (screenshot is optional).
        $res = $this->request('POST', '/api/v1/bugs', [
            'message' => 'The Boragó receipt came out 100x too big',
            'context' => 'web test-agent',
        ], $token);
        self::assertSame(201, $res->getStatusCode(), (string) $res->getBody());
        $reportId = self::json($res)['id'];

        // The internal review listing requires the admin token…
        $res = $this->request('GET', '/api/internal/bugs');
        self::assertSame(403, $res->getStatusCode());

        // …and with it shows the comment with the reporter attached.
        $res = $this->request('GET', '/api/internal/bugs', null, null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $items = self::json($res)['items'];
        self::assertCount(1, $items);
        self::assertSame($reportId, $items[0]['id']);
        self::assertSame('The Boragó receipt came out 100x too big', $items[0]['message']);
        self::assertSame('bugsy@example.com', $items[0]['from']['email']);
        self::assertSame('web test-agent', $items[0]['context']);
        self::assertFalse($items[0]['hasImage']);
        self::assertSame('new', $items[0]['status']);

        // No screenshot on this report → 404 from the image endpoint.
        $res = $this->request('GET', "/api/internal/bugs/{$reportId}/image", null, null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertSame(404, $res->getStatusCode());
    }
}
