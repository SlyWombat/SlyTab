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
use SlyTab\Services\AppleAuthService;
use SlyTab\Services\AuthService;
use SlyTab\Support\ApiException;

/** Apple JWKS stub: serves keys the test generated, so the real JWKS→PEM→openssl_verify path runs. */
final class FakeApple extends AppleAuthService
{
    /** @var array<string,mixed> */
    public array $jwks = [];

    protected function fetchJwks(): array
    {
        return $this->jwks;
    }
}

/** "Sign in with Apple" — local RS256 verification and account mapping. */
final class AppleAuthTest extends TestCase
{
    private const CLIENT_ID = 'ca.electricrv.slytab.web';
    private const KID = 'test-key-1';

    private static ?SlimApp $app = null;
    private static FakeApple $apple;
    private static \OpenSSLAsymmetricKey $key;

    public static function setUpBeforeClass(): void
    {
        putenv('APPLE_CLIENT_ID=' . self::CLIENT_ID);
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        self::$app = App::create();
        self::$apple = new FakeApple($pdo, new AuthService($pdo));

        $key = openssl_pkey_new([
            'private_key_bits' => 2048,
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
        ]);
        assert($key instanceof \OpenSSLAsymmetricKey);
        self::$key = $key;
        $details = openssl_pkey_get_details($key);
        self::$apple->jwks = ['keys' => [[
            'kty' => 'RSA', 'use' => 'sig', 'alg' => 'RS256', 'kid' => self::KID,
            'n' => self::b64u($details['rsa']['n']),
            'e' => self::b64u($details['rsa']['e']),
        ]]];
    }

    public static function tearDownAfterClass(): void
    {
        putenv('APPLE_CLIENT_ID'); // unset so other suites see it disabled
    }

    private static function b64u(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    /**
     * Sign a real RS256 identity token with the test keypair.
     * @param array<string,mixed> $claimOverrides
     * @param array<string,mixed> $headerOverrides
     */
    private static function token(array $claimOverrides = [], array $headerOverrides = []): string
    {
        $claims = array_merge([
            'iss' => 'https://appleid.apple.com',
            'aud' => self::CLIENT_ID,
            'sub' => '001234.9f6dca8b41a14bd0a7887e6f0e9bafd1.1234',
            'email' => 'atest@example.com',
            'email_verified' => true,
            'iat' => time(),
            'exp' => time() + 3600,
        ], $claimOverrides);
        $header = array_merge(['alg' => 'RS256', 'kid' => self::KID], $headerOverrides);
        $input = self::b64u(json_encode($header, JSON_THROW_ON_ERROR))
            . '.' . self::b64u(json_encode($claims, JSON_THROW_ON_ERROR));
        openssl_sign($input, $sig, self::$key, OPENSSL_ALGO_SHA256);
        return $input . '.' . self::b64u($sig);
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
        $res = $this->request('GET', '/api/v1/auth/apple/config');
        $this->assertSame(200, $res->getStatusCode());
        $body = json_decode((string) $res->getBody(), true);
        $this->assertTrue($body['enabled']);
        $this->assertSame(self::CLIENT_ID, $body['clientId']);
    }

    public function testFirstSignInCreatesAVerifiedUserAndSecondReusesIt(): void
    {
        $first = self::$apple->signIn(self::token(), 'test', 'Apple Tester');

        $this->assertNotSame('', $first['token']);
        $this->assertSame('atest@example.com', $first['user']['email']);
        $this->assertSame('Apple Tester', $first['user']['displayName'], 'first-run name from the browser is honored');
        $this->assertNotNull($first['user']['emailVerifiedAt'], 'Apple emails count as verified');

        // Apple only hands the name over once; later sign-ins omit it.
        $second = self::$apple->signIn(self::token(), 'test');
        $this->assertSame($first['user']['id'], $second['user']['id']);
        $this->assertSame('Apple Tester', $second['user']['displayName']);
        $this->assertNotSame($first['token'], $second['token']);
    }

    public function testMissingDisplayNameFallsBackToEmailLocalPart(): void
    {
        $result = self::$apple->signIn(self::token([
            'sub' => '001234.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.5678',
            'email' => 'localpart@example.com',
        ]));
        $this->assertSame('localpart', $result['user']['displayName']);
    }

    public function testAppleLinksToAnExistingPasswordAccountByEmail(): void
    {
        $res = $this->request('POST', '/api/v1/auth/register', [
            'email' => 'applink@example.com', 'password' => 'password-123',
            'displayName' => 'App Link', 'deviceLabel' => 'test',
        ]);
        $this->assertSame(201, $res->getStatusCode());
        $registered = json_decode((string) $res->getBody(), true);
        $this->assertNull($registered['user']['emailVerifiedAt']);

        $viaApple = self::$apple->signIn(self::token([
            'sub' => '001234.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.9012',
            'email' => 'applink@example.com',
        ]));

        $this->assertSame($registered['user']['id'], $viaApple['user']['id']);
        $this->assertNotNull($viaApple['user']['emailVerifiedAt'], 'Apple ownership proof verifies the email');
    }

    public function testBadTokensAreRejected(): void
    {
        $bad = [
            'wrong aud' => self::token(['aud' => 'someone.else.web']),
            'wrong iss' => self::token(['iss' => 'https://evil.example.com']),
            'expired' => self::token(['exp' => time() - 60]),
            'unverified email' => self::token(['email_verified' => false]),
            'no email_verified claim' => self::token(['email_verified' => null]),
        ];

        // Tampered signature: flip a byte and re-encode.
        $parts = explode('.', self::token());
        $sig = base64_decode(strtr($parts[2], '-_', '+/'));
        $sig[0] = chr(ord($sig[0]) ^ 0x01);
        $bad['tampered signature'] = $parts[0] . '.' . $parts[1] . '.' . self::b64u($sig);

        // alg "none": unsigned tokens must never verify.
        $bad['alg none'] = self::b64u(json_encode(['alg' => 'none', 'kid' => self::KID]))
            . '.' . explode('.', self::token())[1] . '.';

        foreach ($bad as $label => $token) {
            try {
                self::$apple->signIn($token);
                $this->fail("expected APPLE_TOKEN_INVALID for {$label}");
            } catch (ApiException $e) {
                $this->assertSame('APPLE_TOKEN_INVALID', $e->errorCode, $label);
            }
        }
    }
}
