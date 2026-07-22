<?php

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require dirname(__DIR__) . '/vendor/autoload.php';

$app = AppFactory::create();

// In production the front controller is served from public_html/slysplit/api;
// locally `php -S 127.0.0.1:8100 -t api/public` serves from the root.
$basePath = getenv('API_BASE_PATH') ?: '';
if ($basePath !== '') {
    $app->setBasePath($basePath);
}

$app->addRoutingMiddleware();
$app->addErrorMiddleware(false, true, true);

$app->get('/api/v1/health', function (Request $request, Response $response): Response {
    $response->getBody()->write(json_encode([
        'status' => 'ok',
        'service' => 'slysplit-api',
        'schemaVersion' => 1,
    ], JSON_THROW_ON_ERROR));
    return $response->withHeader('Content-Type', 'application/json');
});

$app->run();
