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
use SlyTab\Services\AuthService;
use SlyTab\Services\GoogleAuthService;
use SlyTab\Support\ApiException;

/** Google verification stub: returns whatever claims the test sets. */
final class FakeGoogle extends GoogleAuthService
{
    /** @var array<string,mixed> */
    public array $claims = [];

    protected function fetchClaims(string $idToken): array
    {
        return $this->claims;
    }
}

/** "Sign in with Google" — token validation and account mapping. */
final class GoogleAuthTest extends TestCase
{
    private const CLIENT_ID = 'test-client.apps.googleusercontent.com';

    private static ?SlimApp $app = null;
    private static FakeGoogle $google;

    public static function setUpBeforeClass(): void
    {
        putenv('GOOGLE_CLIENT_ID=' . self::CLIENT_ID);
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        self::$app = App::create();
        self::$google = new FakeGoogle($pdo, new AuthService($pdo));
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
            'sub' => '1093847561203984756',
            'email' => 'gtest@example.com',
            'email_verified' => 'true',
            'name' => 'Google Tester',
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

    public function testConfigEndpointExposesClientId(): void
    {
        $res = $this->request('GET', '/api/v1/auth/google/config');
        $this->assertSame(200, $res->getStatusCode());
        $body = json_decode((string) $res->getBody(), true);
        $this->assertTrue($body['enabled']);
        $this->assertSame(self::CLIENT_ID, $body['clientId']);
    }

    public function testFirstSignInCreatesAVerifiedUserAndSecondReusesIt(): void
    {
        self::$google->claims = self::goodClaims();
        $first = self::$google->signIn('fake-token', 'test');

        $this->assertNotSame('', $first['token']);
        $this->assertSame('gtest@example.com', $first['user']['email']);
        $this->assertSame('Google Tester', $first['user']['displayName']);
        $this->assertNotNull($first['user']['emailVerifiedAt'], 'Google emails count as verified');

        $second = self::$google->signIn('fake-token', 'test');
        $this->assertSame($first['user']['id'], $second['user']['id']);
        $this->assertNotSame($first['token'], $second['token']);
    }

    public function testGoogleLinksToAnExistingPasswordAccountByEmail(): void
    {
        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'linkme@example.com', 'password' => 'password-123',
            'displayName' => 'Link Me', 'deviceLabel' => 'test',
        ]);
        $this->assertSame(201, $res->getStatusCode());
        $registered = json_decode((string) $res->getBody(), true);
        $this->assertNull($registered['user']['emailVerifiedAt']);

        self::$google->claims = ['sub' => '777000111222333444555'] + self::goodClaims();
        self::$google->claims['email'] = 'linkme@example.com';
        $viaGoogle = self::$google->signIn('fake-token');

        $this->assertSame($registered['user']['id'], $viaGoogle['user']['id']);
        $this->assertNotNull($viaGoogle['user']['emailVerifiedAt'], 'Google ownership proof verifies the email');
    }

    public function testTokensWithWrongAudienceOrUnverifiedEmailAreRejected(): void
    {
        foreach ([
            ['aud' => 'someone-else.apps.googleusercontent.com'],
            ['email_verified' => 'false'],
            ['exp' => (string) (time() - 60)],
            ['iss' => 'https://evil.example.com'],
        ] as $bad) {
            self::$google->claims = array_merge(self::goodClaims(), $bad);
            try {
                self::$google->signIn('fake-token');
                $this->fail('expected GOOGLE_TOKEN_INVALID for ' . json_encode($bad));
            } catch (ApiException $e) {
                $this->assertSame('GOOGLE_TOKEN_INVALID', $e->errorCode);
            }
        }
    }
}
