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
 * The whole money path over HTTP against real MySQL: group + invites →
 * expenses (equal, multi-payer, foreign currency) → balances + simplified
 * plan → settlements → export/activity — with every FR-critical guard
 * (membership, archived groups, zero-balance leave) exercised.
 */
final class GroupMoneyFlowTest extends TestCase
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
        // Seed ECB rates: 1 EUR = 1.48 CAD, 1 EUR = 1.09 USD → USD→CAD ≈ 1.357798…
        $seed = $pdo->prepare('INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)');
        $seed->execute(['2026-07-20', 'EUR', 'CAD', '1.48']);
        $seed->execute(['2026-07-20', 'EUR', 'USD', '1.09']);
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

    private function ok(ResponseInterface $res, int $expected): array
    {
        self::assertSame($expected, $res->getStatusCode(), (string) $res->getBody());
        return self::json($res);
    }

    public function testEndToEndMoneyFlow(): void
    {
        // ---- users ----
        foreach (['dave', 'alice', 'marc', 'priya'] as $name) {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com",
                'password' => 'a-long-enough-password',
                'displayName' => ucfirst($name),
            ]), 201);
            self::$users[$name] = ['token' => $r['token'], 'id' => $r['user']['id']];
        }
        $u = static fn(string $n): string => self::$users[$n]['id'];
        $t = static fn(string $n): string => self::$users[$n]['token'];

        // ---- group + invites ----
        $group = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Cottage Trip', 'emoji' => '🏕️', 'homeCurrency' => 'CAD',
        ], $t('dave')), 201);
        self::$groupId = $group['id'];

        $invite = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/invites', [], $t('dave')), 201);
        foreach (['alice', 'marc', 'priya'] as $name) {
            $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $t($name)), 200);
        }
        $this->ok($this->request('POST', '/api/v1/join/deadbeef', [], $t('alice')), 410);

        $fetched = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId, null, $t('alice')), 200);
        self::assertCount(4, $fetched['members']);

        // Non-members are kept out.
        $outsider = $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'x@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'X',
        ]), 201);
        self::assertSame(403, $this->request('GET', '/api/v1/groups/' . self::$groupId, null, $outsider['token'])->getStatusCode());

        // ---- expenses ----
        // 1) Groceries C$82.10, Dave pays, equal 4-way (client-computed split).
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Groceries', 'amountMinor' => 8210, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => $u('dave'), 'amountMinor' => 8210]],
            'shares' => [
                ['userId' => $u('dave'), 'amountMinor' => 2053],
                ['userId' => $u('alice'), 'amountMinor' => 2053],
                ['userId' => $u('marc'), 'amountMinor' => 2052],
                ['userId' => $u('priya'), 'amountMinor' => 2052],
            ],
        ], $t('dave')), 201);

        // 2) Marina gas C$60.00, split payers Dave 40 / Priya 20, shares equal.
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Marina gas', 'amountMinor' => 6000, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'travel', 'splitMethod' => 'equal',
            'payers' => [
                ['userId' => $u('dave'), 'amountMinor' => 4000],
                ['userId' => $u('priya'), 'amountMinor' => 2000],
            ],
            'shares' => [
                ['userId' => $u('dave'), 'amountMinor' => 1500],
                ['userId' => $u('alice'), 'amountMinor' => 1500],
                ['userId' => $u('marc'), 'amountMinor' => 1500],
                ['userId' => $u('priya'), 'amountMinor' => 1500],
            ],
        ], $t('priya')), 201);

        // 3) US$100 duty-free, Priya pays, ECB rate (1.48/1.09), equal 4-way.
        $dutyFree = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Duty free', 'amountMinor' => 10000, 'currency' => 'USD',
            'expenseDate' => '2026-07-20', 'category' => 'other', 'splitMethod' => 'equal',
            'payers' => [['userId' => $u('priya'), 'amountMinor' => 10000]],
            'shares' => [
                ['userId' => $u('dave'), 'amountMinor' => 2500],
                ['userId' => $u('alice'), 'amountMinor' => 2500],
                ['userId' => $u('marc'), 'amountMinor' => 2500],
                ['userId' => $u('priya'), 'amountMinor' => 2500],
            ],
        ], $t('priya')), 201);
        self::assertSame('ecb', $dutyFree['fxRateSource']);
        self::assertEqualsWithDelta(1.48 / 1.09, $dutyFree['fxRate'], 0.0001);

        // Guards: bad sums and non-member participants are rejected.
        $bad = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Broken', 'amountMinor' => 1000, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'other', 'splitMethod' => 'exact',
            'payers' => [['userId' => $u('dave'), 'amountMinor' => 1000]],
            'shares' => [['userId' => $u('dave'), 'amountMinor' => 999]],
        ], $t('dave'));
        self::assertSame(400, $bad->getStatusCode());

        $badMember = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Sneaky', 'amountMinor' => 1000, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'other', 'splitMethod' => 'equal',
            'payers' => [['userId' => $u('dave'), 'amountMinor' => 1000]],
            'shares' => [['userId' => $outsider['user']['id'], 'amountMinor' => 1000]],
        ], $t('dave'));
        self::assertSame(422, $badMember->getStatusCode());

        // Unknown-currency expense without a stored rate needs an override.
        $noRate = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Yen thing', 'amountMinor' => 500, 'currency' => 'JPY',
            'expenseDate' => '2026-07-20', 'category' => 'other', 'splitMethod' => 'equal',
            'payers' => [['userId' => $u('dave'), 'amountMinor' => 500]],
            'shares' => [['userId' => $u('dave'), 'amountMinor' => 500]],
        ], $t('dave'));
        self::assertSame(422, $noRate->getStatusCode());
        self::assertSame('FX_RATE_UNAVAILABLE', self::json($noRate)['error']['code']);

        // ---- balances ----
        $balances = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/balances', null, $t('dave')), 200);
        $net = $balances['net'];
        self::assertSame(0, array_sum($net), 'nets must sum to zero (incl. FX rounding)');
        self::assertCount(4, $net);
        // Dave paid 8210+4000, consumed 2053+1500+converted(2500)
        $usdRate = 1.48 / 1.09;
        $daveExpected = (8210 - 2053) + (4000 - 1500) - (int) round(2500 * $usdRate);
        self::assertSame($daveExpected, $net[$u('dave')]);

        // Plan settles the debts exactly.
        $after = $net;
        foreach ($balances['plan'] as $transfer) {
            $after[$transfer['from']] += $transfer['amountMinor'];
            $after[$transfer['to']] -= $transfer['amountMinor'];
        }
        self::assertSame([0, 0, 0, 0], array_values(array_map('intval', $after)));
        self::assertNotEmpty($balances['pairwise']);

        // ---- settlements ----
        $marcOwes = -$net[$u('marc')];
        self::assertGreaterThan(0, $marcOwes);
        $settlement = $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/settlements', [
            'toUserId' => $u('dave'), 'amountMinor' => $marcOwes, 'method' => 'interac',
        ], $t('marc')), 201);
        self::assertSame('pending', $settlement['status']);

        // Pending settlements do not move balances…
        $mid = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/balances', null, $t('marc')), 200);
        self::assertSame($net[$u('marc')], $mid['net'][$u('marc')]);

        // …and only the payee can confirm.
        self::assertSame(403, $this->request('POST', "/api/v1/settlements/{$settlement['id']}/confirm", [], $t('marc'))->getStatusCode());
        $confirmed = $this->ok($this->request('POST', "/api/v1/settlements/{$settlement['id']}/confirm", [], $t('dave')), 200);
        self::assertSame('confirmed', $confirmed['status']);

        $post = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/balances', null, $t('marc')), 200);
        self::assertSame(0, $post['net'][$u('marc')]);
        self::assertSame(0, array_sum($post['net']));

        // Marc is settled → can leave; Alice is not → blocked.
        self::assertSame(409, $this->request('POST', '/api/v1/groups/' . self::$groupId . '/leave', [], $t('alice'))->getStatusCode());
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/leave', [], $t('marc')), 200);

        // ---- delete + restore ----
        $expensesPage = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/expenses', null, $t('dave')), 200);
        self::assertCount(3, $expensesPage['items']);
        $victim = $expensesPage['items'][0]['id'];
        $this->ok($this->request('DELETE', "/api/v1/expenses/{$victim}", null, $t('dave')), 200);
        self::assertCount(2, $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/expenses', null, $t('dave')), 200)['items']);
        $this->ok($this->request('POST', "/api/v1/expenses/{$victim}/restore", [], $t('dave')), 200);
        self::assertCount(3, $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/expenses', null, $t('dave')), 200)['items']);

        // ---- home rollup, export, activity, rates ----
        $home = $this->ok($this->request('GET', '/api/v1/me/balances', null, $t('dave')), 200);
        self::assertNotEmpty($home['items']);
        self::assertSame($post['net'][$u('dave')], $home['items'][0]['netMinor']);

        $csv = $this->request('GET', '/api/v1/groups/' . self::$groupId . '/export.csv', null, $t('dave'));
        self::assertSame(200, $csv->getStatusCode());
        self::assertStringContainsString('text/csv', $csv->getHeaderLine('Content-Type'));
        self::assertStringContainsString('Groceries', (string) $csv->getBody());

        $activity = $this->ok($this->request('GET', '/api/v1/groups/' . self::$groupId . '/activity', null, $t('dave')), 200);
        $verbs = array_column($activity['items'], 'verb');
        foreach (['created', 'joined', 'added', 'settled', 'confirmed', 'deleted', 'restored', 'left'] as $verb) {
            self::assertContains($verb, $verbs);
        }

        $rate = $this->ok($this->request('GET', '/api/v1/rates?date=2026-07-21&base=USD&quote=CAD', null, $t('dave')), 200);
        self::assertEqualsWithDelta($usdRate, $rate['rate'], 0.0001);

        // ---- archive makes the group read-only ----
        $this->ok($this->request('POST', '/api/v1/groups/' . self::$groupId . '/archive', [], $t('dave')), 200);
        $blocked = $this->request('POST', '/api/v1/groups/' . self::$groupId . '/expenses', [
            'description' => 'Too late', 'amountMinor' => 100, 'currency' => 'CAD',
            'expenseDate' => '2026-07-21', 'category' => 'other', 'splitMethod' => 'equal',
            'payers' => [['userId' => $u('dave'), 'amountMinor' => 100]],
            'shares' => [['userId' => $u('dave'), 'amountMinor' => 100]],
        ], $t('dave'));
        self::assertSame(409, $blocked->getStatusCode());
        self::assertSame('GROUP_ARCHIVED', self::json($blocked)['error']['code']);
    }

    /**
     * FR-6.4: the home screen total is converted into the user's default
     * currency, and changing that currency re-denominates the total.
     */
    public function testHomeTotalConvertsIntoTheUsersDefaultCurrency(): void
    {
        // Rates dated today so the "latest rate" lookup finds them.
        $seed = Db::pdo()->prepare(
            'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
        );
        $today = gmdate('Y-m-d');
        $seed->execute([$today, 'EUR', 'CAD', '1.50']);
        $seed->execute([$today, 'EUR', 'USD', '1.20']); // USD→CAD = 1.50/1.20 = 1.25

        $mk = function (string $name): array {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'password-123',
                'displayName' => ucfirst($name), 'deviceLabel' => 'test',
            ]), 201);
            return ['token' => $r['token'], 'id' => $r['user']['id']];
        };
        $harry = $mk('harry');
        $wanda = $mk('wanda');

        foreach ([['Trip CAD', 'CAD'], ['Trip USD', 'USD']] as [$name, $cur]) {
            $g = $this->ok($this->request('POST', '/api/v1/groups', [
                'name' => $name, 'emoji' => '', 'homeCurrency' => $cur,
            ], $harry['token']), 201);
            $invite = $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/invites", [], $harry['token']), 201);
            $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $wanda['token']), 200);
            $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
                'description' => 'Dinner', 'amountMinor' => 1000, 'currency' => $cur,
                'expenseDate' => $today, 'category' => 'dining', 'splitMethod' => 'equal',
                'payers' => [['userId' => $harry['id'], 'amountMinor' => 1000]],
                'shares' => [
                    ['userId' => $harry['id'], 'amountMinor' => 500],
                    ['userId' => $wanda['id'], 'amountMinor' => 500],
                ],
            ], $harry['token']), 201);
        }

        // Default currency CAD: 500 CAD + 500 USD × 1.25 = 1125 CAD.
        $home = $this->ok($this->request('GET', '/api/v1/me/balances', null, $harry['token']), 200);
        self::assertSame(1125, $home['total']['minor']);
        self::assertSame('CAD', $home['total']['currency']);
        self::assertTrue($home['total']['approximate']);
        self::assertSame([], $home['total']['excluded']);

        // Switching the profile currency re-denominates the same debts:
        // 500 USD + 500 CAD × 0.8 = 900 USD.
        $this->ok($this->request('PATCH', '/api/v1/me', ['defaultCurrency' => 'USD'], $harry['token']), 200);
        $home = $this->ok($this->request('GET', '/api/v1/me/balances', null, $harry['token']), 200);
        self::assertSame(900, $home['total']['minor']);
        self::assertSame('USD', $home['total']['currency']);

        // Wanda owes the mirror image in her own default currency.
        $home = $this->ok($this->request('GET', '/api/v1/me/balances', null, $wanda['token']), 200);
        self::assertSame(-1125, $home['total']['minor']);
        self::assertSame('CAD', $home['total']['currency']);
    }

    public function testGroupTotalsAggregateInHomeCurrency(): void
    {
        $reg = $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'totals@example.com', 'password' => 'password-123',
            'displayName' => 'Totals', 'deviceLabel' => 'test',
        ]), 201);
        $t = $reg['token'];
        $uid = $reg['user']['id'];
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Totals', 'emoji' => '', 'homeCurrency' => 'CAD',
        ], $t), 201);

        foreach ([
            ['Lunch', 1000, 'dining', '2026-06-05'],
            ['Taxi', 500, 'travel', '2026-07-01'],
            ['Snacks', 250, 'drinks', '2026-07-02'],
        ] as [$desc, $minor, $cat, $date]) {
            $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
                'description' => $desc, 'amountMinor' => $minor, 'currency' => 'CAD',
                'expenseDate' => $date, 'category' => $cat, 'splitMethod' => 'equal',
                'payers' => [['userId' => $uid, 'amountMinor' => $minor]],
                'shares' => [['userId' => $uid, 'amountMinor' => $minor]],
            ], $t), 201);
        }

        $totals = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/totals", null, $t), 200);
        self::assertSame(1750, $totals['totalMinor']);
        self::assertSame(['category' => 'dining', 'minor' => 1000], $totals['byCategory'][0]);
        self::assertSame(['userId' => $uid, 'minor' => 1750], $totals['byPayer'][0]);
        self::assertSame(['userId' => $uid, 'minor' => 1750], $totals['byShare'][0]);
        self::assertSame(['month' => '2026-07', 'minor' => 750], $totals['byMonth'][0]);
        self::assertSame(['month' => '2026-06', 'minor' => 1000], $totals['byMonth'][1]);
    }

    /** The Cabify bug: CLP minor units are whole pesos; USD minor units
     *  are cents. Conversion must bridge the scales (4240 CLP ≈ US$4.52,
     *  not US$0.05). */
    public function testZeroDecimalCurrencyConvertsAcrossScales(): void
    {
        Db::pdo()->exec('DELETE FROM rate_limits');
        $seed = Db::pdo()->prepare(
            'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
        );
        $today = gmdate('Y-m-d');
        $seed->execute([$today, 'EUR', 'USD', '1.1392']);
        $seed->execute([$today, 'EUR', 'CLP', '1069.68911941']);

        $mk = function (string $name): array {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'password-123',
                'displayName' => ucfirst($name), 'deviceLabel' => 'test',
            ]), 201);
            return ['token' => $r['token'], 'id' => $r['user']['id']];
        };
        $pia = $mk('pia');
        $quinn = $mk('quinn');
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Chile', 'emoji' => '', 'homeCurrency' => 'USD',
        ], $pia['token']), 201);
        $invite = $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/invites", [], $pia['token']), 201);
        $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $quinn['token']), 200);

        // 4240 pesos (CLP minor = whole pesos), split evenly.
        $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
            'description' => 'Cabify', 'amountMinor' => 4240, 'currency' => 'CLP',
            'expenseDate' => $today, 'category' => 'travel', 'splitMethod' => 'equal',
            'payers' => [['userId' => $pia['id'], 'amountMinor' => 4240]],
            'shares' => [
                ['userId' => $pia['id'], 'amountMinor' => 2120],
                ['userId' => $quinn['id'], 'amountMinor' => 2120],
            ],
        ], $pia['token']), 201);

        // CLP→USD ≈ 0.00106498; 2120 pesos ≈ 226 US cents.
        $bal = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/balances", null, $pia['token']), 200);
        self::assertSame(0, $bal['net'][$pia['id']] + $bal['net'][$quinn['id']]);
        self::assertGreaterThan(200, $bal['net'][$pia['id']]);
        self::assertLessThan(250, $bal['net'][$pia['id']]);

        // Totals: whole ride ≈ 452 US cents.
        $totals = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/totals", null, $pia['token']), 200);
        self::assertGreaterThan(400, $totals['totalMinor']);
        self::assertLessThan(500, $totals['totalMinor']);
    }

    public function testFriendsCommentsAndFilters(): void
    {
        Db::pdo()->exec('DELETE FROM rate_limits');
        $mk = function (string $name): array {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'password-123',
                'displayName' => ucfirst($name), 'deviceLabel' => 'test',
            ]), 201);
            return ['token' => $r['token'], 'id' => $r['user']['id']];
        };
        $rae = $mk('rae');

        // Friends (#12): direct group with a not-yet-registered person.
        $direct = $this->ok($this->request('POST', '/api/v1/friends', [
            'email' => 'pal@example.com',
        ], $rae['token']), 201);
        self::assertTrue($direct['isDirect']);
        self::assertCount(2, $direct['members']);
        // Same email → same direct group, not a duplicate.
        $again = $this->ok($this->request('POST', '/api/v1/friends', [
            'email' => 'pal@example.com',
        ], $rae['token']), 201);
        self::assertSame($direct['id'], $again['id']);

        // Expenses to filter (#17).
        foreach ([['Wine bar', 'drinks'], ['Groceries run', 'dining'], ['Gas fill', 'travel']] as [$d, $cat]) {
            $this->ok($this->request('POST', "/api/v1/groups/{$direct['id']}/expenses", [
                'description' => $d, 'amountMinor' => 1000, 'currency' => 'CAD',
                'expenseDate' => '2026-07-20', 'category' => $cat, 'splitMethod' => 'equal',
                'payers' => [['userId' => $rae['id'], 'amountMinor' => 1000]],
                'shares' => [['userId' => $rae['id'], 'amountMinor' => 1000]],
            ], $rae['token']), 201);
        }
        $hits = $this->ok($this->request('GET', "/api/v1/groups/{$direct['id']}/expenses?q=wine", null, $rae['token']), 200);
        self::assertCount(1, $hits['items']);
        self::assertSame('Wine bar', $hits['items'][0]['description']);
        $hits = $this->ok($this->request('GET', "/api/v1/groups/{$direct['id']}/expenses?category=travel", null, $rae['token']), 200);
        self::assertCount(1, $hits['items']);

        // Comments (#15).
        $eid = $hits['items'][0]['id'];
        $c = $this->ok($this->request('POST', "/api/v1/expenses/{$eid}/comments", [
            'body' => 'was this the rental or the truck?',
        ], $rae['token']), 201);
        self::assertSame('was this the rental or the truck?', $c['body']);
        $list = $this->ok($this->request('GET', "/api/v1/expenses/{$eid}/comments", null, $rae['token']), 200);
        self::assertCount(1, $list['items']);
        self::assertSame($rae['id'], $list['items'][0]['userId']);
    }

    public function testGroupFavoriteCurrencies(): void
    {
        Db::pdo()->exec('DELETE FROM rate_limits');
        $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'favs@example.com', 'password' => 'password-123',
            'displayName' => 'Favs', 'deviceLabel' => 'test',
        ]), 201);
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Trip', 'emoji' => '', 'homeCurrency' => 'CAD',
            'currencies' => ['usd', 'MXN', 'CAD', 'USD'],
        ], $r['token']), 201);
        // deduped, uppercased, home currency dropped
        self::assertSame(['USD', 'MXN'], $g['currencies']);

        $g = $this->ok($this->request('PATCH', "/api/v1/groups/{$g['id']}", [
            'name' => 'Winter Trip', 'emoji' => '⛷️', 'currencies' => ['EUR'],
        ], $r['token']), 200);
        self::assertSame('Winter Trip', $g['name']);
        self::assertSame('⛷️', $g['emoji']);
        self::assertSame(['EUR'], $g['currencies']);

        $bad = $this->request('PATCH', "/api/v1/groups/{$g['id']}", [
            'currencies' => ['NOT A CODE'],
        ], $r['token']);
        self::assertSame(400, $bad->getStatusCode());
    }

    public function testExpenseLinksMultipleReceipts(): void
    {
        Db::pdo()->exec('DELETE FROM rate_limits'); // shared test IP
        $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'receipts@example.com', 'password' => 'password-123',
            'displayName' => 'Receipts', 'deviceLabel' => 'test',
        ]), 201);
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Receipts', 'emoji' => '', 'homeCurrency' => 'CAD',
        ], $r['token']), 201);

        $pdo = Db::pdo();
        $mk = static function (string $id) use ($pdo, $g, $r): void {
            $pdo->prepare('INSERT INTO receipts (id, group_id, image_path, created_by) VALUES (?, ?, ?, ?)')
                ->execute([$id, $g['id'], "receipts/{$g['id']}/{$id}.jpg", $r['user']['id']]);
        };
        $mk('01TESTRECEIPTBILL000000000');
        $mk('01TESTRECEIPTSLIP000000000');

        $e = $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
            'description' => 'Dinner with tip slip', 'amountMinor' => 5750, 'currency' => 'CAD',
            'expenseDate' => '2026-07-22', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => $r['user']['id'], 'amountMinor' => 5750]],
            'shares' => [['userId' => $r['user']['id'], 'amountMinor' => 5750]],
            'receiptIds' => ['01TESTRECEIPTBILL000000000', '01TESTRECEIPTSLIP000000000'],
        ], $r['token']), 201);

        $linked = $pdo->prepare('SELECT id FROM receipts WHERE expense_id = ? ORDER BY id');
        $linked->execute([$e['id']]);
        self::assertSame(
            ['01TESTRECEIPTBILL000000000', '01TESTRECEIPTSLIP000000000'],
            $linked->fetchAll(\PDO::FETCH_COLUMN),
        );
        self::assertSame('01TESTRECEIPTBILL000000000', $e['receiptId']);

        // A receipt from another group cannot be attached.
        $bad = $this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
            'description' => 'Bad link', 'amountMinor' => 100, 'currency' => 'CAD',
            'expenseDate' => '2026-07-22', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => $r['user']['id'], 'amountMinor' => 100]],
            'shares' => [['userId' => $r['user']['id'], 'amountMinor' => 100]],
            'receiptIds' => ['01DOESNOTEXIST000000000000'],
        ], $r['token']);
        self::assertSame(422, $bad->getStatusCode());
    }

    public function testAccountDeletionAnonymizesButKeepsBalances(): void
    {
        Db::pdo()->exec('DELETE FROM rate_limits'); // shared test IP
        $mk = function (string $name): array {
            $r = $this->ok($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'password-123',
                'displayName' => ucfirst($name), 'deviceLabel' => 'test',
            ]), 201);
            return ['token' => $r['token'], 'id' => $r['user']['id']];
        };
        $gone = $mk('goner');
        $stay = $mk('stayer');
        $g = $this->ok($this->request('POST', '/api/v1/groups', [
            'name' => 'Farewell', 'emoji' => '', 'homeCurrency' => 'CAD',
        ], $gone['token']), 201);
        $invite = $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/invites", [], $gone['token']), 201);
        $this->ok($this->request('POST', "/api/v1/join/{$invite['token']}", [], $stay['token']), 200);
        $this->ok($this->request('POST', "/api/v1/groups/{$g['id']}/expenses", [
            'description' => 'Last supper', 'amountMinor' => 2000, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'dining', 'splitMethod' => 'equal',
            'payers' => [['userId' => $gone['id'], 'amountMinor' => 2000]],
            'shares' => [
                ['userId' => $gone['id'], 'amountMinor' => 1000],
                ['userId' => $stay['id'], 'amountMinor' => 1000],
            ],
        ], $gone['token']), 201);

        // Wrong confirmation is rejected; correct one deletes.
        $bad = $this->request('DELETE', '/api/v1/me', ['confirmEmail' => 'wrong@example.com'], $gone['token']);
        self::assertSame(400, $bad->getStatusCode());
        $this->ok($this->request('DELETE', '/api/v1/me', ['confirmEmail' => 'goner@example.com'], $gone['token']), 200);

        // Session revoked, login gone. (Clear the shared-IP rate limiter
        // first — this class registers a lot of users.)
        Db::pdo()->exec('DELETE FROM rate_limits');
        self::assertSame(401, $this->request('GET', '/api/v1/me', null, $gone['token'])->getStatusCode());
        self::assertSame(401, $this->request('POST', '/api/v1/auth/login', [
            'email' => 'goner@example.com', 'password' => 'password-123',
        ])->getStatusCode());

        // The email slot is free again.
        $this->ok($this->request('POST', '/api/v1/auth/register', [
            'email' => 'goner@example.com', 'password' => 'password-456',
            'displayName' => 'Goner II', 'deviceLabel' => 'test',
        ]), 201);

        // The survivor still owes the debt; the payer is anonymized, not erased.
        $bal = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}/balances", null, $stay['token']), 200);
        self::assertSame(-1000, $bal['net'][$stay['id']]);
        self::assertSame(1000, $bal['net'][$gone['id']]);
        $members = $this->ok($this->request('GET', "/api/v1/groups/{$g['id']}", null, $stay['token']), 200)['members'];
        self::assertNotContains($gone['id'], array_column($members, 'id'), 'deleted user is no longer an active member');
    }
}
