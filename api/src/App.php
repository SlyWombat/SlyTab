<?php

declare(strict_types=1);

namespace SlySplit;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App as SlimApp;
use Slim\Factory\AppFactory;
use Slim\Routing\RouteCollectorProxy;
use SlySplit\Db\Db;
use SlySplit\Middleware\RequireAuth;
use SlySplit\Services\AuthService;
use SlySplit\Support\ApiException;
use SlySplit\Support\Env;

/**
 * Application factory — used by public/index.php and by integration tests
 * (which dispatch PSR-7 requests straight into the returned app).
 */
final class App
{
    public static function create(): SlimApp
    {
        Env::bootstrap();

        $app = AppFactory::create();
        $basePath = Env::get('API_BASE_PATH');
        if ($basePath !== '') {
            $app->setBasePath($basePath);
        }

        $app->addBodyParsingMiddleware();
        $app->addRoutingMiddleware();

        // Every failure leaves as the { error: { code, message } } envelope.
        $errorMiddleware = $app->addErrorMiddleware(false, true, true);
        $errorMiddleware->setDefaultErrorHandler(
            function (Request $request, \Throwable $e) use ($app): Response {
                [$status, $code, $message] = match (true) {
                    $e instanceof ApiException =>
                        [$e->status, $e->errorCode, $e->getMessage()],
                    $e instanceof \Slim\Exception\HttpNotFoundException =>
                        [404, 'NOT_FOUND', 'no such endpoint'],
                    $e instanceof \Slim\Exception\HttpMethodNotAllowedException =>
                        [405, 'METHOD_NOT_ALLOWED', 'method not allowed'],
                    default =>
                        [500, 'INTERNAL', 'something went wrong on our side'],
                };
                if ($status === 500) {
                    error_log('slysplit-api: ' . $e::class . ': ' . $e->getMessage());
                }
                return self::json($app->getResponseFactory()->createResponse($status), [
                    'error' => ['code' => $code, 'message' => $message],
                ]);
            },
        );

        $auth = new AuthService(Db::pdo());
        self::routes($app, $auth);
        return $app;
    }

    private static function routes(SlimApp $app, AuthService $auth): void
    {
        $app->group('/api/v1', function (RouteCollectorProxy $g) use ($auth): void {
            $g->get('/health', function (Request $request, Response $response): Response {
                return self::json($response, [
                    'status' => 'ok',
                    'service' => 'slysplit-api',
                    'schemaVersion' => 1,
                ]);
            });

            $g->post('/auth/register', function (Request $request, Response $response) use ($auth): Response {
                $b = self::body($request);
                $result = $auth->register(
                    self::str($b, 'email'),
                    self::str($b, 'password'),
                    self::str($b, 'displayName'),
                    self::str($b, 'deviceLabel', ''),
                );
                return self::json($response->withStatus(201), $result);
            });

            $g->post('/auth/login', function (Request $request, Response $response) use ($auth): Response {
                $b = self::body($request);
                $result = $auth->login(
                    self::str($b, 'email'),
                    self::str($b, 'password'),
                    self::str($b, 'deviceLabel', ''),
                );
                return self::json($response, $result);
            });

            $g->group('', function (RouteCollectorProxy $p) use ($auth): void {
                $p->post('/auth/logout', function (Request $request, Response $response) use ($auth): Response {
                    $auth->logout($request->getAttribute('user')['sessionId']);
                    return self::json($response, ['ok' => true]);
                });

                $p->get('/me', function (Request $request, Response $response): Response {
                    $user = $request->getAttribute('user');
                    unset($user['sessionId']);
                    return self::json($response, $user);
                });

                $p->get('/me/sessions', function (Request $request, Response $response) use ($auth): Response {
                    $items = $auth->listSessions($request->getAttribute('user')['id']);
                    return self::json($response, ['items' => $items]);
                });

                $p->delete('/me/sessions/{id}', function (Request $request, Response $response, array $args) use ($auth): Response {
                    $auth->revokeSession($request->getAttribute('user')['id'], $args['id']);
                    return self::json($response, ['ok' => true]);
                });
            })->add(new RequireAuth($auth));
        });
    }

    /** @param array<string,mixed> $payload */
    private static function json(Response $response, array $payload): Response
    {
        $response->getBody()->write(json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        return $response->withHeader('Content-Type', 'application/json');
    }

    /** @return array<string,mixed> */
    private static function body(Request $request): array
    {
        $parsed = $request->getParsedBody();
        if (!is_array($parsed)) {
            throw new ApiException('VALIDATION', 'request body must be a JSON object');
        }
        return $parsed;
    }

    /** @param array<string,mixed> $body */
    private static function str(array $body, string $key, ?string $default = null): string
    {
        $value = $body[$key] ?? $default;
        if (!is_string($value)) {
            throw new ApiException('VALIDATION', "field '{$key}' is required");
        }
        return $value;
    }
}
