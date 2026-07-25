<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Services\AuthHandoffService;
use SlyTab\Services\AuthService;
use SlyTab\Services\GoogleAuthService;
use SlyTab\Support\ApiException;

/** Google verification stub: returns whatever claims the test sets. */
final class HandoffFakeGoogle extends GoogleAuthService
{
    /** @var array<string,mixed> */
    public array $claims = [];

    protected function fetchClaims(string $idToken): array
    {
        return $this->claims;
    }
}

/** Mobile "Sign in with Google" browser handoff (issue #39). */
final class AuthHandoffTest extends TestCase
{
    private const CLIENT_ID = 'test-client.apps.googleusercontent.com';

    private static ?SlimApp $app = null;
    private static PDO $pdo;
    private static HandoffFakeGoogle $google;
    private static AuthHandoffService $handoff;

    public static function setUpBeforeClass(): void
    {
        putenv('GOOGLE_CLIENT_ID=' . self::CLIENT_ID);
        try {
            self::$pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator(self::$pdo))->fresh();
        self::$app = App::create();
        $auth = new AuthService(self::$pdo);
        self::$google = new HandoffFakeGoogle(self::$pdo, $auth);
        self::$handoff = new AuthHandoffService(self::$pdo, $auth, self::$google);
    }

    public static function tearDownAfterClass(): void
    {
        putenv('GOOGLE_CLIENT_ID'); // unset so other suites see it disabled
    }

    /** @return array<string,mixed> */
    private static function goodClaims(): array
    {
        return [
            'iss' => 'https://accounts.google.com',
            'aud' => self::CLIENT_ID,
            'sub' => '2093847561203984700',
            'email' => 'handoff@example.com',
            'email_verified' => 'true',
            'name' => 'Handoff Tester',
            'exp' => (string) (time() + 3600),
        ];
    }

    private function request(string $method, string $path, ?array $body = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        return self::$app->handle($request);
    }

    public function testFullHandoffReleasesTheSessionExactlyOnce(): void
    {
        $start = self::$handoff->start('mobile');
        $this->assertMatchesRegularExpression('/^[a-f0-9]{32}$/', $start['state']);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $start['verifier']);

        // Browser hasn't signed in yet — the app keeps polling.
        $this->assertSame(['pending' => true], self::$handoff->claim($start['state'], $start['verifier']));

        self::$google->claims = self::goodClaims();
        $this->assertSame(['ok' => true], self::$handoff->completeGoogle($start['state'], 'fake-token'));

        // A stolen state (deep link, browser URL) is worthless without the verifier.
        try {
            self::$handoff->claim($start['state'], str_repeat('00', 32));
            $this->fail('expected HANDOFF_INVALID for a wrong verifier');
        } catch (ApiException $e) {
            $this->assertSame('HANDOFF_INVALID', $e->errorCode);
        }

        $session = self::$handoff->claim($start['state'], $start['verifier']);
        $this->assertNotSame('', $session['token']);
        $this->assertSame('handoff@example.com', $session['user']['email']);

        // Single use: the second claim finds nothing.
        try {
            self::$handoff->claim($start['state'], $start['verifier']);
            $this->fail('expected HANDOFF_INVALID after the session was released');
        } catch (ApiException $e) {
            $this->assertSame('HANDOFF_INVALID', $e->errorCode);
        }
    }

    public function testBadGoogleTokenLeavesTheHandoffPending(): void
    {
        $start = self::$handoff->start('mobile');
        self::$google->claims = ['aud' => 'someone-else.apps.googleusercontent.com'] + self::goodClaims();
        try {
            self::$handoff->completeGoogle($start['state'], 'fake-token');
            $this->fail('expected GOOGLE_TOKEN_INVALID');
        } catch (ApiException $e) {
            $this->assertSame('GOOGLE_TOKEN_INVALID', $e->errorCode);
        }
        $this->assertSame(['pending' => true], self::$handoff->claim($start['state'], $start['verifier']));
    }

    public function testExpiredHandoffsAreGoneForBothSides(): void
    {
        $start = self::$handoff->start('mobile');
        self::$pdo->prepare(
            'UPDATE auth_handoffs SET created_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE state = ?',
        )->execute([$start['state']]);

        foreach (['claim', 'complete'] as $side) {
            try {
                $side === 'claim'
                    ? self::$handoff->claim($start['state'], $start['verifier'])
                    : self::$handoff->completeGoogle($start['state'], 'fake-token');
                $this->fail("expected HANDOFF_INVALID for expired $side");
            } catch (ApiException $e) {
                $this->assertSame('HANDOFF_INVALID', $e->errorCode);
            }
        }
    }

    public function testHttpRoutesAreWired(): void
    {
        $res = $this->request('POST', '/api/v1/auth/handoff/start', ['deviceLabel' => 'mobile']);
        $this->assertSame(201, $res->getStatusCode());
        $start = json_decode((string) $res->getBody(), true);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{32}$/', $start['state']);

        $res = $this->request('POST', '/api/v1/auth/handoff/claim', [
            'state' => $start['state'], 'verifier' => $start['verifier'],
        ]);
        $this->assertSame(202, $res->getStatusCode());
        $this->assertSame(['pending' => true], json_decode((string) $res->getBody(), true));
    }
}
