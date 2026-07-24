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

/** Issue #24: add someone you already share a group with, guarded. */
final class AddKnownMemberTest extends TestCase
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

    /** @return array{token:string, id:string} */
    private function register(string $email, string $name): array
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => $email, 'password' => 'a-long-enough-password', 'displayName' => $name,
        ]));
        return ['token' => $r['token'], 'id' => $r['user']['id']];
    }

    public function testAddKnownMemberAndGuards(): void
    {
        $ann = $this->register('ann-known@example.com', 'Ann');
        $ben = $this->register('ben-known@example.com', 'Ben');
        $stranger = $this->register('stranger-known@example.com', 'Stranger');

        // Ann and Ben share "Trip"; Ann alone owns "Dinner club".
        $trip = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Trip', 'emoji' => '✈️', 'homeCurrency' => 'CAD',
        ], $ann['token']));
        $invite = self::json($this->request('POST', "/api/v1/groups/{$trip['id']}/invites", [], $ann['token']));
        $this->request('POST', "/api/v1/join/{$invite['token']}", [], $ben['token']);

        $dinner = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Dinner club', 'emoji' => '🍜', 'homeCurrency' => 'CAD',
        ], $ann['token']));

        // Ann adds Ben to Dinner club with one tap — they share Trip.
        $res = $this->request('POST', "/api/v1/groups/{$dinner['id']}/members", [
            'userId' => $ben['id'],
        ], $ann['token']);
        self::assertSame(201, $res->getStatusCode(), (string) $res->getBody());
        $memberIds = array_column(self::json($res)['members'], 'id');
        self::assertContains($ben['id'], $memberIds);

        // Adding again is a no-op success, not a duplicate.
        $res = $this->request('POST', "/api/v1/groups/{$dinner['id']}/members", [
            'userId' => $ben['id'],
        ], $ann['token']);
        self::assertSame(201, $res->getStatusCode());
        $memberIds = array_column(self::json($res)['members'], 'id');
        self::assertSame(1, count(array_keys($memberIds, $ben['id'], true)));

        // A stranger (no shared group) cannot be added…
        $res = $this->request('POST', "/api/v1/groups/{$dinner['id']}/members", [
            'userId' => $stranger['id'],
        ], $ann['token']);
        self::assertSame(403, $res->getStatusCode());

        // …and a non-member can't add anyone to the group.
        $res = $this->request('POST', "/api/v1/groups/{$dinner['id']}/members", [
            'userId' => $ann['id'],
        ], $stranger['token']);
        self::assertSame(403, $res->getStatusCode());
    }
}
