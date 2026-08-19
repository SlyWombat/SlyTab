<?php

declare(strict_types=1);

namespace SlyTab\Routes;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App as SlimApp;
use Slim\Routing\RouteCollectorProxy;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;
use SlyTab\Middleware\RequireAuth;
use SlyTab\Services\ActivityService;
use SlyTab\Services\AppleAuthService;
use SlyTab\Services\AuthHandoffService;
use SlyTab\Services\AuthService;
use SlyTab\Services\BalanceService;
use SlyTab\Services\CategoryService;
use SlyTab\Services\EmailNotificationService;
use SlyTab\Services\EmailVerificationService;
use SlyTab\Services\ExpenseService;
use SlyTab\Services\FxService;
use SlyTab\Services\GoogleAuthService;
use SlyTab\Services\GroupService;
use SlyTab\Services\ImportService;
use SlyTab\Services\Mailer;
use SlyTab\Services\NotificationService;
use SlyTab\Services\PasswordResetService;
use SlyTab\Services\RateLimiter;
use SlyTab\Services\ReceiptService;
use SlyTab\Services\SettlementService;
use SlyTab\Services\SplitwiseApiImportService;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Http;

/** The full /api/v1 route map (architecture §5). */
final class Api
{
    public static function register(SlimApp $app): void
    {
        // Liveness is answered before the database is touched, and its answer
        // does not depend on it. Registering it after `Db::pdo()` made every
        // request — including this one, whose reply is a constant — hang
        // whenever MySQL was unreachable, so an outage in the database looked
        // exactly like a dead web host (incident 2026-07-28).
        $app->get('/api/v1/health', fn(Request $rq, Response $rs): Response =>
            Http::json($rs, ['status' => 'ok', 'service' => 'slytab-api', 'schemaVersion' => 1]));

        // ...and because liveness no longer proves the database is reachable,
        // something has to. This is the half that actually failed on
        // 2026-07-28: the API host was fine, its route to MySQL was not.
        // Monitor both — /health green + /health/deep red isolates the fault
        // to the tunnel without anyone reading a log.
        $app->get('/api/v1/health/deep', function (Request $rq, Response $rs): Response {
            $started = microtime(true);
            try {
                Db::pdo()->query('SELECT 1')->fetchColumn();
            } catch (\Throwable $e) {
                error_log('slytab-api: deep health check failed: ' . $e->getMessage());
                return Http::json($rs->withStatus(503), [
                    'status' => 'degraded',
                    'database' => 'unreachable',
                ]);
            }
            return Http::json($rs, [
                'status' => 'ok',
                'database' => 'ok',
                'queryMs' => (int) round((microtime(true) - $started) * 1000),
            ]);
        });

        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            // Say so in one place rather than failing route by route: every
            // other endpoint genuinely needs the database.
            error_log('slytab-api: database unreachable at boot: ' . $e->getMessage());
            $app->any('/api/{rest:.*}', function (): Response {
                throw new ApiException(
                    'DB_UNAVAILABLE',
                    'SlyTab is temporarily unavailable — please try again shortly',
                    503,
                );
            });
            return;
        }

        $auth = new AuthService($pdo);
        $activity = new ActivityService($pdo);
        $groups = new GroupService($pdo, $activity);
        $fx = new FxService($pdo);
        $expenses = new ExpenseService($pdo, $groups, $fx, $activity);
        $balances = new BalanceService($pdo);
        $categories = new CategoryService($pdo, $groups);
        $settlements = new SettlementService($pdo, $groups, $activity);
        $receipts = new ReceiptService($pdo);
        $avatars = new \SlyTab\Services\AvatarService($pdo);
        $limiter = new RateLimiter($pdo);
        $resets = new PasswordResetService($pdo, new Mailer());
        $importer = new ImportService($pdo, $groups, $expenses, $activity);
        $swApi = new SplitwiseApiImportService($pdo, $groups, $expenses, $activity);
        // One instance shared by the notify fan-out and the digest sweep.
        $emailNotify = new EmailNotificationService($pdo);
        $notify = new NotificationService($pdo, $emailNotify);
        $verifier = new EmailVerificationService($pdo, new Mailer());
        $google = new GoogleAuthService($pdo, $auth);
        $apple = new AppleAuthService($pdo, $auth);
        // Apple wants the account revoked when it is deleted (#81). Wired as a
        // callable because AppleAuthService already depends on AuthService.
        $auth->setAppleRevoke(static fn(string $uid): bool => $apple->revokeForUser($uid));
        $handoff = new AuthHandoffService($pdo, $auth, $google);
        $bugs = new \SlyTab\Services\BugReportService($pdo);

        $ip = static fn(Request $rq): string =>
            (string) ($rq->getServerParams()['REMOTE_ADDR'] ?? 'unknown');

        // ---- admin (cron + deploy hooks, guarded by MIGRATE_TOKEN) ----
        $app->group('/api/internal', function (RouteCollectorProxy $g) use ($pdo, $fx, $bugs, $emailNotify, $balances, $receipts): void {
            // Bug-report review (profile-page reports): comment + screenshot together.
            $g->get('/bugs', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['items' => $bugs->listRecent()]));
            $g->get('/bugs/{id}/image', function (Request $rq, Response $rs, array $a) use ($bugs): Response {
                $img = $bugs->imageFile($a['id']);
                $rs->getBody()->write(file_get_contents($img['path']));
                return $rs->withHeader('Content-Type', $img['mime']);
            });
            // Issue #25: link a report to its GitHub issue / close + email reporter.
            $g->patch('/bugs/{id}', function (Request $rq, Response $rs, array $a) use ($bugs): Response {
                $bugs->linkIssue($a['id'], (int) Http::str(Http::body($rq), 'issueNumber'));
                return Http::json($rs, ['ok' => true]);
            });
            $g->post('/bugs/{id}/notify-closed', function (Request $rq, Response $rs, array $a) use ($bugs): Response {
                $b = $rq->getParsedBody() ?? [];
                $resolution = (string) ($b['resolution'] ?? '');
                // Where the fix landed decides the "how to get it" line. Omit
                // to fall back to the report-platform guess (legacy).
                $needsAppUpdate = array_key_exists('needsAppUpdate', $b) ? (bool) $b['needsAppUpdate'] : null;
                return Http::json($rs, $bugs->closeAndNotify($a['id'], $resolution, $needsAppUpdate));
            });
            // Manual trigger for the feedback pipeline (cron runs it too).
            // It also sweeps queued notification emails: that keeps issue #77
            // working on the existing 10-minute cron instead of needing a new
            // crontab entry on the host, which is a step nobody would notice
            // was missing until a digest never arrived.
            $g->post('/bug-sync', function (Request $rq, Response $rs) use ($bugs, $emailNotify, $pdo, $balances, $receipts): Response {
                // Three independent jobs share this cron. They must not share
                // a fate: bolting the digest and the reminders onto the report
                // pipeline meant one throwing took the other two down with it,
                // and the endpoint answered "something went wrong" without
                // saying which. Each reports for itself now.
                $result = [];
                foreach ([
                    'reports' => fn(): array => $bugs->syncGithub(),
                    'digestsSent' => fn(): int => $emailNotify->flushDigests(),
                    'reminders' => fn(): array => (new \SlyTab\Services\ReminderService($pdo, $balances))->sweep(),
                    // #111: diagnostics should not become an archive.
                    'timingsPruned' => fn(): int => (new \SlyTab\Services\ClientTimingService($pdo))->prune(),
                    // Owner's rule (2026-08-02): once a group has settled, the
                    // compressed image is enough — drop the unresized original.
                    'originalsPruned' => fn(): array => $receipts->pruneSettledOriginals($balances),
                ] as $name => $job) {
                    try {
                        $result[$name] = $job();
                    } catch (\Throwable $e) {
                        error_log("bug-sync: {$name} failed: " . $e->getMessage());
                        $result[$name] = ['error' => $e->getMessage()];
                    }
                }
                return Http::json($rs, $result);
            });
            // Management metrics for the owner's Homepage dashboard. Behind the
            // admin token like everything else here — Homepage's customapi
            // widget can send the header.
            $g->get('/metrics', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, (new \SlyTab\Services\MetricsService($pdo))->snapshot()));
            // #19: payment reminders. Rides the same cron as everything else
            // here; the service does its own rate limiting, so running it every
            // ten minutes costs a query and sends nothing most of the time.
            $g->post('/reminders', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, (new \SlyTab\Services\ReminderService($pdo, $balances))->sweep()));
            // Same sweep on its own, for testing and for forcing a send.
            $g->post('/notify-digest', function (Request $rq, Response $rs) use ($emailNotify): Response {
                $grace = (int) (Http::body($rq)['graceMinutes'] ?? 10);
                return Http::json($rs, ['digestsSent' => $emailNotify->flushDigests($grace)]);
            });
            // Owner status mails and other one-off sends (admin-token only).
            $g->post('/send-mail', function (Request $rq, Response $rs): Response {
                $b = Http::body($rq);
                $accepted = (new Mailer())->dispatch(
                    Http::str($b, 'to'), Http::str($b, 'subject'), Http::str($b, 'body'),
                );
                return Http::json($rs, ['accepted' => $accepted]);
            });
            $g->post('/migrate', function (Request $rq, Response $rs) use ($pdo): Response {
                $ran = (new Migrator($pdo))->migrate();
                return Http::json($rs, ['applied' => $ran]);
            });
            $g->post('/fetch-rates', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, $fx->refresh()));
            // What the settled-originals sweep WOULD remove. Deleting a
            // person's uploads is not something to discover after the fact.
            $g->get('/receipts/prunable', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, $receipts->pruneSettledOriginals($balances, true)));
            // #111: p50/p95 per endpoint and per screen, as measured on real
            // devices. p95 rather than a mean — an average hides the tail, and
            // the tail is what people mean by "laggy".
            $g->get('/metrics/timing', function (Request $rq, Response $rs) use ($pdo): Response {
                $hours = (int) ($rq->getQueryParams()['hours'] ?? 24);
                return Http::json($rs, (new \SlyTab\Services\ClientTimingService($pdo))->summary($hours));
            });
            // Testing metrics (issue #10): recent receipt-pipeline rows.
            $g->get('/metrics/receipts', function (Request $rq, Response $rs) use ($pdo): Response {
                $stmt = $pdo->query(
                    'SELECT receipt_id, group_id, upload_bytes, normalized_bytes, normalize_ms,
                            engine, parse_ms, outcome, confidence, error, created_at
                     FROM receipt_metrics ORDER BY id DESC LIMIT 50',
                );
                return Http::json($rs, ['items' => $stmt->fetchAll()]);
            });
            // Deliverability probe (issue #8): did the MTA accept the message?
            $g->post('/mail-test', function (Request $rq, Response $rs): Response {
                $to = Http::str(Http::body($rq), 'to');
                $accepted = (new Mailer())->dispatch(
                    $to,
                    'SlyTab mail test',
                    "This is a deliverability test from SlyTab.\nIf you can read this, outbound mail works.",
                );
                return Http::json($rs, ['accepted' => $accepted]);
            });
        })->add(function (Request $rq, $handler) {
            $expected = Env::require('MIGRATE_TOKEN');
            if (!hash_equals($expected, $rq->getHeaderLine('X-Admin-Token'))) {
                throw new ApiException('FORBIDDEN', 'admin token required', 403);
            }
            return $handler->handle($rq);
        });

        $app->group('/api/v1', function (RouteCollectorProxy $g) use (
            $auth, $activity, $groups, $fx, $expenses, $balances, $categories, $settlements, $receipts,
            $emailNotify,
            $limiter, $resets, $ip, $importer, $verifier, $google, $apple, $handoff, $swApi, $pdo, $notify, $bugs,
            $avatars,
        ): void {
            // /health is registered above, outside this group, so that it
            // answers without a database connection.

            // Issue #77: every notification email carries this link. It is
            // signed rather than authenticated — someone invited by email has
            // no password, and making them sign in to stop unwanted mail is
            // how you get marked as spam.
            $g->get('/notify/unsubscribe', function (Request $rq, Response $rs) use ($emailNotify): Response {
                $q = $rq->getQueryParams();
                $ok = $emailNotify->unsubscribe((string) ($q['u'] ?? ''), (string) ($q['t'] ?? ''));
                $msg = $ok
                    ? 'You will no longer get activity emails from SlyTab. You can turn them back on any time in Profile.'
                    : 'That unsubscribe link is not valid. You can change email settings in SlyTab under Profile.';
                $rs->getBody()->write(
                    '<!doctype html><meta charset="utf-8">'
                    . '<meta name="viewport" content="width=device-width,initial-scale=1">'
                    . '<title>SlyTab email settings</title>'
                    . '<div style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem">'
                    . '<h1 style="font-size:1.3rem">SlyTab</h1><p>' . htmlspecialchars($msg, ENT_QUOTES) . '</p></div>',
                );
                return $rs->withHeader('Content-Type', 'text/html; charset=utf-8')
                    ->withStatus($ok ? 200 : 400);
            });

            // ---- auth (public, rate-limited per client IP) ----
            $g->post('/auth/register', function (Request $rq, Response $rs) use ($auth, $limiter, $ip, $verifier): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                $result = $auth->register(
                    Http::str($b, 'email'), Http::str($b, 'password'),
                    Http::str($b, 'displayName'), Http::str($b, 'deviceLabel', ''),
                );
                try {
                    $verifier->request($result['user']['id']); // issue #1: confirm the address
                } catch (\Throwable $e) {
                    error_log('verification email failed: ' . $e->getMessage());
                }
                return Http::json($rs->withStatus(201), $result);
            });
            $g->post('/auth/login', function (Request $rq, Response $rs) use ($auth, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                return Http::json($rs, $auth->login(
                    Http::str($b, 'email'), Http::str($b, 'password'), Http::str($b, 'deviceLabel', ''),
                ));
            });
            $g->post('/auth/reset-request', function (Request $rq, Response $rs) use ($resets, $limiter, $ip): Response {
                $limiter->guard('reset', $ip($rq), 5, 3600);
                $resets->request(Http::str(Http::body($rq), 'email'));
                return Http::json($rs, ['ok' => true]); // identical whether or not the account exists
            });
            $g->post('/auth/reset', function (Request $rq, Response $rs) use ($resets, $limiter, $ip): Response {
                $limiter->guard('reset', $ip($rq), 10, 3600);
                $b = Http::body($rq);
                $resets->reset(Http::str($b, 'token'), Http::str($b, 'password'));
                return Http::json($rs, ['ok' => true]);
            });
            $g->post('/auth/verify/{token}', function (Request $rq, Response $rs, array $a) use ($verifier): Response {
                $verifier->verify($a['token']);
                return Http::json($rs, ['ok' => true]);
            });
            // What the current released app is, so a running one can tell it
            // is behind (#118). Public: an app that cannot sign in still
            // deserves to be told it is out of date, and the answer is the
            // same for everyone.
            $g->get('/app/release', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, (new \SlyTab\Services\ReleaseService())->current())
                    ->withHeader('Cache-Control', 'public, max-age=3600'));
            $g->get('/auth/google/config', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['enabled' => $google->enabled(), 'clientId' => $google->clientId()]));
            $g->post('/auth/google', function (Request $rq, Response $rs) use ($google, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                return Http::json($rs, $google->signIn(
                    Http::str($b, 'idToken'), Http::str($b, 'deviceLabel', ''),
                ));
            });
            // ---- mobile sign-in handoff (issue #39): the app opens the system
            // browser to sign in with Google, then claims the session with the
            // verifier only it holds ----
            $g->post('/auth/handoff/start', function (Request $rq, Response $rs) use ($handoff, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                return Http::json($rs->withStatus(201), $handoff->start(
                    Http::str(Http::body($rq), 'deviceLabel', ''),
                ));
            });
            $g->post('/auth/handoff/{state}/google', function (Request $rq, Response $rs, array $a) use ($handoff, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                return Http::json($rs, $handoff->completeGoogle(
                    (string) $a['state'], Http::str(Http::body($rq), 'idToken'),
                ));
            });
            $g->post('/auth/handoff/claim', function (Request $rq, Response $rs) use ($handoff, $limiter, $ip): Response {
                // Generous cap: the app polls every few seconds while the
                // user finishes signing in over in the browser.
                $limiter->guard('handoffClaim', $ip($rq), 300, 600);
                $b = Http::body($rq);
                $result = $handoff->claim(Http::str($b, 'state'), Http::str($b, 'verifier'));
                return Http::json(isset($result['pending']) ? $rs->withStatus(202) : $rs, $result);
            });
            $g->get('/auth/apple/config', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['enabled' => $apple->enabled(), 'clientId' => $apple->clientId()]));
            $g->post('/auth/apple', function (Request $rq, Response $rs) use ($apple, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                return Http::json($rs, $apple->signIn(
                    Http::str($b, 'idToken'), Http::str($b, 'deviceLabel', ''), Http::str($b, 'displayName', ''),
                    // Only present on a native sign-in, and only ever once —
                    // it is what makes later revocation possible (#81).
                    Http::str($b, 'authorizationCode', ''),
                ));
            });

            // ---- authenticated ----
            $g->group('', function (RouteCollectorProxy $p) use (
                $auth, $activity, $groups, $fx, $expenses, $balances, $categories, $settlements, $receipts, $limiter, $importer, $verifier, $swApi, $pdo, $notify, $bugs,
                $avatars,
            ): void {
                // Report a bug (profile page): comment + optional screenshot.
                // #111: how long things actually take on the device. Two
                // testers reported lag on two platforms and we could not see
                // any of it, so the first diagnosis was made by reading code
                // and was wrong. Fire-and-forget by design: a phone must never
                // be shown an error because a measurement failed to send.
                // #112: a profile photo, so a badge is more than a first
                // initial when two people in a group share one.
                $p->post('/me/avatar', function (Request $rq, Response $rs) use ($avatars, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    $limiter->guard('avatar', $userId, 20, 86400);
                    $file = $rq->getUploadedFiles()['image'] ?? null;
                    if ($file === null) {
                        throw new ApiException('VALIDATION', 'no photo was attached');
                    }
                    return Http::json($rs, $avatars->set($userId, $file));
                });
                $p->delete('/me/avatar', function (Request $rq, Response $rs) use ($avatars): Response {
                    $avatars->clear(Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });
                // Guarded by who is asking, not by knowing the id: a photo is
                // more personal than a balance, and the people who may see it
                // are the ones who already share a group.
                $p->get('/users/{id}/avatar', function (Request $rq, Response $rs, array $a) use ($avatars): Response {
                    $img = $avatars->fileFor(Http::user($rq)['id'], $a['id']);
                    $rs->getBody()->write((string) file_get_contents($img['path']));
                    return $rs->withHeader('Content-Type', $img['mime'])
                        ->withHeader('Cache-Control', 'private, max-age=300');
                });
                $p->post('/timings', function (Request $rq, Response $rs) use ($pdo, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    // Generous — a busy session batches every 20s — but bounded.
                    $limiter->guard('timings', $userId, 300, 3600);
                    $body = $rq->getParsedBody() ?? [];
                    // Per-person timings, kept deliberately (owner, 2026-08-03):
                    // SlyTab is in family-and-friends beta, not public release,
                    // and knowing WHICH device is slow is most of the value
                    // while the testers are people who can be asked about it.
                    //
                    // BEFORE GOING LIVE this must change, because the published
                    // privacy policy says "No analytics, no telemetry" and
                    // promises we never run analytics on anyone's data. Either
                    // pass null here — nothing reads the column, summary()
                    // groups by endpoint name alone, so the percentiles do not
                    // care — or disclose it honestly on the policy page. It is
                    // also the same page the App Store listing points at.
                    $kept = (new \SlyTab\Services\ClientTimingService($pdo))->record(
                        $userId,
                        is_array($body['items'] ?? null) ? $body['items'] : [],
                        (string) ($body['platform'] ?? ''),
                        (string) ($body['appVersion'] ?? ''),
                    );
                    return Http::json($rs, ['kept' => $kept]);
                });
                $p->post('/bugs', function (Request $rq, Response $rs) use ($bugs, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    // 50/day matches the other upload caps — 10 proved too
                    // tight for an active testing day ("too many attempts").
                    $limiter->guard('bugs', $userId, 50, 86400);
                    $body = $rq->getParsedBody() ?? [];
                    return Http::json($rs->withStatus(201), $bugs->report(
                        $userId,
                        (string) ($body['message'] ?? ''),
                        (string) ($body['context'] ?? ''),
                        $rq->getUploadedFiles()['image'] ?? null,
                    ));
                });
                // account & sessions
                $p->post('/auth/logout', function (Request $rq, Response $rs) use ($auth): Response {
                    $auth->logout(Http::user($rq)['sessionId']);
                    return Http::json($rs, ['ok' => true]);
                });
                $p->get('/me', function (Request $rq, Response $rs): Response {
                    $user = Http::user($rq);
                    unset($user['sessionId']);
                    return Http::json($rs, $user);
                });
                $p->patch('/me', fn(Request $rq, Response $rs): Response =>
                    Http::json($rs, $auth->updateProfile(Http::user($rq)['id'], Http::body($rq))));
                $p->delete('/me', function (Request $rq, Response $rs) use ($auth): Response {
                    $auth->deleteAccount(Http::user($rq)['id'], Http::str(Http::body($rq), 'confirmEmail'));
                    return Http::json($rs, ['ok' => true]);
                });
                $p->post('/me/verify-request', function (Request $rq, Response $rs) use ($verifier, $limiter): Response {
                    $limiter->guard('verify', Http::user($rq)['id'], 5, 3600);
                    $verifier->request(Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });
                $p->post('/me/push-tokens', function (Request $rq, Response $rs) use ($notify): Response {
                    $notify->registerToken(Http::user($rq)['id'], Http::str(Http::body($rq), 'token'));
                    return Http::json($rs, ['ok' => true]);
                });
                $p->get('/me/sessions', function (Request $rq, Response $rs) use ($auth): Response {
                    $me = Http::user($rq);
                    $items = array_map(
                        static fn(array $s2): array => $s2 + ['current' => $s2['id'] === $me['sessionId']],
                        $auth->listSessions($me['id']),
                    );
                    return Http::json($rs, ['items' => $items]);
                });
                $p->delete('/me/sessions/{id}', function (Request $rq, Response $rs, array $a) use ($auth): Response {
                    $auth->revokeSession(Http::user($rq)['id'], $a['id']);
                    return Http::json($rs, ['ok' => true]);
                });

                // home: net per group + pending settlements + overall total
                // converted into the user's default currency (FR-6.4).
                $p->get('/me/balances', function (Request $rq, Response $rs) use ($groups, $balances, $settlements, $fx): Response {
                    $user = Http::user($rq);
                    $userId = $user['id'];
                    $home = $user['defaultCurrency'];
                    $items = [];
                    $totalMinor = 0;
                    $owedMinor = 0;   // sum of positive nets, in $home
                    $oweMinor = 0;    // sum of negative nets, in $home (positive number)
                    $converted = false;
                    $excluded = [];
                    foreach ($groups->listForUser($userId) as $group) {
                        $b = $balances->forGroup($group['id']);
                        $net = $b['net'][$userId] ?? 0;
                        // Per-person context for the home cards: who owes me /
                        // whom I owe inside this group, biggest first.
                        $myPairs = [];
                        foreach ($b['pairwise'] as $pw) {
                            if ($pw['to'] === $userId) {
                                $myPairs[] = ['userId' => $pw['from'], 'amountMinor' => $pw['amountMinor']];
                            } elseif ($pw['from'] === $userId) {
                                $myPairs[] = ['userId' => $pw['to'], 'amountMinor' => -$pw['amountMinor']];
                            }
                        }
                        usort($myPairs, static fn(array $x, array $y): int => abs($y['amountMinor']) <=> abs($x['amountMinor']));
                        $items[] = [
                            'group' => $group,
                            'netMinor' => $net,
                            'currency' => $group['homeCurrency'],
                            'myPairs' => $myPairs,
                        ];
                        $inHome = null;
                        if ($group['homeCurrency'] === $home) {
                            $inHome = $net;
                        } elseif ($net !== 0) {
                            try {
                                $rate = $fx->rateFor(gmdate('Y-m-d'), $group['homeCurrency'], $home);
                                $inHome = \SlyTab\Support\Money::convert($net, $rate, $group['homeCurrency'], $home);
                                $converted = true;
                            } catch (ApiException) {
                                $excluded[] = $group['homeCurrency']; // no rate — leave out rather than lie
                            }
                        } else {
                            $inHome = 0;
                        }
                        if ($inHome !== null) {
                            $totalMinor += $inHome;
                            if ($inHome > 0) {
                                $owedMinor += $inHome;
                            } else {
                                $oweMinor += -$inHome;
                            }
                        }
                    }
                    return Http::json($rs, [
                        'items' => $items,
                        'pendingSettlements' => $settlements->pendingFor($userId),
                        'total' => [
                            'minor' => $totalMinor,
                            'owedMinor' => $owedMinor,
                            'oweMinor' => $oweMinor,
                            'currency' => $home,
                            'approximate' => $converted,
                            'excluded' => array_values(array_unique($excluded)),
                        ],
                    ]);
                });

                // groups
                $p->get('/groups', fn(Request $rq, Response $rs): Response =>
                    Http::json($rs, ['items' => $groups->listForUser(Http::user($rq)['id'])]));
                $p->post('/groups', function (Request $rq, Response $rs) use ($groups): Response {
                    $b = Http::body($rq);
                    $currencies = is_array($b['currencies'] ?? null) ? $b['currencies'] : [];
                    return Http::json($rs->withStatus(201), $groups->create(
                        Http::user($rq)['id'], Http::str($b, 'name'),
                        Http::str($b, 'emoji', ''), Http::str($b, 'homeCurrency', 'CAD'),
                        $currencies,
                    ));
                });
                $p->patch('/groups/{id}', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, $groups->update($a['id'], Http::user($rq)['id'], Http::body($rq))));
                $p->get('/groups/{id}', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, $groups->get($a['id']));
                });
                // Issue #24: add a person you already share a group with.
                $p->post('/groups/{id}/members', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    $target = Http::str(Http::body($rq), 'userId');
                    return Http::json($rs->withStatus(201), $groups->addKnownMember($a['id'], $userId, $target));
                });
                $p->post('/groups/{id}/invites', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $body = $rq->getParsedBody();
                    $email = is_array($body) && is_string($body['email'] ?? null) && $body['email'] !== ''
                        ? $body['email'] : null;
                    $invite = $groups->createInvite($a['id'], Http::user($rq)['id'], $email);
                    return Http::json($rs->withStatus(201), $invite + ['path' => "/join/{$invite['token']}"]);
                });
                $p->post('/join/{token}', function (Request $rq, Response $rs, array $a) use ($groups, $notify): Response {
                    $me = Http::user($rq);
                    $g2 = $groups->join($a['token'], $me['id']);
                    $notify->notifyGroup($g2['id'], $me['id'], 'joined',
                        "{$me['displayName']} joined", $g2['name'] !== '' ? $g2['name'] : 'your shared expenses');
                    return Http::json($rs, $g2);
                });
                // Issue #12: 1:1 splitting without a formal group.
                $p->post('/friends', function (Request $rq, Response $rs) use ($groups): Response {
                    $me = Http::user($rq);
                    $b = Http::body($rq);
                    return Http::json($rs->withStatus(201), $groups->directGroup(
                        $me['id'], Http::str($b, 'email'),
                        strtoupper(Http::str($b, 'homeCurrency', $me['defaultCurrency'] ?? 'CAD')),
                    ));
                });
                $p->post('/groups/{id}/leave', function (Request $rq, Response $rs, array $a) use ($groups, $balances): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    if ($balances->netFor($a['id'], $userId) !== 0) {
                        throw new ApiException('BALANCE_NOT_ZERO', 'settle up before leaving this group', 409);
                    }
                    $groups->leave($a['id'], $userId);
                    return Http::json($rs, ['ok' => true]);
                });
                $p->post('/groups/{id}/archive', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $groups->archive($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });
                // #120: lock a trip for settlement. Not archive — archived is
                // read-only, and the whole point of a lock is that the paying
                // carries on after the spending stops.
                $p->post('/groups/{id}/lock', function (Request $rq, Response $rs, array $a) use ($groups, $notify): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $groups->lock($a['id'], $me['id']);
                    $g = $groups->get($a['id']);
                    $notify->notifyGroup($a['id'], $me['id'], 'group_locked',
                        "{$me['displayName']} locked " . ($g['name'] !== '' ? $g['name'] : 'your shared expenses'),
                        'No more expenses — time to settle up.');
                    return Http::json($rs, $g);
                });
                $p->post('/groups/{id}/unlock', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $groups->unlock($a['id'], $me['id']);
                    return Http::json($rs, $groups->get($a['id']));
                });
                // #120: "you still owe me". Deliberately not gated on the
                // lock — which screen offers the button is the clients'
                // business, and pinning that here would make a UI change an
                // API change. ReminderService owns the rules that matter:
                // the debt is real, the person is reachable, and it cools off.
                $p->post('/groups/{id}/remind', function (Request $rq, Response $rs, array $a) use ($groups, $balances, $pdo): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $target = Http::str(Http::body($rq), 'userId');
                    $groups->assertMemberParticipant($a['id'], $target);
                    $result = (new \SlyTab\Services\ReminderService($pdo, $balances))
                        ->nudge($a['id'], $me['id'], $target);
                    return Http::json($rs, $result);
                });
                // A group that never held money can be deleted outright.
                // Archiving is for groups with a history worth keeping;
                // making that the only exit meant a mistyped or accidental
                // group stayed in your list for ever. GroupService::delete
                // owns the rules, including who is allowed to.
                $p->delete('/groups/{id}', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->delete($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });

                // expenses
                // #101: every expense your money is in, across all groups.
                $p->get('/me/expenses', function (Request $rq, Response $rs) use ($expenses): Response {
                    $me = Http::user($rq);
                    $q = $rq->getQueryParams();
                    $scope = ($q['scope'] ?? '') === 'paid' ? 'paid' : 'involved';
                    $sort = in_array($q['sort'] ?? '', ['oldest', 'largest', 'smallest'], true)
                        ? $q['sort'] : 'newest';
                    $filters = array_intersect_key($q, array_flip(['q', 'category']));
                    // Capped: the page size is the client's business, but not
                    // its right to ask for the whole table in one request.
                    $limit = max(1, min(100, (int) ($q['limit'] ?? 30)));
                    $page = $expenses->listForUser(
                        $me['id'], $scope, $sort, $q['cursor'] ?? null, $limit, $filters,
                    );
                    // The total covers the whole filtered set, not just this
                    // page — a running total that changed as you scrolled
                    // would be worse than none.
                    $page['summary'] = $expenses->totalForUser(
                        $me['id'], $scope, $me['defaultCurrency'], $filters,
                    );
                    $page['scope'] = $scope;
                    $page['sort'] = $sort;
                    return Http::json($rs, $page);
                });
                $p->get('/groups/{id}/expenses', function (Request $rq, Response $rs, array $a) use ($groups, $expenses): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $q = $rq->getQueryParams();
                    $filters = array_intersect_key($q, array_flip(['q', 'category', 'member', 'from', 'to']));
                    return Http::json($rs, $expenses->listForGroup($a['id'], $q['cursor'] ?? null, 30, $filters));
                });
                $p->post('/groups/{id}/expenses', function (Request $rq, Response $rs, array $a) use ($groups, $expenses, $notify): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $e = $expenses->create($a['id'], $me['id'], Http::body($rq));
                    $scale = \SlyTab\Support\Money::scale($e['currency']);
                    $amountText = number_format($e['amountMinor'] / $scale, $scale === 1 ? 0 : 2) . ' ' . $e['currency'];
                    $notify->notifyGroup($a['id'], $me['id'], 'expense_added',
                        "{$me['displayName']} added an expense", "{$e['description']} — {$amountText}");
                    return Http::json($rs->withStatus(201), $e);
                });
                $p->get('/expenses/{id}', function (Request $rq, Response $rs, array $a) use ($groups, $expenses): Response {
                    $e = $expenses->get($a['id']);
                    $groups->assertMember($e['groupId'], Http::user($rq)['id']);
                    return Http::json($rs, $e);
                });
                $p->patch('/expenses/{id}', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, $expenses->update($a['id'], Http::user($rq)['id'], Http::body($rq))));
                $p->delete('/expenses/{id}', function (Request $rq, Response $rs, array $a) use ($expenses): Response {
                    $expenses->softDelete($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });
                $p->post('/expenses/{id}/restore', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, $expenses->restore($a['id'], Http::user($rq)['id'])));
                $p->get('/expenses/{id}/comments', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, ['items' => $expenses->comments($a['id'], Http::user($rq)['id'])]));
                $p->post('/expenses/{id}/comments', function (Request $rq, Response $rs, array $a) use ($expenses, $notify): Response {
                    $me = Http::user($rq);
                    $comment = $expenses->addComment($a['id'], $me['id'], Http::str(Http::body($rq), 'body'));
                    $e = $expenses->get($a['id']);
                    $notify->notifyGroup($e['groupId'], $me['id'], 'comment',
                        "{$me['displayName']} commented", "{$e['description']}: {$comment['body']}");
                    return Http::json($rs->withStatus(201), $comment);
                });

                // balances
                $p->get('/groups/{id}/balances', function (Request $rq, Response $rs, array $a) use ($groups, $balances): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, $balances->forGroup($a['id']));
                });
                $p->get('/groups/{id}/totals', function (Request $rq, Response $rs, array $a) use ($groups, $balances): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, $balances->totalsFor($a['id']));
                });

                // categories: the group's overrides onto the shipped taxonomy (#18)
                $p->get('/groups/{id}/categories', function (Request $rq, Response $rs, array $a) use ($groups, $categories): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['overrides' => (object) $categories->overridesFor($a['id'])]);
                });
                $p->put('/groups/{id}/categories', function (Request $rq, Response $rs, array $a) use ($groups, $categories): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $body = Http::body($rq);
                    $overrides = $body['overrides'] ?? [];
                    if (!is_array($overrides)) {
                        throw new \SlyTab\Support\ApiException('VALIDATION', 'overrides must be an object', 422);
                    }
                    return Http::json($rs, ['overrides' => (object) $categories->replace($a['id'], $overrides)]);
                });

                // settlements
                $p->post('/groups/{id}/settlements', function (Request $rq, Response $rs, array $a) use ($groups, $settlements, $notify): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $st = $settlements->create($a['id'], $me['id'], Http::body($rq));
                    if ($st['recordedBy'] === $st['toUserId']) {
                        // #120: the payee wrote it down, so it is already on
                        // the books. The payer is told rather than asked —
                        // and told the amount, because this is the one
                        // direction where the other person never typed it.
                        $scale = \SlyTab\Support\Money::scale($st['currency']);
                        $amountText = number_format($st['amountMinor'] / $scale, $scale === 1 ? 0 : 2)
                            . ' ' . $st['currency'];
                        $notify->notifyGroup($a['id'], $me['id'], 'settlement_recorded',
                            "{$me['displayName']} recorded your payment",
                            "{$amountText} — your balance is up to date.", [$st['fromUserId']]);
                    } else {
                        $notify->notifyGroup($a['id'], $me['id'], 'settlement_in',
                            "{$me['displayName']} sent you a payment",
                            'Confirm it in SlyTab when it arrives.', [$st['toUserId']]);
                    }
                    return Http::json($rs->withStatus(201), $st);
                });
                $p->post('/settlements/{id}/confirm', function (Request $rq, Response $rs, array $a) use ($settlements, $notify): Response {
                    $me = Http::user($rq);
                    $st = $settlements->confirm($a['id'], $me['id']);
                    $notify->notifyGroup($st['groupId'], $me['id'], 'settlement_confirmed',
                        'Payment confirmed ✓', "{$me['displayName']} received your payment.", [$st['fromUserId']]);
                    return Http::json($rs, $st);
                });
                $p->delete('/settlements/{id}', function (Request $rq, Response $rs, array $a) use ($settlements): Response {
                    $settlements->delete($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });

                // receipts
                $p->get('/receipts/eta', function (Request $rq, Response $rs) use ($pdo): Response {
                    // Historical timing (issue #9): estimate from the last
                    // 20 successful parses instead of a static guess.
                    $stmt = $pdo->query(
                        "SELECT parse_ms FROM receipt_metrics WHERE outcome = 'parsed'
                         ORDER BY id DESC LIMIT 20",
                    );
                    $ms = array_map('intval', $stmt->fetchAll(\PDO::FETCH_COLUMN));
                    sort($ms);
                    $n = count($ms);
                    return Http::json($rs, [
                        'samples' => $n,
                        'typicalMs' => $n > 0 ? $ms[intdiv($n, 2)] : 15000,
                        'slowMs' => $n > 0 ? $ms[min($n - 1, (int) floor($n * 0.9))] : 40000,
                    ]);
                });
                $p->post('/groups/{id}/receipts', function (Request $rq, Response $rs, array $a) use ($groups, $receipts, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    $limiter->guard('receipts', $userId, 20, 86400); // FR-4.5 cost guard
                    $groups->assertMember($a['id'], $userId);
                    $groups->assertWritable($a['id']);
                    $file = $rq->getUploadedFiles()['image'] ?? null;
                    if ($file === null) {
                        throw new ApiException('VALIDATION', "multipart field 'image' is required");
                    }
                    $hint = strtoupper((string) (($rq->getParsedBody() ?? [])['currencyHint'] ?? ''));
                    return Http::json($rs->withStatus(201), $receipts->ingest($a['id'], $userId, $file, $hint));
                });
                $p->post('/receipts/{id}/rescan', function (Request $rq, Response $rs, array $a) use ($groups, $receipts, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    $img = $receipts->imageFile($a['id']);
                    $groups->assertMember($img['groupId'], $userId);
                    $limiter->guard('receipts', $userId, 20, 86400); // same FR-4.5 cost guard as ingest
                    $hint = strtoupper((string) (($rq->getParsedBody() ?? [])['currencyHint'] ?? ''));
                    return Http::json($rs, $receipts->rescan($a['id'], $hint));
                });
                $p->get('/receipts/{id}/image', function (Request $rq, Response $rs, array $a) use ($groups, $receipts): Response {
                    $img = $receipts->imageFile($a['id']);
                    $groups->assertMember($img['groupId'], Http::user($rq)['id']);
                    $rs->getBody()->write(file_get_contents($img['path']));
                    return $rs->withHeader('Content-Type', $img['mime'])
                        ->withHeader('Cache-Control', 'private, max-age=86400');
                });

                // Splitwise import: dryRun=1 inspects (member names, counts);
                // with a mapping it imports every row balance-exactly.
                $p->post('/groups/{id}/import/splitwise', function (Request $rq, Response $rs, array $a) use ($groups, $importer): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    $file = $rq->getUploadedFiles()['csv'] ?? null;
                    if ($file === null || $file->getError() !== UPLOAD_ERR_OK) {
                        throw new ApiException('VALIDATION', "multipart field 'csv' is required");
                    }
                    if (($file->getSize() ?? 0) > 5 * 1024 * 1024) {
                        throw new ApiException('VALIDATION', 'CSV must be 5 MB or smaller', 413);
                    }
                    $csv = (string) $file->getStream();
                    $body = $rq->getParsedBody();
                    if (($body['dryRun'] ?? '') === '1') {
                        return Http::json($rs, $importer->inspect($csv));
                    }
                    $mapping = json_decode((string) ($body['mapping'] ?? '{}'), true);
                    if (!is_array($mapping)) {
                        throw new ApiException('VALIDATION', "field 'mapping' must be a JSON object");
                    }
                    return Http::json($rs, $importer->import($a['id'], $userId, $csv, $mapping));
                });

                // Splitwise direct import (personal API key; never stored)
                $p->post('/groups/{id}/import/splitwise-api', function (Request $rq, Response $rs, array $a) use ($groups, $swApi): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    $b = Http::body($rq);
                    $apiKey = Http::str($b, 'apiKey');
                    if (!isset($b['swGroupId'])) {
                        return Http::json($rs, ['groups' => $swApi->listGroups($apiKey)]);
                    }
                    $mapping = $b['mapping'] ?? [];
                    if (!is_array($mapping)) {
                        throw new ApiException('VALIDATION', "field 'mapping' must be an object");
                    }
                    return Http::json($rs, $swApi->import(
                        $a['id'], $userId, $apiKey, (int) $b['swGroupId'], $mapping,
                    ));
                });

                // activity + export + rates
                $p->get('/groups/{id}/activity', function (Request $rq, Response $rs, array $a) use ($groups, $activity): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $q = $rq->getQueryParams();
                    return Http::json($rs, $activity->forGroup($a['id'], $q['cursor'] ?? null));
                });
                $p->get('/groups/{id}/export.csv', function (Request $rq, Response $rs, array $a) use ($groups, $expenses): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $csv = self::exportCsv($groups->get($a['id']), $expenses);
                    $rs->getBody()->write($csv);
                    return $rs->withHeader('Content-Type', 'text/csv; charset=utf-8')
                        ->withHeader('Content-Disposition', 'attachment; filename="slytab-export.csv"');
                });
                $p->get('/rates', function (Request $rq, Response $rs) use ($fx): Response {
                    $q = $rq->getQueryParams();
                    $date = $q['date'] ?? gmdate('Y-m-d');
                    $base = strtoupper($q['base'] ?? '');
                    $quote = strtoupper($q['quote'] ?? '');
                    if (!preg_match('/^[A-Z]{3}$/', $base) || !preg_match('/^[A-Z]{3}$/', $quote)) {
                        throw new ApiException('VALIDATION', 'base and quote must be 3-letter currency codes');
                    }
                    return Http::json($rs, [
                        'date' => $date, 'base' => $base, 'quote' => $quote,
                        'rate' => $fx->rateFor($date, $base, $quote),
                    ]);
                });
            })->add(new RequireAuth($auth));
        });
    }

    /** @param array<string,mixed> $group */
    private static function exportCsv(array $group, ExpenseService $expenses): string
    {
        $names = array_column($group['members'], 'displayName', 'id');
        $lines = [self::csvRow(['id', 'date', 'description', 'category', 'currency', 'amount', 'fx_rate', 'payers', 'shares'])];

        $cursor = null;
        do {
            $page = $expenses->listForGroup($group['id'], $cursor, 200);
            foreach ($page['items'] as $e) {
                $fmt = static fn(array $rows): string => implode('; ', array_map(
                    static fn(array $r): string => ($names[$r['userId']] ?? $r['userId']) . ': ' . number_format($r['amountMinor'] / 100, 2, '.', ''),
                    $rows,
                ));
                $lines[] = self::csvRow([
                    $e['id'], $e['expenseDate'], $e['description'], $e['category'], $e['currency'],
                    number_format($e['amountMinor'] / 100, 2, '.', ''),
                    $e['fxRate'] === null ? '' : (string) $e['fxRate'],
                    $fmt($e['payers']), $fmt($e['shares']),
                ]);
            }
            $cursor = $page['nextCursor'];
        } while ($cursor !== null);

        return implode("\r\n", $lines) . "\r\n";
    }

    /** @param list<string> $fields */
    private static function csvRow(array $fields): string
    {
        return implode(',', array_map(
            static fn(string $f): string => '"' . str_replace('"', '""', $f) . '"',
            $fields,
        ));
    }
}
