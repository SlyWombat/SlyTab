<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\UploadedFileInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;

/**
 * Splitwise CSV import over HTTP against real MySQL: dry-run inspection,
 * member mapping, balance-exact reconstruction (incl. a rounding-residual
 * row, a multi-payer row, a foreign-currency row with a seeded historical
 * rate, a payment row, and a skipped personal expense). The acid test:
 * post-import group balances must equal the CSV's per-member net totals.
 */
final class SplitwiseImportTest extends TestCase
{
    private static ?SlimApp $app = null;
    /** @var array<string, array{token:string, id:string}> */
    private static array $users = [];

    private const CSV = <<<CSV
Date,Description,Category,Cost,Currency,Dave S,Alice R,Marc T
2026-06-01,Groceries,Groceries,82.10,CAD,54.73,-27.37,-27.36
2026-06-02,Marina gas,Gas/fuel,60.00,CAD,20.00,20.00,-40.00
2026-06-03,Duty free,Entertainment,100.00,USD,66.67,-33.33,-33.33
2026-06-04,Rounding demo,General,10.00,CAD,6.67,-3.33,-3.33
2026-06-05,My own coffee,Dining out,4.50,CAD,0,0,0
2026-06-06,Marc paid Dave S,Payment,25.00,CAD,-25.00,0,25.00

,Total balance,,,,,,
CSV;

    /**
     * A zero-decimal group (CLP has scale 1, not 100). Splitwise still
     * writes decimal shares for it, so the importer has to round to whole
     * pesos AND keep the row balance-exact.
     */
    private const CLP_CSV = <<<CSV
Date,Description,Category,Cost,Currency,Ana P,Bruno L,Caro M
2026-06-10,Airport Cabify,Taxi,42400,CLP,-14133.33,-14133.33,28266.66
2026-06-11,Wine bar,Liquor,21670,CLP,14446.67,-7223.33,-7223.34

,Total balance,,,,,,
CSV;

    public static function setUpBeforeClass(): void
    {
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        // Historical ECB seed so the USD row needs no network fetch.
        $seed = $pdo->prepare('INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)');
        $seed->execute(['2026-06-03', 'EUR', 'CAD', '1.50']);
        $seed->execute(['2026-06-03', 'EUR', 'USD', '1.00']);
        self::$app = App::create();
    }

    private function request(string $method, string $path, ?array $body = null, ?string $token = null, ?UploadedFileInterface $csv = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($csv !== null) {
            $request = $request->withUploadedFiles(['csv' => $csv])->withParsedBody($body ?? []);
        } elseif ($body !== null) {
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        if ($token !== null) {
            $request = $request->withHeader('Authorization', "Bearer {$token}");
        }
        return self::$app->handle($request);
    }

    private static function csvUpload(string $content): UploadedFileInterface
    {
        return new UploadedFile(
            (new StreamFactory())->createStream($content),
            'group.csv', 'text/csv', strlen($content), UPLOAD_ERR_OK,
        );
    }

    /** @return array<string,mixed> */
    private static function json(ResponseInterface $r): array
    {
        return json_decode((string) $r->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function testFullImport(): void
    {
        foreach (['dave', 'alice', 'marc'] as $name) {
            $r = self::json($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$name}@example.com", 'password' => 'a-long-enough-password',
                'displayName' => ucfirst($name),
            ]));
            self::$users[$name] = ['token' => $r['token'], 'id' => $r['user']['id']];
        }
        $u = static fn(string $n): string => self::$users[$n]['id'];
        $tok = self::$users['dave']['token'];

        $group = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Imported Trip', 'emoji' => '🧳', 'homeCurrency' => 'CAD',
        ], $tok));
        $invite = self::json($this->request('POST', "/api/v1/groups/{$group['id']}/invites", [], $tok));
        foreach (['alice', 'marc'] as $n) {
            $this->request('POST', "/api/v1/join/{$invite['token']}", [], self::$users[$n]['token']);
        }

        // ---- dry run ----
        $inspect = self::json($this->request(
            'POST', "/api/v1/groups/{$group['id']}/import/splitwise",
            ['dryRun' => '1'], $tok, self::csvUpload(self::CSV),
        ));
        self::assertSame(['Dave S', 'Alice R', 'Marc T'], $inspect['members']);
        self::assertSame(5, $inspect['expenseRows']);
        self::assertSame(1, $inspect['paymentRows']);
        self::assertEqualsCanonicalizing(['CAD', 'USD'], $inspect['currencies']);

        // ---- incomplete mapping is rejected ----
        $bad = $this->request(
            'POST', "/api/v1/groups/{$group['id']}/import/splitwise",
            ['mapping' => json_encode(['Dave S' => $u('dave')])], $tok, self::csvUpload(self::CSV),
        );
        self::assertSame(422, $bad->getStatusCode());

        // ---- real import ----
        $mapping = json_encode([
            'Dave S' => $u('dave'), 'Alice R' => $u('alice'), 'Marc T' => $u('marc'),
        ], JSON_THROW_ON_ERROR);
        $result = self::json($this->request(
            'POST', "/api/v1/groups/{$group['id']}/import/splitwise",
            ['mapping' => $mapping], $tok, self::csvUpload(self::CSV),
        ));
        self::assertSame([], $result['errors'], json_encode($result));
        self::assertSame(4, $result['imported']['expenses']);
        self::assertSame(1, $result['imported']['settlements']);
        self::assertSame(1, $result['imported']['skipped']); // the personal coffee

        // ---- the acid test: balances equal the CSV nets ----
        // CAD nets: groceries + gas + rounding + payment
        //   dave: 5473+2000+667-2500 = 5640 ; alice: -2737+2000-333 = -1070
        //   marc: -2736-4000-333+2500 = -4569  (rounding row residual lands
        //   on dave: 667-333-333=+1 → dave 666 → dave 5639)
        // USD row at seeded rate 1.50: nets ×1.5 → dave +10000, alice -5000, marc -5000
        // (66.67/-33.33/-33.33 has residual +1¢ → largest |net| = dave → 66.66)
        $balances = self::json($this->request('GET', "/api/v1/groups/{$group['id']}/balances", null, $tok));
        $net = $balances['net'];
        self::assertSame(0, array_sum($net));

        $usd = ['dave' => 6666, 'alice' => -3333, 'marc' => -3333];
        $rate = 1.50;
        $expected = [
            'dave' => 5473 + 2000 + 666 - 2500,
            'alice' => -2737 + 2000 - 333,
            'marc' => -2736 - 4000 - 333 + 2500,
        ];
        // convert USD nets with the same zero-sum-preserving rule the API uses
        $conv = [];
        foreach ($usd as $n => $v) {
            $conv[$n] = (int) round($v * $rate);
        }
        $residual = -array_sum($conv);
        if ($residual !== 0) {
            $largest = array_keys($conv, max(array_map('abs', $conv)))[0] ?? 'dave';
            $conv['dave'] += $residual; // dave has the largest |effect|
        }
        foreach ($expected as $n => $v) {
            self::assertSame($v + $conv[$n], $net[$u($n)], "net for {$n}");
        }

        // Plan settles exactly; activity has ONE import entry, not dozens.
        $after = $net;
        foreach ($balances['plan'] as $t) {
            $after[$t['from']] += $t['amountMinor'];
            $after[$t['to']] -= $t['amountMinor'];
        }
        self::assertSame([0, 0, 0], array_values(array_map('intval', $after)));

        $activity = self::json($this->request('GET', "/api/v1/groups/{$group['id']}/activity", null, $tok));
        $verbs = array_count_values(array_column($activity['items'], 'verb'));
        self::assertSame(1, $verbs['imported'] ?? 0);
        self::assertArrayNotHasKey('added', $verbs);
    }

    /**
     * Regression: amounts were converted with a hardcoded x100, so every
     * row in a zero-decimal currency imported 100x too large (a 42,400
     * CLP cab ride became 4,240,000 CLP) — self-consistently, so balances
     * still summed to zero and nothing looked wrong until you read one.
     */
    public function testZeroDecimalCurrencyKeepsItsScale(): void
    {
        $users = [];
        foreach (['ana' => 'Ana P', 'bruno' => 'Bruno L', 'caro' => 'Caro M'] as $k => $display) {
            $r = self::json($this->request('POST', '/api/v1/auth/register', [
                'email' => "{$k}@example.com", 'password' => 'a-long-enough-password', 'displayName' => $display,
            ]));
            $users[$k] = ['id' => $r['user']['id'], 'token' => $r['token']];
        }
        $tok = $users['ana']['token'];
        $group = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Santiago', 'emoji' => '🇨🇱', 'homeCurrency' => 'CLP',
        ], $tok));
        $invite = self::json($this->request('POST', "/api/v1/groups/{$group['id']}/invites", [], $tok));
        foreach (['bruno', 'caro'] as $k) {
            $this->request('POST', "/api/v1/join/{$invite['token']}", [], $users[$k]['token']);
        }

        $mapping = json_encode([
            'Ana P' => $users['ana']['id'], 'Bruno L' => $users['bruno']['id'], 'Caro M' => $users['caro']['id'],
        ], JSON_THROW_ON_ERROR);
        $result = self::json($this->request(
            'POST', "/api/v1/groups/{$group['id']}/import/splitwise",
            ['mapping' => $mapping], $tok, self::csvUpload(self::CLP_CSV),
        ));
        self::assertSame([], $result['errors'], json_encode($result));
        self::assertSame(2, $result['imported']['expenses']);

        // Whole pesos, not pesos x100.
        $expenses = self::json($this->request('GET', "/api/v1/groups/{$group['id']}/expenses", null, $tok));
        $byDesc = array_column($expenses['items'], 'amountMinor', 'description');
        self::assertSame(42400, $byDesc['Airport Cabify']);
        self::assertSame(21670, $byDesc['Wine bar']);

        // Still balance-exact after the rounding residuals are absorbed.
        $net = self::json($this->request('GET', "/api/v1/groups/{$group['id']}/balances", null, $tok))['net'];
        self::assertSame(0, array_sum($net));
        self::assertSame(313, $net[$users['ana']['id']]);
        self::assertSame(-21356, $net[$users['bruno']['id']]);
        self::assertSame(21043, $net[$users['caro']['id']]);
    }

    /**
     * Regression: a file that isn't UTF-8 text made preg_replace('/u')
     * return null, which the BOM strip fed straight into preg_split() —
     * a TypeError, so the user got a 500 instead of being told what to
     * upload. Excel re-saving the export as Windows-1252 or .xlsx is the
     * way people actually hit this.
     */
    public function testNonCsvAndNonUtf8UploadsGetAClearError(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'enc@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Enc',
        ]));
        $tok = $r['token'];
        $group = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Encoding', 'emoji' => '📄', 'homeCurrency' => 'CAD',
        ], $tok));
        $path = "/api/v1/groups/{$group['id']}/import/splitwise";

        // A .xlsx workbook (zip magic) — not a 500.
        $xlsx = $this->request('POST', $path, ['dryRun' => '1'], $tok,
            self::csvUpload("PK\x03\x04" . str_repeat("\x00\x01", 32)));
        self::assertSame(422, $xlsx->getStatusCode());
        self::assertStringContainsString('spreadsheet', (string) $xlsx->getBody());

        // Windows-1252 (what Excel writes): accented names must survive.
        $latin1 = "Date,Description,Category,Cost,Currency,Jos\xe9 R,Ana P\n"
            . "2026-06-01,Caf\xe9,Dining out,10.00,CAD,5.00,-5.00\n";
        $ok = $this->request('POST', $path, ['dryRun' => '1'], $tok, self::csvUpload($latin1));
        self::assertSame(200, $ok->getStatusCode(), (string) $ok->getBody());
        self::assertSame(['José R', 'Ana P'], self::json($ok)['members']);
    }
}
