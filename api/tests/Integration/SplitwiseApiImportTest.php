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
use SlyTab\Services\ActivityService;
use SlyTab\Services\ExpenseService;
use SlyTab\Services\FxService;
use SlyTab\Services\GroupService;
use SlyTab\Services\SplitwiseApiImportService;

/** Splitwise API stub with canned endpoint responses. */
final class FakeSplitwise extends SplitwiseApiImportService
{
    /** @var array<string,array<string,mixed>> endpoint-prefix => response */
    public array $responses = [];

    protected function fetch(string $apiKey, string $endpoint): array
    {
        foreach ($this->responses as $prefix => $response) {
            if (str_starts_with($endpoint, $prefix)) {
                return $response;
            }
        }
        return ['expenses' => []];
    }
}

/** Direct-API Splitwise import: exact shares, payments, deleted rows. */
final class SplitwiseApiImportTest extends TestCase
{
    private static ?SlimApp $app = null;
    private static FakeSplitwise $sw;

    public static function setUpBeforeClass(): void
    {
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        self::$app = App::create();
        $activity = new ActivityService($pdo);
        $groups = new GroupService($pdo, $activity);
        self::$sw = new FakeSplitwise(
            $pdo, $groups,
            new ExpenseService($pdo, $groups, new FxService($pdo), $activity),
            $activity,
        );
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
    private function ok(ResponseInterface $res, int $expected = 200): array
    {
        self::assertSame($expected, $res->getStatusCode(), (string) $res->getBody());
        return json_decode((string) $res->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function testApiImportIsBalanceExactAndHandlesPayments(): void
    {
        $mk = function (string $name): array {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'password-123',
                'displayName' => ucfirst($name), 'deviceLabel' => 'test',
            ]), 201);
            return ['token' => $r['token'], 'id' => $r['user']['id']];
        };
        $ann = $mk('ann');
        $ben = $mk('ben');
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'From Splitwise', 'emoji' => '', 'homeCurrency' => 'CAD',
        ], $ann['token']), 201);
        $invite = $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/invites", [], $ann['token']), 201);
        $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $ben['token']));

        self::$sw->responses = [
            'get_groups' => ['groups' => [[
                'id' => 555, 'name' => 'Cottage',
                'members' => [
                    ['id' => 11, 'first_name' => 'Ann', 'last_name' => 'A'],
                    ['id' => 22, 'first_name' => 'Ben', 'last_name' => 'B'],
                ],
            ]]],
            'get_expenses' => ['expenses' => [
                [
                    'description' => 'Groceries', 'cost' => '55.00', 'currency_code' => 'CAD',
                    'date' => '2026-07-01T12:00:00Z', 'payment' => false, 'deleted_at' => null,
                    'category' => ['name' => 'Groceries'],
                    'users' => [
                        ['user_id' => 11, 'paid_share' => '55.00', 'owed_share' => '27.50'],
                        ['user_id' => 22, 'paid_share' => '0.00', 'owed_share' => '27.50'],
                    ],
                ],
                [
                    'description' => 'Old deleted row', 'cost' => '99.00', 'currency_code' => 'CAD',
                    'date' => '2026-07-02T12:00:00Z', 'payment' => false, 'deleted_at' => '2026-07-03T00:00:00Z',
                    'category' => ['name' => 'General'],
                    'users' => [['user_id' => 11, 'paid_share' => '99.00', 'owed_share' => '99.00']],
                ],
                [
                    'description' => 'Payment', 'cost' => '10.00', 'currency_code' => 'CAD',
                    'date' => '2026-07-04T12:00:00Z', 'payment' => true, 'deleted_at' => null,
                    'category' => ['name' => 'Payment'],
                    'users' => [
                        ['user_id' => 22, 'paid_share' => '10.00', 'owed_share' => '0.00'],
                        ['user_id' => 11, 'paid_share' => '0.00', 'owed_share' => '10.00'],
                    ],
                ],
            ]],
        ];

        $groups = self::$sw->listGroups('key');
        self::assertSame('Cottage', $groups[0]['name']);
        self::assertSame('Ann A', $groups[0]['members'][0]['name']);

        $result = self::$sw->import($g['id'], $ann['id'], 'key', 555, [
            '11' => $ann['id'], '22' => $ben['id'],
        ]);
        self::assertSame(['expenses' => 1, 'settlements' => 1, 'skipped' => 0], $result['imported']);
        self::assertSame([], $result['errors']);

        // Ann lent 27.50, Ben repaid 10.00 → Ben still owes 17.50.
        $bal = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/balances", null, $ann['token']));
        self::assertSame(1750, $bal['net'][$ann['id']]);
        self::assertSame(-1750, $bal['net'][$ben['id']]);

        // Category mapped from "Groceries" → food.
        $list = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/expenses", null, $ann['token']));
        self::assertSame('food', $list['items'][0]['category']);
    }
}
