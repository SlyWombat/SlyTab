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
 * Per-group category customisation over HTTP (issue #18): the group renames
 * and hides entries, expenses may sit on a subcategory, and filtering by a
 * heading still sweeps up everything underneath it.
 */
final class GroupCategoriesTest extends TestCase
{
    private static ?SlimApp $app = null;
    private static string $token = '';
    private static string $userId = '';
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
        $r = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $r = $r->withHeader('Content-Type', 'application/json')
                   ->withBody((new StreamFactory())->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        if ($token !== null) {
            $r = $r->withHeader('Authorization', "Bearer {$token}");
        }
        return self::$app->handle($r);
    }

    /** @return array<string,mixed> */
    private static function json(ResponseInterface $r): array
    {
        return json_decode((string) $r->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    private function group(): string
    {
        if (self::$groupId === '') {
            $u = self::json($this->request('POST', '/api/v1/auth/register', [
                'email' => 'cats@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Cat Owner',
            ]));
            self::$token = $u['token'];
            self::$userId = $u['user']['id'];
            $g = self::json($this->request('POST', '/api/v1/groups', [
                'name' => 'Categories', 'emoji' => '🏷️', 'homeCurrency' => 'CAD',
            ], self::$token));
            self::$groupId = $g['id'];
        }
        return self::$groupId;
    }

    public function testAGroupStartsWithNoOverrides(): void
    {
        $r = self::json($this->request('GET', "/api/v1/groups/{$this->group()}/categories", null, self::$token));
        self::assertSame([], (array) $r['overrides']);
    }

    public function testRenameHideAndReorderRoundTrip(): void
    {
        $g = $this->group();
        $payload = ['overrides' => [
            'travel.taxi' => ['label' => 'Chariots'],
            'drinks.beer' => ['hidden' => true],
            'other' => ['sortOrder' => -1],
        ]];
        $saved = self::json($this->request('PUT', "/api/v1/groups/{$g}/categories", $payload, self::$token));
        self::assertSame('Chariots', $saved['overrides']['travel.taxi']['label']);
        self::assertTrue($saved['overrides']['drinks.beer']['hidden']);
        self::assertSame(-1, $saved['overrides']['other']['sortOrder']);

        $fetched = self::json($this->request('GET', "/api/v1/groups/{$g}/categories", null, self::$token));
        self::assertEquals($saved['overrides'], $fetched['overrides']);
    }

    /** A no-op patch stores nothing — that's what keeps the table sparse. */
    public function testResettingToDefaultsDropsTheRows(): void
    {
        $g = $this->group();
        $this->request('PUT', "/api/v1/groups/{$g}/categories", ['overrides' => [
            'travel.taxi' => ['label' => 'Chariots'],
        ]], self::$token);
        $reset = self::json($this->request('PUT', "/api/v1/groups/{$g}/categories", ['overrides' => [
            'travel.taxi' => ['label' => ''],
            'drinks.wine' => ['hidden' => false],
        ]], self::$token));
        self::assertSame([], (array) $reset['overrides']);
    }

    public function testRejectsUnknownSlugsOversizedLabelsAndHidingEverything(): void
    {
        $g = $this->group();
        $bad = $this->request('PUT', "/api/v1/groups/{$g}/categories", ['overrides' => [
            'travel.hovercraft' => ['label' => 'Nope'],
        ]], self::$token);
        self::assertSame(422, $bad->getStatusCode());

        $long = $this->request('PUT', "/api/v1/groups/{$g}/categories", ['overrides' => [
            'travel.taxi' => ['label' => str_repeat('x', 61)],
        ]], self::$token);
        self::assertSame(422, $long->getStatusCode());

        $allHidden = [];
        foreach (\SlyTab\Support\Categories::SLUGS as $slug) {
            $allHidden[$slug] = ['hidden' => true];
        }
        $none = $this->request('PUT', "/api/v1/groups/{$g}/categories", ['overrides' => $allHidden], self::$token);
        self::assertSame(422, $none->getStatusCode());
    }

    public function testExpensesAcceptLeafCategoriesAndHeadingFiltersSweepThemUp(): void
    {
        $g = $this->group();
        foreach ([['Cab home', 'travel.taxi'], ['Flight', 'travel.flights'], ['Beers', 'drinks.bar']] as [$desc, $cat]) {
            $r = $this->request('POST', "/api/v1/groups/{$g}/expenses", [
                'description' => $desc, 'amountMinor' => 1000, 'currency' => 'CAD',
                'expenseDate' => '2026-07-01', 'category' => $cat, 'splitMethod' => 'equal',
                'payers' => [['userId' => self::$userId, 'amountMinor' => 1000]],
                'shares' => [['userId' => self::$userId, 'amountMinor' => 1000]],
            ], self::$token);
            self::assertSame(201, $r->getStatusCode(), (string) $r->getBody());
        }

        $travel = self::json($this->request('GET', "/api/v1/groups/{$g}/expenses?category=travel", null, self::$token));
        self::assertEqualsCanonicalizing(
            ['Cab home', 'Flight'],
            array_column($travel['items'], 'description'),
        );

        $leaf = self::json($this->request('GET', "/api/v1/groups/{$g}/expenses?category=travel.taxi", null, self::$token));
        self::assertSame(['Cab home'], array_column($leaf['items'], 'description'));

        // Totals roll subcategories up under their heading.
        $totals = self::json($this->request('GET', "/api/v1/groups/{$g}/totals", null, self::$token));
        $byHeading = array_column($totals['byHeading'], 'minor', 'category');
        self::assertSame(2000, $byHeading['travel']);
        self::assertSame(1000, $byHeading['drinks']);
        self::assertContains('travel.taxi', array_column($totals['byCategory'], 'category'));
    }

    public function testAnUnknownCategoryOnAnExpenseIsStillRejected(): void
    {
        $r = $this->request('POST', "/api/v1/groups/{$this->group()}/expenses", [
            'description' => 'Bad', 'amountMinor' => 100, 'currency' => 'CAD',
            'expenseDate' => '2026-07-01', 'category' => 'food', 'splitMethod' => 'equal',
            'payers' => [['userId' => self::$userId, 'amountMinor' => 100]],
            'shares' => [['userId' => self::$userId, 'amountMinor' => 100]],
        ], self::$token);
        self::assertSame(400, $r->getStatusCode()); // plain VALIDATION, as before the taxonomy
        self::assertStringContainsString('unknown category', (string) $r->getBody());
    }
}
