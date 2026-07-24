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
use SlyTab\Services\AuthService;
use SlyTab\Services\BalanceService;
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
        $pdo = Db::pdo();
        $auth = new AuthService($pdo);
        $activity = new ActivityService($pdo);
        $groups = new GroupService($pdo, $activity);
        $fx = new FxService($pdo);
        $expenses = new ExpenseService($pdo, $groups, $fx, $activity);
        $balances = new BalanceService($pdo);
        $settlements = new SettlementService($pdo, $groups, $activity);
        $receipts = new ReceiptService($pdo);
        $limiter = new RateLimiter($pdo);
        $resets = new PasswordResetService($pdo, new Mailer());
        $importer = new ImportService($pdo, $groups, $expenses, $activity);
        $swApi = new SplitwiseApiImportService($pdo, $groups, $expenses, $activity);
        $notify = new NotificationService($pdo);
        $verifier = new EmailVerificationService($pdo, new Mailer());
        $google = new GoogleAuthService($pdo, $auth);
        $apple = new AppleAuthService($pdo, $auth);
        $bugs = new \SlyTab\Services\BugReportService($pdo);

        $ip = static fn(Request $rq): string =>
            (string) ($rq->getServerParams()['REMOTE_ADDR'] ?? 'unknown');

        // ---- admin (cron + deploy hooks, guarded by MIGRATE_TOKEN) ----
        $app->group('/api/internal', function (RouteCollectorProxy $g) use ($pdo, $fx, $bugs): void {
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
                $resolution = (string) (($rq->getParsedBody() ?? [])['resolution'] ?? '');
                return Http::json($rs, $bugs->closeAndNotify($a['id'], $resolution));
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
            $auth, $activity, $groups, $fx, $expenses, $balances, $settlements, $receipts,
            $limiter, $resets, $ip, $importer, $verifier, $google, $apple, $swApi, $pdo, $notify, $bugs,
        ): void {
            $g->get('/health', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['status' => 'ok', 'service' => 'slytab-api', 'schemaVersion' => 1]));

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
            $g->get('/auth/google/config', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['enabled' => $google->enabled(), 'clientId' => $google->clientId()]));
            $g->post('/auth/google', function (Request $rq, Response $rs) use ($google, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                return Http::json($rs, $google->signIn(
                    Http::str($b, 'idToken'), Http::str($b, 'deviceLabel', ''),
                ));
            });
            $g->get('/auth/apple/config', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, ['enabled' => $apple->enabled(), 'clientId' => $apple->clientId()]));
            $g->post('/auth/apple', function (Request $rq, Response $rs) use ($apple, $limiter, $ip): Response {
                $limiter->guard('auth', $ip($rq), 10, 60);
                $b = Http::body($rq);
                return Http::json($rs, $apple->signIn(
                    Http::str($b, 'idToken'), Http::str($b, 'deviceLabel', ''), Http::str($b, 'displayName', ''),
                ));
            });

            // ---- authenticated ----
            $g->group('', function (RouteCollectorProxy $p) use (
                $auth, $activity, $groups, $fx, $expenses, $balances, $settlements, $receipts, $limiter, $importer, $verifier, $swApi, $pdo, $notify, $bugs,
            ): void {
                // Report a bug (profile page): comment + optional screenshot.
                $p->post('/bugs', function (Request $rq, Response $rs) use ($bugs, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    $limiter->guard('bugs', $userId, 10, 86400);
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

                // expenses
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

                // settlements
                $p->post('/groups/{id}/settlements', function (Request $rq, Response $rs, array $a) use ($groups, $settlements, $notify): Response {
                    $me = Http::user($rq);
                    $groups->assertMember($a['id'], $me['id']);
                    $st = $settlements->create($a['id'], $me['id'], Http::body($rq));
                    $notify->notifyGroup($a['id'], $me['id'], 'settlement_in',
                        "{$me['displayName']} sent you a payment",
                        'Confirm it in SlyTab when it arrives.', [$st['toUserId']]);
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
