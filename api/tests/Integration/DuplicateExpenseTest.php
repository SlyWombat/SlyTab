<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;

/**
 * Duplicate protection (issue #76). Two identical expenses reached
 * production from a single receipt scan — a double-tapped Save — and
 * silently doubled a member's spending.
 *
 * The owner's rule: warn and don't allow it, and a re-run import drops
 * what it already has.
 */
final class DuplicateExpenseTest extends TestCase
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

    private function request(string $method, string $path, ?array $body = null, ?string $token = null, ?UploadedFile $csv = null): ResponseInterface
    {
        $r = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($csv !== null) {
            $r = $r->withUploadedFiles(['csv' => $csv])->withParsedBody($body ?? []);
        } elseif ($body !== null) {
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
                'email' => 'dupes@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Dupe Tester',
            ]));
            self::$token = $u['token'];
            self::$userId = $u['user']['id'];
            $g = self::json($this->request('POST', '/api/v1/groups', [
                'name' => 'Dupes', 'emoji' => '👯', 'homeCurrency' => 'CLP',
            ], self::$token));
            self::$groupId = $g['id'];
        }
        return self::$groupId;
    }

    /** @return array<string,mixed> */
    private function expenseBody(array $overrides = []): array
    {
        return $overrides + [
            'description' => 'REST VALLE LOUNGE BCOIN33',
            'amountMinor' => 80190,
            'currency' => 'CLP',
            'expenseDate' => '2026-07-26',
            'category' => 'dining.restaurant',
            'splitMethod' => 'equal',
            'payers' => [['userId' => self::$userId, 'amountMinor' => 80190]],
            'shares' => [['userId' => self::$userId, 'amountMinor' => 80190]],
        ];
    }

    public function testTheSecondIdenticalSaveIsRefused(): void
    {
        $g = $this->group();
        $first = $this->request('POST', "/api/v1/groups/{$g}/expenses", $this->expenseBody(), self::$token);
        self::assertSame(201, $first->getStatusCode(), (string) $first->getBody());

        // The double tap.
        $second = $this->request('POST', "/api/v1/groups/{$g}/expenses", $this->expenseBody(), self::$token);
        self::assertSame(409, $second->getStatusCode());
        $err = self::json($second)['error'];
        self::assertSame('DUPLICATE_EXPENSE', $err['code']);
        self::assertStringContainsString('already in this group', $err['message']);

        $items = self::json($this->request('GET', "/api/v1/groups/{$g}/expenses", null, self::$token))['items'];
        self::assertCount(1, $items, 'the group must still hold exactly one');
    }

    /** Warned, not forbidden: the user can confirm a genuine repeat. */
    public function testItCanBeFiledAnywayOnceConfirmed(): void
    {
        $g = $this->group();
        $ok = $this->request('POST', "/api/v1/groups/{$g}/expenses",
            $this->expenseBody(['allowDuplicate' => true]), self::$token);
        self::assertSame(201, $ok->getStatusCode(), (string) $ok->getBody());

        $items = self::json($this->request('GET', "/api/v1/groups/{$g}/expenses", null, self::$token))['items'];
        self::assertCount(2, $items);
    }

    /** Anything genuinely different is not a duplicate. */
    public function testDifferentAmountOrDateOrDescriptionIsAllowed(): void
    {
        $g = $this->group();
        foreach ([
            ['amountMinor' => 80191, 'payers' => [['userId' => self::$userId, 'amountMinor' => 80191]],
             'shares' => [['userId' => self::$userId, 'amountMinor' => 80191]]],
            ['expenseDate' => '2026-07-25'],
            ['description' => 'REST VALLE LOUNGE BCOIN33 (round two)'],
        ] as $i => $diff) {
            $r = $this->request('POST', "/api/v1/groups/{$g}/expenses",
                $this->expenseBody($diff), self::$token);
            self::assertSame(201, $r->getStatusCode(), "variant {$i}: " . (string) $r->getBody());
        }
    }

    /**
     * Re-running the same import drops what it already has, rather than
     * doubling the group's spending.
     */
    public function testReimportingTheSameFileDropsDuplicates(): void
    {
        $u = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'reimport@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Ana R',
        ]));
        $token = $u['token'];
        $me = $u['user']['id'];
        $g = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Reimport', 'emoji' => '♻️', 'homeCurrency' => 'CAD',
        ], $token));

        $csv = "Date,Description,Category,Cost,Currency,Ana R\n"
            . "2026-06-01,Groceries,Groceries,82.10,CAD,0\n"
            . "2026-06-02,Taxi,Taxi,20.00,CAD,0\n";
        // Solo rows have no balance effect, so give them one: a second member.
        $v = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'reimport2@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Ben S',
        ]));
        $invite = self::json($this->request('POST', "/api/v1/groups/{$g['id']}/invites", [], $token));
        $this->request('POST', "/api/v1/join/{$invite['token']}", [], $v['token']);

        $csv = "Date,Description,Category,Cost,Currency,Ana R,Ben S\n"
            . "2026-06-01,Groceries,Groceries,82.10,CAD,41.05,-41.05\n"
            . "2026-06-02,Taxi,Taxi,20.00,CAD,10.00,-10.00\n";
        $mapping = json_encode(['Ana R' => $me, 'Ben S' => $v['user']['id']], JSON_THROW_ON_ERROR);
        $upload = fn(): UploadedFile => new UploadedFile(
            (new StreamFactory())->createStream($csv), 'group.csv', 'text/csv', strlen($csv), UPLOAD_ERR_OK,
        );

        $first = self::json($this->request('POST', "/api/v1/groups/{$g['id']}/import/splitwise",
            ['mapping' => $mapping], $token, $upload()));
        self::assertSame(2, $first['imported']['expenses'], json_encode($first));
        self::assertSame(0, $first['imported']['duplicates']);

        // Same file again — the owner's rule: it should drop duplicates.
        $again = self::json($this->request('POST', "/api/v1/groups/{$g['id']}/import/splitwise",
            ['mapping' => $mapping], $token, $upload()));
        self::assertSame(0, $again['imported']['expenses'], json_encode($again));
        self::assertSame(2, $again['imported']['duplicates']);

        $items = self::json($this->request('GET', "/api/v1/groups/{$g['id']}/expenses", null, $token))['items'];
        self::assertCount(2, $items, 'a re-import must not double the group');
    }
}
