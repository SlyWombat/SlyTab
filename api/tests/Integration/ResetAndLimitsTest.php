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
use SlyTab\Services\Mailer;
use SlyTab\Services\PasswordResetService;

final class CapturingMailer extends Mailer
{
    /** @var list<array{to:string, subject:string, body:string}> */
    public array $sent = [];

    public function send(string $to, string $subject, string $body): void
    {
        $this->sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
    }
}

/** Profile editing, password reset, admin endpoints, and rate limiting. */
final class ResetAndLimitsTest extends TestCase
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

    public function testProfileUpdateAndHandleValidation(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'p@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Pat',
        ]));
        $token = $r['token'];

        $res = $this->request('PATCH', '/api/v1/me', [
            'displayName' => 'Patricia',
            'defaultCurrency' => 'usd',
            'paymentHandles' => ['interacEmail' => 'Pat@Example.com', 'paypalMe' => 'pat-r', 'venmo' => ''],
        ], $token);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $me = self::json($res);
        self::assertSame('Patricia', $me['displayName']);
        self::assertSame('USD', $me['defaultCurrency']);
        self::assertEquals(['interacEmail' => 'pat@example.com', 'paypalMe' => 'pat-r'], $me['paymentHandles']);

        $bad = $this->request('PATCH', '/api/v1/me', [
            'paymentHandles' => ['interacEmail' => 'not-an-email'],
        ], $token);
        self::assertSame(400, $bad->getStatusCode());
    }

    public function testPasswordResetFlow(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'reset@example.com', 'password' => 'the-original-password', 'displayName' => 'R',
        ]));
        $oldToken = $r['token'];

        // Request a reset through the service with a capturing mailer, then
        // finish the flow over HTTP with the emailed token.
        $mailer = new CapturingMailer();
        (new PasswordResetService(Db::pdo(), $mailer))->request('reset@example.com');
        self::assertCount(1, $mailer->sent);
        self::assertSame('reset@example.com', $mailer->sent[0]['to']);
        self::assertSame(1, preg_match('#/reset/([a-f0-9]{64})#', $mailer->sent[0]['body'], $m));
        $resetToken = $m[1];

        // Unknown emails get the identical outward response.
        $mailer2 = new CapturingMailer();
        (new PasswordResetService(Db::pdo(), $mailer2))->request('nobody@example.com');
        self::assertCount(0, $mailer2->sent);

        $res = $this->request('POST', '/api/v1/auth/reset', [
            'token' => $resetToken, 'password' => 'the-brand-new-password',
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        // Old sessions and the old password are dead; the new password works.
        self::assertSame(401, $this->request('GET', '/api/v1/me', null, $oldToken)->getStatusCode());
        self::assertSame(401, $this->request('POST', '/api/v1/auth/login', [
            'email' => 'reset@example.com', 'password' => 'the-original-password',
        ])->getStatusCode());
        self::assertSame(200, $this->request('POST', '/api/v1/auth/login', [
            'email' => 'reset@example.com', 'password' => 'the-brand-new-password',
        ])->getStatusCode());

        // Tokens are single-use.
        self::assertSame(410, $this->request('POST', '/api/v1/auth/reset', [
            'token' => $resetToken, 'password' => 'yet-another-password!',
        ])->getStatusCode());
    }

    public function testEmailVerificationFlow(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'verify-me@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'V',
        ]));
        self::assertNull($r['user']['emailVerifiedAt']);

        $mailer = new CapturingMailer();
        (new \SlyTab\Services\EmailVerificationService(Db::pdo(), $mailer))->request($r['user']['id']);
        self::assertCount(1, $mailer->sent);
        self::assertSame(1, preg_match('#/verify/([a-f0-9]{64})#', $mailer->sent[0]['body'], $m));

        $res = $this->request('POST', "/api/v1/auth/verify/{$m[1]}");
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        $me = self::json($this->request('GET', '/api/v1/me', null, $r['token']));
        self::assertNotNull($me['emailVerifiedAt']);

        // Tokens are single-use.
        self::assertSame(410, $this->request('POST', "/api/v1/auth/verify/{$m[1]}")->getStatusCode());
    }

    public function testEmailInviteSendsAJoinableLink(): void
    {
        $owner = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'owner@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Owner',
        ]));
        $guest = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'guest@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Guest',
        ]));
        $group = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Email Invites', 'emoji' => '', 'homeCurrency' => 'CAD',
        ], $owner['token']));

        $mailer = new CapturingMailer();
        $pdo = Db::pdo();
        $groups = new \SlyTab\Services\GroupService($pdo, new \SlyTab\Services\ActivityService($pdo), $mailer);
        $invite = $groups->createInvite($group['id'], $owner['user']['id'], 'Friend@Example.com');
        self::assertTrue($invite['emailed']);
        self::assertCount(1, $mailer->sent);
        self::assertSame('friend@example.com', $mailer->sent[0]['to']);
        self::assertStringContainsString('Owner invited you to "Email Invites"', $mailer->sent[0]['subject']);
        self::assertSame(1, preg_match('#/join/([a-f0-9]{32})#', $mailer->sent[0]['body'], $m));

        $res = $this->request('POST', "/api/v1/join/{$m[1]}", [], $guest['token']);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        self::assertCount(2, self::json($res)['members']);
    }

    public function testAdminEndpointsRequireToken(): void
    {
        self::assertSame(403, $this->request('POST', '/api/internal/migrate')->getStatusCode());
        $res = $this->request('POST', '/api/internal/migrate', null, null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        self::assertSame([], self::json($res)['applied']); // fresh() already applied all
    }

    public function testAuthRateLimiting(): void
    {
        $sawLimit = false;
        $attempts = 0;
        for ($i = 0; $i < 15; $i++) {
            $attempts++;
            $res = $this->request('POST', '/api/v1/auth/login', [
                'email' => 'p@example.com', 'password' => 'definitely-wrong-pass',
            ]);
            if ($res->getStatusCode() === 429) {
                self::assertSame('RATE_LIMITED', self::json($res)['error']['code']);
                $sawLimit = true;
                break;
            }
            self::assertSame(401, $res->getStatusCode());
        }
        self::assertTrue($sawLimit, "never rate-limited after {$attempts} attempts");
        self::assertGreaterThan(2, $attempts);
    }
}
