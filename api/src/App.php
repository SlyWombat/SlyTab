<?php

declare(strict_types=1);

namespace SlyTab;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App as SlimApp;
use Slim\Factory\AppFactory;
use SlyTab\Routes\Api;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Http;

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
                    error_log('slytab-api: ' . $e::class . ': ' . $e->getMessage());
                }
                return Http::json($app->getResponseFactory()->createResponse($status), [
                    'error' => ['code' => $code, 'message' => $message],
                ]);
            },
        );

        Api::register($app);
        return $app;
    }
}
