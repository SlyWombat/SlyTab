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

/**
 * Deleting a group that never held money.
 *
 * Archiving is right for a group with a history; it was wrong as the ONLY
 * exit, because a group made by accident then sits in your list for ever. The
 * interesting assertions here are the refusals — a delete that can reach a
 * group with expenses in it would destroy the record silently.
 */
final class GroupDeleteTest extends TestCase
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

    /** @return array<string,mixed> */
    private function makeGroup(string $token, string $name): array
    {
        return self::json($this->request('POST', '/api/v1/groups', [
            'name' => $name, 'emoji' => '🎿', 'homeCurrency' => 'CAD',
        ], $token));
    }

    public function testEmptyGroupIsDeletedAndDisappears(): void
    {
        $ann = $this->register('ann-del@example.com', 'Ann');
        $group = $this->makeGroup($ann['token'], 'Made by mistake');

        $res = $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $ann['token']);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        // Gone from the list, not merely hidden — archiving is what hides.
        $names = array_column(self::json($this->request('GET', '/api/v1/groups', null, $ann['token']))['items'], 'name');
        self::assertNotContains('Made by mistake', $names);

        // And unreachable. 403 rather than 404 is correct and deliberate:
        // membership is checked before existence, so "deleted" and "not
        // yours" look identical from outside. Asserting either keeps that a
        // choice rather than something this test quietly pins down.
        self::assertContains(
            $this->request('GET', "/api/v1/groups/{$group['id']}", null, $ann['token'])->getStatusCode(),
            [403, 404],
        );
    }

    public function testGroupWithAnExpenseCannotBeDeleted(): void
    {
        $ann = $this->register('ann-del2@example.com', 'Ann');
        $group = $this->makeGroup($ann['token'], 'Has money in it');
        $created = $this->request('POST', "/api/v1/groups/{$group['id']}/expenses", [
            'description' => 'Lift pass', 'amountMinor' => 4000, 'currency' => 'CAD',
            'expenseDate' => '2026-08-01', 'category' => 'travel', 'splitMethod' => 'equal',
            'payers' => [['userId' => $ann['id'], 'amountMinor' => 4000]],
            'shares' => [['userId' => $ann['id'], 'amountMinor' => 4000]],
        ], $ann['token']);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $expense = self::json($created);

        $res = $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $ann['token']);
        self::assertSame(409, $res->getStatusCode(), (string) $res->getBody());
        self::assertSame('GROUP_NOT_EMPTY', self::json($res)['error']['code']);

        // Still fully intact: refusing must not half-delete anything.
        self::assertSame(200, $this->request('GET', "/api/v1/groups/{$group['id']}", null, $ann['token'])->getStatusCode());

        // Deleting the expense does NOT unlock deletion. The row is soft
        // deleted, so the group has a history, and that is the whole reason
        // `deleted_at` exists rather than a hard DELETE.
        $this->request('DELETE', "/api/v1/expenses/{$expense['id']}", null, $ann['token']);
        $res = $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $ann['token']);
        self::assertSame(409, $res->getStatusCode(), 'a group that once held an expense keeps its history');
    }

    public function testOnlyTheCreatorCanDeleteWhileOthersAreStillIn(): void
    {
        $ann = $this->register('ann-del3@example.com', 'Ann');
        $ben = $this->register('ben-del3@example.com', 'Ben');
        $group = $this->makeGroup($ann['token'], 'Shared and empty');
        $invite = self::json($this->request('POST', "/api/v1/groups/{$group['id']}/invites", [], $ann['token']));
        $this->request('POST', "/api/v1/join/{$invite['token']}", [], $ben['token']);

        // Ben is a member, so he can read it — but deleting it would take it
        // away from Ann, who made it.
        self::assertSame(403, $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $ben['token'])->getStatusCode());

        // Ann created it, so she may.
        self::assertSame(200, $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $ann['token'])->getStatusCode());
    }

    public function testNonMemberCannotDelete(): void
    {
        $ann = $this->register('ann-del4@example.com', 'Ann');
        $stranger = $this->register('stranger-del4@example.com', 'Stranger');
        $group = $this->makeGroup($ann['token'], 'Not yours');

        self::assertSame(403, $this->request('DELETE', "/api/v1/groups/{$group['id']}", null, $stranger['token'])->getStatusCode());
        self::assertSame(200, $this->request('GET', "/api/v1/groups/{$group['id']}", null, $ann['token'])->getStatusCode());
    }
}
