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
use SlyTab\Support\Ulid;

/**
 * Settling up from the creditor's seat, and locking a trip while it happens
 * (#120).
 *
 * The end that already worked — "I sent it", pending until the payee
 * confirms — is covered by GroupMoneyFlowTest. What is exercised here is
 * everything that did not exist before: a payee recording money that was
 * handed to them, the partial payments that makes possible, the correction
 * path that a self-confirmed record needs, the lock that freezes expenses
 * without freezing payments, and reminding someone by hand.
 */
final class SettleUpTest extends TestCase
{
    private static ?SlimApp $app = null;
    /** @var array<string, array{token:string, id:string}> */
    private static array $users = [];
    private static string $groupId = '';

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

    /** @return array<string,mixed> */
    private function ok(ResponseInterface $res, int $expected): array
    {
        self::assertSame($expected, $res->getStatusCode(), (string) $res->getBody());
        return self::json($res);
    }

    private static function id(string $name): string
    {
        return self::$users[$name]['id'];
    }

    private static function token(string $name): string
    {
        return self::$users[$name]['token'];
    }

    private function balances(string $who): array
    {
        return $this->ok($this->request(
            'GET',
            '/api/v1/groups/' . self::$groupId . '/balances',
            null,
            self::token($who),
        ), 200);
    }

    public function testSettleUpFromEitherEnd(): void
    {
        // ---- a trip where Vijay owes Dave, the shape from the report ----
        foreach (['dave', 'vijay', 'jon'] as $name) {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}-settle@example.com",
                'password' => 'a-long-enough-password',
                'displayName' => ucfirst($name),
            ]), 201);
            self::$users[$name] = ['token' => $r['token'], 'id' => $r['user']['id']];
        }

        $group = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Ski Chile', 'emoji' => '🎿', 'homeCurrency' => 'CAD',
        ], self::token('dave')), 201);
        self::$groupId = $group['id'];
        self::assertNull($group['lockedAt'], 'a new group is not locked');

        $invite = $this->ok($this->request(
            'POST',
            '/api/v1/groups/' . self::$groupId . '/invites',
            [],
            self::token('dave'),
        ), 201);
        foreach (['vijay', 'jon'] as $name) {
            $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], self::token($name)), 200);
        }

        // Dave fronts C$300, split three ways: Vijay and Jon owe him 100 each.
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Lift tickets', 'amountMinor' => 30000, 'currency' => 'CAD',
            'expenseDate' => '2026-08-01', 'category' => 'travel', 'splitMethod' => 'equal',
            'payers' => [['userId' => self::id('dave'), 'amountMinor' => 30000]],
            'shares' => [
                ['userId' => self::id('dave'), 'amountMinor' => 10000],
                ['userId' => self::id('vijay'), 'amountMinor' => 10000],
                ['userId' => self::id('jon'), 'amountMinor' => 10000],
            ],
        ], self::token('dave')), 201);

        $before = $this->balances('dave');
        self::assertSame(20000, $before['net'][self::id('dave')]);
        self::assertSame(-10000, $before['net'][self::id('vijay')]);

        // ---- "here is $20 toward my tab": Dave records money he was handed ----
        $partial = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('vijay'), 'amountMinor' => 2000, 'method' => 'cash',
        ], self::token('dave')), 201);
        self::assertSame('confirmed', $partial['status'], 'the payee has nobody to confirm to');
        self::assertNotNull($partial['confirmedAt']);
        self::assertSame(self::id('dave'), $partial['recordedBy']);
        self::assertSame(self::id('vijay'), $partial['fromUserId']);
        self::assertSame(self::id('dave'), $partial['toUserId']);

        // Confirmed on the spot means the balance moves on the spot, and a
        // part payment leaves the rest owing rather than closing the debt.
        $after = $this->balances('dave');
        self::assertSame(18000, $after['net'][self::id('dave')]);
        self::assertSame(-8000, $after['net'][self::id('vijay')]);

        // ---- a self-confirmed record stays correctable, from both ends ----
        $typo = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('jon'), 'amountMinor' => 9900, 'method' => 'cash',
        ], self::token('dave')), 201);
        // The payer, who never agreed to it, can throw it out…
        $this->ok($this->request('DELETE', "/api/v1/settlements/{$typo['id']}", null, self::token('jon')), 200);
        self::assertSame(20000 - 2000, $this->balances('dave')['net'][self::id('dave')]);

        $typo2 = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('jon'), 'amountMinor' => 9900, 'method' => 'cash',
        ], self::token('dave')), 201);
        // …and so can the person who mistyped it.
        $this->ok($this->request('DELETE', "/api/v1/settlements/{$typo2['id']}", null, self::token('dave')), 200);

        // A settlement the two of them agreed on is still final: Vijay says
        // he sent it, Dave confirms it, and after that neither can rewrite it.
        $agreed = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'toUserId' => self::id('dave'), 'amountMinor' => 1000, 'method' => 'interac',
        ], self::token('vijay')), 201);
        self::assertSame('pending', $agreed['status']);
        self::assertSame(self::id('vijay'), $agreed['recordedBy']);
        $this->ok($this->request('POST', "/api/v1/settlements/{$agreed['id']}/confirm", [], self::token('dave')), 200);
        $refused = $this->request('DELETE', "/api/v1/settlements/{$agreed['id']}", null, self::token('vijay'));
        self::assertSame(409, $refused->getStatusCode());
        self::assertSame('CONFLICT', self::json($refused)['error']['code']);

        // ---- you can only record a payment you are one end of ----
        $notMine = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('vijay'), 'toUserId' => self::id('jon'),
            'amountMinor' => 500, 'method' => 'cash',
        ], self::token('dave'));
        self::assertSame(400, $notMine->getStatusCode());
        self::assertSame('VALIDATION', self::json($notMine)['error']['code']);

        $selfPay = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('dave'), 'amountMinor' => 500, 'method' => 'cash',
        ], self::token('dave'));
        self::assertSame(400, $selfPay->getStatusCode());

        // ---- reminding someone, by hand ----
        // Vijay owes Dave; Dave asks for it. Once.
        $first = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/remind', [
            'userId' => self::id('vijay'),
        ], self::token('dave')), 200);
        self::assertTrue($first['sent']);
        $again = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/remind', [
            'userId' => self::id('vijay'),
        ], self::token('dave')), 200);
        self::assertFalse($again['sent'], 'a second tap must not send a second email');
        self::assertSame('too_soon', $again['reason']);

        // Nobody can be reminded of a debt that runs the other way.
        $wrongWay = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/remind', [
            'userId' => self::id('dave'),
        ], self::token('vijay')), 200);
        self::assertFalse($wrongWay['sent']);
        self::assertSame('no_debt', $wrongWay['reason']);

        // A placeholder member has no inbox: the group DTO says so, and the
        // endpoint refuses rather than reporting a send that never happened.
        $ghostId = Ulid::generate();
        $pdo = Db::pdo();
        $pdo->prepare(
            'INSERT INTO users (id, email, display_name, password_hash, placeholder_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
        )->execute([$ghostId, 'ghost-settle@example.com', 'Ghost', '']);
        $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
            ->execute([self::$groupId, $ghostId]);
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Ghost dinner', 'amountMinor' => 4000, 'currency' => 'CAD',
            'expenseDate' => '2026-08-02', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => self::id('dave'), 'amountMinor' => 4000]],
            'shares' => [
                ['userId' => self::id('dave'), 'amountMinor' => 2000],
                ['userId' => $ghostId, 'amountMinor' => 2000],
            ],
        ], self::token('dave')), 201);

        $withGhost = $this->ok($this->request(
            'GET',
            '/api/v1/groups/' . self::$groupId,
            null,
            self::token('dave'),
        ), 200);
        $flags = [];
        foreach ($withGhost['members'] as $m) {
            $flags[$m['id']] = $m['isPlaceholder'];
        }
        self::assertTrue($flags[$ghostId]);
        self::assertFalse($flags[self::id('vijay')]);

        $ghostNudge = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/remind', [
            'userId' => $ghostId,
        ], self::token('dave')), 200);
        self::assertFalse($ghostNudge['sent']);
        self::assertSame('unreachable', $ghostNudge['reason']);

        // ---- locking the trip ----
        $locked = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/lock', [], self::token('jon')), 200);
        self::assertNotNull($locked['lockedAt'], 'any member can lock, exactly like archiving');

        $frozen = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'One more round', 'amountMinor' => 1000, 'currency' => 'CAD',
            'expenseDate' => '2026-08-03', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => self::id('dave'), 'amountMinor' => 1000]],
            'shares' => [['userId' => self::id('dave'), 'amountMinor' => 1000]],
        ], self::token('dave'));
        self::assertSame(409, $frozen->getStatusCode());
        self::assertSame('GROUP_LOCKED', self::json($frozen)['error']['code']);

        // The whole point: money still moves while the spending is frozen.
        $duringLock = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('vijay'), 'amountMinor' => 1000, 'method' => 'cash',
        ], self::token('dave')), 201);
        self::assertSame('confirmed', $duringLock['status']);
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'toUserId' => self::id('dave'), 'amountMinor' => 1000, 'method' => 'interac',
        ], self::token('jon')), 201);

        // Someone who never accepted their invite can still get in to settle.
        $latecomer = $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'late-settle@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Late',
        ]), 201);
        $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $latecomer['token']), 200);

        // Renaming, inviting and importing are frozen with the expenses.
        $rename = $this->request('PATCH', '/api/v1/groups/' . self::$groupId, ['name' => 'Ski Peru'], self::token('dave'));
        self::assertSame(409, $rename->getStatusCode());
        self::assertSame('GROUP_LOCKED', self::json($rename)['error']['code']);

        // ---- unlocking, because a receipt always turns up late ----
        $unlocked = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/unlock', [], self::token('dave')), 200);
        self::assertNull($unlocked['lockedAt']);
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Late receipt', 'amountMinor' => 1000, 'currency' => 'CAD',
            'expenseDate' => '2026-08-03', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => self::id('dave'), 'amountMinor' => 1000]],
            'shares' => [['userId' => self::id('dave'), 'amountMinor' => 1000]],
        ], self::token('dave')), 201);

        // ---- the feed says who did what ----
        $activity = $this->ok($this->request(
            'GET',
            '/api/v1/groups/' . self::$groupId . '/activity',
            null,
            self::token('dave'),
        ), 200);
        $verbs = array_column($activity['items'], 'verb');
        foreach (['received', 'locked', 'unlocked'] as $verb) {
            self::assertContains($verb, $verbs);
        }

        // ---- archiving still stops everything, lock or no lock ----
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/archive', [], self::token('dave')), 200);
        $tooLate = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'fromUserId' => self::id('vijay'), 'amountMinor' => 100, 'method' => 'cash',
        ], self::token('dave'));
        self::assertSame(409, $tooLate->getStatusCode());
        self::assertSame('GROUP_ARCHIVED', self::json($tooLate)['error']['code']);
        $noLock = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/lock', [], self::token('dave'));
        self::assertSame(409, $noLock->getStatusCode());
    }
}
