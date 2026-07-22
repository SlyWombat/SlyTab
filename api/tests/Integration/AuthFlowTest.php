<?php

declare(strict_types=1);

namespace SlySplit\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use SlySplit\App;
use SlySplit\Db\Db;
use SlySplit\Db\Migrator;

/**
 * End-to-end auth flow against a real MySQL (slysplit_test — rebuilt fresh
 * each run by the bootstrap-selected test database). Skips cleanly when no
 * database is reachable (e.g. a checkout without the dev environment).
 */
final class AuthFlowTest extends TestCase
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

    private function request(string $method, string $path, ?array $body = null, ?string $token = null): ResponseInterface
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
        return self::$app->handle($request);
    }

    /** @return array<string,mixed> */
    private static function json(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function testHealthNeedsNoAuth(): void
    {
        $res = $this->request('GET', '/api/v1/health');
        self::assertSame(200, $res->getStatusCode());
        self::assertSame('ok', self::json($res)['status']);
    }

    public function testFullAuthFlow(): void
    {
        // Register
        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'Dave@Example.com',
            'password' => 'correct-horse-battery',
            'displayName' => 'Dave',
            'deviceLabel' => 'phpunit',
        ]);
        self::assertSame(201, $res->getStatusCode());
        $registered = self::json($res);
        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $registered['token']);
        self::assertSame('dave@example.com', $registered['user']['email']); // lowercased
        self::assertSame('Dave', $registered['user']['displayName']);
        self::assertSame([], $registered['user']['paymentHandles']);

        // Duplicate email
        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'dave@example.com',
            'password' => 'another-long-password',
            'displayName' => 'Impostor',
        ]);
        self::assertSame(409, $res->getStatusCode());
        self::assertSame('EMAIL_TAKEN', self::json($res)['error']['code']);

        // Wrong password
        $res = $this->request('POST', '/api/v1/auth/login', [
            'email' => 'dave@example.com',
            'password' => 'wrong-password-here',
        ]);
        self::assertSame(401, $res->getStatusCode());
        self::assertSame('INVALID_CREDENTIALS', self::json($res)['error']['code']);

        // Correct login (second session)
        $res = $this->request('POST', '/api/v1/auth/login', [
            'email' => 'dave@example.com',
            'password' => 'correct-horse-battery',
            'deviceLabel' => 'phpunit-second',
        ]);
        self::assertSame(200, $res->getStatusCode());
        $login = self::json($res);

        // /me works with either token
        $res = $this->request('GET', '/api/v1/me', token: $login['token']);
        self::assertSame(200, $res->getStatusCode());
        self::assertSame('dave@example.com', self::json($res)['email']);
        self::assertArrayNotHasKey('sessionId', self::json($res));

        // /me without or with a bogus token
        self::assertSame(401, $this->request('GET', '/api/v1/me')->getStatusCode());
        self::assertSame(401, $this->request('GET', '/api/v1/me', token: str_repeat('ab', 32))->getStatusCode());

        // Two live sessions; revoke the register-time one
        $res = $this->request('GET', '/api/v1/me/sessions', token: $login['token']);
        $sessions = self::json($res)['items'];
        self::assertCount(2, $sessions);
        $labels = array_column($sessions, 'deviceLabel', 'id');
        $registerSessionId = array_search('phpunit', $labels, true);
        self::assertNotFalse($registerSessionId);

        $res = $this->request('DELETE', "/api/v1/me/sessions/{$registerSessionId}", token: $login['token']);
        self::assertSame(200, $res->getStatusCode());
        self::assertSame(401, $this->request('GET', '/api/v1/me', token: $registered['token'])->getStatusCode());

        // Logout kills the current session
        $res = $this->request('POST', '/api/v1/auth/logout', token: $login['token']);
        self::assertSame(200, $res->getStatusCode());
        self::assertSame(401, $this->request('GET', '/api/v1/me', token: $login['token'])->getStatusCode());
    }

    public function testValidationErrors(): void
    {
        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'not-an-email',
            'password' => 'long-enough-password',
            'displayName' => 'X',
        ]);
        self::assertSame(400, $res->getStatusCode());
        self::assertSame('VALIDATION', self::json($res)['error']['code']);

        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'ok@example.com',
            'password' => 'short',
            'displayName' => 'X',
        ]);
        self::assertSame(400, $res->getStatusCode());

        $res = $this->request('POST', '/api/v1/auth/register', ['email' => 'ok@example.com']);
        self::assertSame(400, $res->getStatusCode());
    }

    public function testUnknownRouteGetsEnvelope(): void
    {
        $res = $this->request('GET', '/api/v1/nope');
        self::assertSame(404, $res->getStatusCode());
        self::assertSame('NOT_FOUND', self::json($res)['error']['code']);
    }
}
