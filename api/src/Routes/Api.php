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
use SlyTab\Services\AuthService;
use SlyTab\Services\BalanceService;
use SlyTab\Services\EmailVerificationService;
use SlyTab\Services\ExpenseService;
use SlyTab\Services\FxService;
use SlyTab\Services\GoogleAuthService;
use SlyTab\Services\GroupService;
use SlyTab\Services\ImportService;
use SlyTab\Services\Mailer;
use SlyTab\Services\PasswordResetService;
use SlyTab\Services\RateLimiter;
use SlyTab\Services\ReceiptService;
use SlyTab\Services\SettlementService;
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
        $verifier = new EmailVerificationService($pdo, new Mailer());
        $google = new GoogleAuthService($pdo, $auth);

        $ip = static fn(Request $rq): string =>
            (string) ($rq->getServerParams()['REMOTE_ADDR'] ?? 'unknown');

        // ---- admin (cron + deploy hooks, guarded by MIGRATE_TOKEN) ----
        $app->group('/api/internal', function (RouteCollectorProxy $g) use ($pdo, $fx): void {
            $g->post('/migrate', function (Request $rq, Response $rs) use ($pdo): Response {
                $ran = (new Migrator($pdo))->migrate();
                return Http::json($rs, ['applied' => $ran]);
            });
            $g->post('/fetch-rates', fn(Request $rq, Response $rs): Response =>
                Http::json($rs, $fx->refresh()));
        })->add(function (Request $rq, $handler) {
            $expected = Env::require('MIGRATE_TOKEN');
            if (!hash_equals($expected, $rq->getHeaderLine('X-Admin-Token'))) {
                throw new ApiException('FORBIDDEN', 'admin token required', 403);
            }
            return $handler->handle($rq);
        });

        $app->group('/api/v1', function (RouteCollectorProxy $g) use (
            $auth, $activity, $groups, $fx, $expenses, $balances, $settlements, $receipts,
            $limiter, $resets, $ip, $importer, $verifier, $google,
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

            // ---- authenticated ----
            $g->group('', function (RouteCollectorProxy $p) use (
                $auth, $activity, $groups, $fx, $expenses, $balances, $settlements, $receipts, $limiter, $importer, $verifier,
            ): void {
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
                $p->post('/me/verify-request', function (Request $rq, Response $rs) use ($verifier, $limiter): Response {
                    $limiter->guard('verify', Http::user($rq)['id'], 5, 3600);
                    $verifier->request(Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });
                $p->get('/me/sessions', fn(Request $rq, Response $rs): Response =>
                    Http::json($rs, ['items' => $auth->listSessions(Http::user($rq)['id'])]));
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
                    $converted = false;
                    $excluded = [];
                    foreach ($groups->listForUser($userId) as $group) {
                        $net = $balances->netFor($group['id'], $userId);
                        $items[] = [
                            'group' => $group,
                            'netMinor' => $net,
                            'currency' => $group['homeCurrency'],
                        ];
                        if ($group['homeCurrency'] === $home) {
                            $totalMinor += $net;
                        } elseif ($net !== 0) {
                            try {
                                $rate = $fx->rateFor(gmdate('Y-m-d'), $group['homeCurrency'], $home);
                                $totalMinor += (int) round($net * $rate);
                                $converted = true;
                            } catch (ApiException) {
                                $excluded[] = $group['homeCurrency']; // no rate — leave out rather than lie
                            }
                        }
                    }
                    return Http::json($rs, [
                        'items' => $items,
                        'pendingSettlements' => $settlements->pendingFor($userId),
                        'total' => [
                            'minor' => $totalMinor,
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
                    return Http::json($rs->withStatus(201), $groups->create(
                        Http::user($rq)['id'], Http::str($b, 'name'),
                        Http::str($b, 'emoji', ''), Http::str($b, 'homeCurrency', 'CAD'),
                    ));
                });
                $p->get('/groups/{id}', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, $groups->get($a['id']));
                });
                $p->post('/groups/{id}/invites', function (Request $rq, Response $rs, array $a) use ($groups): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    $body = $rq->getParsedBody();
                    $email = is_array($body) && is_string($body['email'] ?? null) && $body['email'] !== ''
                        ? $body['email'] : null;
                    $invite = $groups->createInvite($a['id'], Http::user($rq)['id'], $email);
                    return Http::json($rs->withStatus(201), $invite + ['path' => "/join/{$invite['token']}"]);
                });
                $p->post('/join/{token}', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, $groups->join($a['token'], Http::user($rq)['id'])));
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
                    return Http::json($rs, $expenses->listForGroup($a['id'], $q['cursor'] ?? null));
                });
                $p->post('/groups/{id}/expenses', function (Request $rq, Response $rs, array $a) use ($groups, $expenses): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    return Http::json($rs->withStatus(201), $expenses->create($a['id'], $userId, Http::body($rq)));
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

                // balances
                $p->get('/groups/{id}/balances', function (Request $rq, Response $rs, array $a) use ($groups, $balances): Response {
                    $groups->assertMember($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, $balances->forGroup($a['id']));
                });

                // settlements
                $p->post('/groups/{id}/settlements', function (Request $rq, Response $rs, array $a) use ($groups, $settlements): Response {
                    $userId = Http::user($rq)['id'];
                    $groups->assertMember($a['id'], $userId);
                    return Http::json($rs->withStatus(201), $settlements->create($a['id'], $userId, Http::body($rq)));
                });
                $p->post('/settlements/{id}/confirm', fn(Request $rq, Response $rs, array $a): Response =>
                    Http::json($rs, $settlements->confirm($a['id'], Http::user($rq)['id'])));
                $p->delete('/settlements/{id}', function (Request $rq, Response $rs, array $a) use ($settlements): Response {
                    $settlements->delete($a['id'], Http::user($rq)['id']);
                    return Http::json($rs, ['ok' => true]);
                });

                // receipts
                $p->post('/groups/{id}/receipts', function (Request $rq, Response $rs, array $a) use ($groups, $receipts, $limiter): Response {
                    $userId = Http::user($rq)['id'];
                    $limiter->guard('receipts', $userId, 20, 86400); // FR-4.5 cost guard
                    $groups->assertMember($a['id'], $userId);
                    $groups->assertWritable($a['id']);
                    $file = $rq->getUploadedFiles()['image'] ?? null;
                    if ($file === null) {
                        throw new ApiException('VALIDATION', "multipart field 'image' is required");
                    }
                    return Http::json($rs->withStatus(201), $receipts->ingest($a['id'], $userId, $file));
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
