<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;

/**
 * Issue #101: "My expenses" — every expense your money is in, across groups.
 *
 * The pagination tests are the point. The existing cursor works only because
 * ULIDs sort by time; sorting by amount breaks that, and a broken cursor does
 * not throw — it silently repeats and skips rows as you scroll. That is
 * invisible in a ten-row fixture and obvious at two hundred real expenses, so
 * it is asserted here across several pages.
 */
final class MyExpensesTest extends TestCase
{
    private static ?SlimApp $app = null;
    private static string $token = '';
    private static string $meId = '';

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

    private function request(string $path, ?string $token = null): ResponseInterface
    {
        $r = (new ServerRequestFactory())->createServerRequest('GET', $path);
        if ($token !== null) {
            $r = $r->withHeader('Authorization', 'Bearer ' . $token);
        }
        return self::$app->handle($r);
    }

    private function post(string $path, array $body, ?string $token = null): array
    {
        $r = (new ServerRequestFactory())->createServerRequest('POST', $path)
            ->withHeader('Content-Type', 'application/json');
        if ($token !== null) {
            $r = $r->withHeader('Authorization', 'Bearer ' . $token);
        }
        $stream = (new \Slim\Psr7\Factory\StreamFactory())
            ->createStream(json_encode($body, JSON_THROW_ON_ERROR));
        $res = self::$app->handle($r->withBody($stream));
        return json_decode((string) $res->getBody(), true) ?? [];
    }

    private static function json(ResponseInterface $r): array
    {
        return json_decode((string) $r->getBody(), true) ?? [];
    }

    protected function setUp(): void
    {
        $pdo = Db::pdo();
        // Users have a spread of dependants (verifications, resets, activity,
        // notification queue). Listing them by hand invites exactly the FK
        // failure this hit; drop the checks for the wipe as Migrator::fresh
        // does, then restore them.
        $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach (['expense_shares', 'expense_payers', 'expense_comments', 'expenses',
                  'settlements', 'activity', 'notification_emails', 'memberships',
                  'invites', 'sessions', 'email_verifications', 'password_resets',
                  'oauth_identities', 'push_tokens', '`groups`', 'users',
                  // Registration is rate-limited per IP (10/min). Eight tests
                  // registering two users each trips it, and the failure looks
                  // like a null token rather than a 429.
                  'rate_limits'] as $t) {
            $pdo->exec("DELETE FROM {$t}");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');

        $me = $this->post('/api/v1/auth/register', [
            'email' => 'me@example.com', 'password' => 'correct-horse-1', 'displayName' => 'Me',
        ]);
        self::$token = $me['token'];
        self::$meId = $me['user']['id'];

        $other = $this->post('/api/v1/auth/register', [
            'email' => 'other@example.com', 'password' => 'correct-horse-2', 'displayName' => 'Other',
        ]);
        $this->otherToken = $other['token'];
        $this->otherId = $other['user']['id'];

        $g = $this->post('/api/v1/groups', ['name' => 'Trip', 'homeCurrency' => 'CAD'], self::$token);
        $this->groupId = $g['id'];
        $pdo->prepare('INSERT INTO memberships (group_id, user_id) VALUES (?, ?)')
            ->execute([$this->groupId, $this->otherId]);
    }

    private string $otherToken = '';
    private string $otherId = '';
    private string $groupId = '';

    /**
     * The API takes explicit payers and shares, each summing to the total —
     * it does not compute an equal split server-side. One payer, split evenly
     * between the two members.
     */
    private function expense(string $desc, int $minor, string $payerId, ?string $token = null): array
    {
        $half = intdiv($minor, 2);
        return $this->post("/api/v1/groups/{$this->groupId}/expenses", [
            'description' => $desc,
            'amountMinor' => $minor,
            'currency' => 'CAD',
            'expenseDate' => '2026-07-20',
            'category' => 'other',
            'splitMethod' => 'equal',
            'payers' => [['userId' => $payerId, 'amountMinor' => $minor]],
            'shares' => [
                ['userId' => self::$meId, 'amountMinor' => $half],
                ['userId' => $this->otherId, 'amountMinor' => $minor - $half],
            ],
            'allowDuplicate' => true,
        ], $token ?? self::$token);
    }

    public function testScopePaidMeansMyMoneyWentOutNotWhoTypedItIn(): void
    {
        // Entered by me, paid by the other person.
        $this->expense('they paid', 5000, $this->otherId);
        // Entered by them, paid by me.
        $this->expense('I paid', 3000, self::$meId, $this->otherToken);

        $paid = self::json($this->request('/api/v1/me/expenses?scope=paid', self::$token));
        $descs = array_column($paid['items'], 'description');

        self::assertSame(['I paid'], $descs, "'paid' follows the money, not the data entry");
    }

    public function testScopeInvolvedIncludesExpensesSomeoneElsePaidFor(): void
    {
        $this->expense('they paid', 5000, $this->otherId);
        $this->expense('I paid', 3000, self::$meId);

        $mine = self::json($this->request('/api/v1/me/expenses?scope=involved', self::$token));

        self::assertCount(2, $mine['items'], 'an equal split gives me a share of both');
    }

    public function testOtherPeoplesGroupsAreNotVisible(): void
    {
        $solo = $this->post('/api/v1/groups', ['name' => 'Theirs', 'homeCurrency' => 'CAD'], $this->otherToken);
        $this->post("/api/v1/groups/{$solo['id']}/expenses", [
            'description' => 'not mine', 'amountMinor' => 9900, 'currency' => 'CAD',
            'expenseDate' => '2026-07-20', 'category' => 'other', 'splitMethod' => 'equal',
            'payers' => [['userId' => $this->otherId, 'amountMinor' => 9900]],
            'shares' => [['userId' => $this->otherId, 'amountMinor' => 9900]],
        ], $this->otherToken);

        $mine = self::json($this->request('/api/v1/me/expenses?scope=involved', self::$token));

        self::assertSame([], array_filter(
            array_column($mine['items'], 'description'),
            static fn(string $d): bool => $d === 'not mine',
        ));
    }

    /** The cursor must survive a sort that is not the ULID order. */
    public function testAmountSortedPaginationHasNoDuplicatesAndNoGaps(): void
    {
        // Deliberate ties: two expenses at the same amount are exactly what
        // breaks a naive amount-only cursor.
        $amounts = [500, 500, 1200, 300, 900, 900, 900, 4200, 100, 2500, 700, 1200];
        foreach ($amounts as $i => $a) {
            $this->expense("e{$i}", $a, self::$meId);
        }

        foreach (['largest', 'smallest'] as $sort) {
            $seen = [];
            $cursor = null;
            $pages = 0;
            do {
                $url = "/api/v1/me/expenses?scope=paid&sort={$sort}&limit=5"
                    . ($cursor !== null ? '&cursor=' . urlencode($cursor) : '');
                $page = self::json($this->request($url, self::$token));
                foreach ($page['items'] as $it) {
                    self::assertArrayNotHasKey($it['id'], $seen, "{$sort}: row repeated across pages");
                    $seen[$it['id']] = (int) $it['amountMinor'];
                }
                $cursor = $page['nextCursor'] ?? null;
                $pages++;
                self::assertLessThan(20, $pages, "{$sort}: pagination did not terminate");
            } while ($cursor !== null);

            self::assertCount(count($amounts), $seen, "{$sort}: rows were skipped");

            $got = array_values($seen);
            $want = $amounts;
            sort($want);
            if ($sort === 'largest') {
                rsort($want);
            }
            self::assertSame($want, $got, "{$sort}: wrong order across page boundaries");
        }
    }

    public function testTimeSortedPaginationStillWorksBothWays(): void
    {
        foreach (range(1, 7) as $i) {
            $this->expense("t{$i}", 100 * $i, self::$meId);
        }
        foreach (['newest', 'oldest'] as $sort) {
            $seen = [];
            $cursor = null;
            do {
                $url = "/api/v1/me/expenses?scope=paid&sort={$sort}"
                    . ($cursor !== null ? '&cursor=' . urlencode($cursor) : '');
                $page = self::json($this->request($url, self::$token));
                foreach ($page['items'] as $it) {
                    self::assertArrayNotHasKey($it['id'], $seen, "{$sort}: repeated");
                    $seen[$it['id']] = true;
                }
                $cursor = $page['nextCursor'] ?? null;
            } while ($cursor !== null);
            self::assertCount(7, $seen, "{$sort}: rows missing");
        }
    }

    public function testSummaryTotalsMySharesNotTheWholeExpense(): void
    {
        // Two members, equal split: my share of 10.00 is 5.00.
        $this->expense('dinner', 1000, self::$meId);

        $r = self::json($this->request('/api/v1/me/expenses?scope=involved', self::$token));

        self::assertSame(1, $r['summary']['count']);
        self::assertSame(500, $r['summary']['totalMinor'], 'my share, not the bill');
        self::assertSame('CAD', $r['summary']['currency']);
        self::assertFalse($r['summary']['approximate'], 'single currency needs no hedging');
    }

    public function testSearchAndCategoryNarrowBothListAndTotal(): void
    {
        $this->expense('taxi to airport', 4000, self::$meId);
        $this->expense('groceries', 2000, self::$meId);

        $r = self::json($this->request('/api/v1/me/expenses?scope=paid&q=taxi', self::$token));

        self::assertCount(1, $r['items']);
        self::assertSame(1, $r['summary']['count'], 'the total follows the filter, not the page');
    }

    public function testSignedOutIsRefused(): void
    {
        self::assertSame(401, $this->request('/api/v1/me/expenses')->getStatusCode());
    }
}
