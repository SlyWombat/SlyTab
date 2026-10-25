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
use SlyTab\Services\BugReportService;

/** FR-10.1: report a bug from the profile page, review via internal API; #133: forward to support. */
final class BugReportTest extends TestCase
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

    /** Register a user and return their id. */
    private function userId(string $email, string $name): string
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => $email, 'password' => 'a-long-enough-password', 'displayName' => $name,
        ]));
        return self::json($this->request('GET', '/api/v1/me', null, $r['token']))['id'];
    }

    public function testReportListAndGuards(): void
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => 'bugsy@example.com', 'password' => 'a-long-enough-password', 'displayName' => 'Bugsy',
        ]));
        $token = $r['token'];

        // Anonymous reports are rejected.
        $res = $this->request('POST', '/api/v1/bugs', ['message' => 'anon']);
        self::assertSame(401, $res->getStatusCode());

        // Empty message is rejected.
        $res = $this->request('POST', '/api/v1/bugs', ['message' => '   '], $token);
        self::assertSame(400, $res->getStatusCode());

        // A text-only report lands (screenshot is optional).
        $res = $this->request('POST', '/api/v1/bugs', [
            'message' => 'The Boragó receipt came out 100x too big',
            'context' => 'web test-agent',
        ], $token);
        self::assertSame(201, $res->getStatusCode(), (string) $res->getBody());
        $created = self::json($res);
        $reportId = $created['id'];
        // The apps show `tracking`; it is the ST- reference now.
        self::assertMatchesRegularExpression('/^ST-\d{6}-[ACDEFGHJKLMNPQRTUVWXY34679]{4}$/', $created['tracking']);

        // The internal review listing requires the admin token…
        $res = $this->request('GET', '/api/internal/bugs');
        self::assertSame(403, $res->getStatusCode());

        // …and with it shows the comment with the reporter attached.
        $res = $this->request('GET', '/api/internal/bugs', null, null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $items = self::json($res)['items'];
        self::assertCount(1, $items);
        self::assertSame($reportId, $items[0]['id']);
        self::assertSame($created['tracking'], $items[0]['reference']);
        self::assertSame('The Boragó receipt came out 100x too big', $items[0]['message']);
        self::assertSame('bugsy@example.com', $items[0]['from']['email']);
        self::assertSame('web test-agent', $items[0]['context']);
        self::assertFalse($items[0]['hasImage']);
        // Forwarded on the spot (mail is disabled in tests, which counts as accepted).
        self::assertSame('seen', $items[0]['status']);
        self::assertNotNull($items[0]['forwardedAt']);

        // No screenshot on this report → 404 from the image endpoint.
        $res = $this->request('GET', "/api/internal/bugs/{$reportId}/image", null, null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertSame(404, $res->getStatusCode());

        // The old close-and-email endpoint is gone: the support system replies now.
        $res = $this->request('POST', "/api/internal/bugs/{$reportId}/notify-closed", ['resolution' => 'x'], null, [
            'X-Admin-Token' => getenv('MIGRATE_TOKEN'),
        ]);
        self::assertContains($res->getStatusCode(), [404, 405]);
    }

    /**
     * #133: the support intake gets one email in the shared convention, with
     * Reply-To the reporter and the screenshot attached; the reporter gets
     * the receipt.
     */
    public function testReportIsForwardedToSupportIntakeInTheConvention(): void
    {
        $userId = $this->userId('phone@example.com', 'Phoney');

        $dir = sys_get_temp_dir() . '/slytab-bug-test-' . bin2hex(random_bytes(4));
        mkdir($dir);
        $shot = tempnam($dir, 'shot');
        file_put_contents($shot, 'not-really-a-png');
        $upload = new \Slim\Psr7\UploadedFile($shot, 'screen.png', 'image/png', filesize($shot));

        $mailer = new CapturingBugMailer();
        $svc = new BugReportService(Db::pdo(), $mailer);
        putenv("DATA_DIR={$dir}");
        try {
            $out = $svc->report($userId, "Save does nothing\nafter I pick a category",
                'mobile ios 18.2 app v1.2.1(18) | recent API errors: 500 /groups/x', $upload);
        } finally {
            putenv('DATA_DIR');
        }
        $ref = $out['reference'];
        self::assertSame($ref, $out['tracking']);
        self::assertSame('seen', $out['status']);

        self::assertCount(2, $mailer->sent);
        [$support, $receipt] = $mailer->sent;

        self::assertSame('support@electricrv.ca', $support['to']);
        self::assertSame("SlyTab support {$ref} [iOS] [problem]", $support['subject']);
        self::assertSame('phone@example.com', $support['replyTo']);
        self::assertStringStartsWith(
            "Reference: {$ref}\nApp: SlyTab 1.2.1 (18)\nPlatform: iOS — iOS 18.2\nKind: problem\n\n",
            $support['body'],
        );
        self::assertStringContainsString("Save does nothing\nafter I pick a category", $support['body']);
        self::assertStringContainsString('Diagnostics: recent API errors: 500 /groups/x', $support['body']);
        self::assertCount(1, $support['attachments']);
        self::assertSame("{$ref}-screenshot.png", $support['attachments'][0]['name']);
        self::assertSame('image/png', $support['attachments'][0]['mime']);
        self::assertFileExists($support['attachments'][0]['path']);

        self::assertSame('phone@example.com', $receipt['to']);
        self::assertStringContainsString($ref, $receipt['subject']);
        self::assertStringContainsString('Electric RV Support will reply', $receipt['body']);
        self::assertNull($receipt['replyTo']);
    }

    public function testWebAndUnknownContextsStillFollowTheConvention(): void
    {
        $base = ['reference' => 'ST-261025-AC34', 'message' => 'x', 'created_at' => '2026-10-25 12:00:00'];

        $web = BugReportService::supportMail($base + ['context' => 'web Mozilla/5.0 Firefox']);
        self::assertSame('SlyTab support ST-261025-AC34 [web] [problem]', $web['subject']);
        self::assertStringContainsString("App: SlyTab web\nPlatform: web\n", $web['body']);
        self::assertStringContainsString('Diagnostics: Mozilla/5.0 Firefox', $web['body']);

        $android = BugReportService::supportMail($base + ['context' => 'mobile android 35 app v1.2.1(21)']);
        self::assertSame('SlyTab support ST-261025-AC34 [Android] [problem]', $android['subject']);
        self::assertStringContainsString("App: SlyTab 1.2.1 (21)\nPlatform: Android — Android API 35\n", $android['body']);
        self::assertStringNotContainsString('Diagnostics:', $android['body']);

        // No context at all: no platform tag, and the header says so.
        $none = BugReportService::supportMail($base + ['context' => null]);
        self::assertSame('SlyTab support ST-261025-AC34 [problem]', $none['subject']);
        self::assertStringContainsString("App: SlyTab (version not given)\nPlatform: (not given)\n", $none['body']);
    }

    /** A refused hand-off is not lost: the cron retries it, later, and only once. */
    public function testRefusedForwardIsRetriedByTheCron(): void
    {
        $userId = $this->userId('retry@example.com', 'Retry');
        $pdo = Db::pdo();

        $out = (new BugReportService($pdo, new CapturingBugMailer(accept: false)))
            ->report($userId, 'It broke', 'web x', null);
        self::assertSame('new', $out['status']);

        $up = new CapturingBugMailer();
        $svc = new BugReportService($pdo, $up);
        // Too fresh: the request that made it might still be forwarding it.
        self::assertSame(0, $svc->forwardPending()['forwarded']);

        $pdo->prepare('UPDATE bug_reports SET created_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?')
            ->execute([$out['id']]);
        self::assertSame(1, $svc->forwardPending()['forwarded']);
        self::assertStringContainsString($out['reference'], $up->sent[0]['subject']);

        // Never twice.
        self::assertSame(0, $svc->forwardPending()['forwarded']);
        self::assertCount(1, $up->sent);
    }
}

final class CapturingBugMailer extends \SlyTab\Services\Mailer
{
    /** @var list<array{to:string, subject:string, body:string, replyTo:?string, attachments:array}> */
    public array $sent = [];

    public function __construct(private readonly bool $accept = true) {}

    public function dispatchMessage(string $to, string $subject, string $body, ?string $replyTo = null, array $attachments = []): bool
    {
        if (!$this->accept) {
            return false;
        }
        // Swallow the send — tests assert on what would have gone out.
        $this->sent[] = compact('to', 'subject', 'body', 'replyTo', 'attachments');
        return true;
    }
}
