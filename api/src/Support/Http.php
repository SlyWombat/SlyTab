<?php

declare(strict_types=1);

namespace SlyTab\Support;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Small request/response helpers shared by all routes. */
final class Http
{
    /** @param array<string,mixed> $payload */
    public static function json(Response $response, array $payload): Response
    {
        $response->getBody()->write(json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        return $response->withHeader('Content-Type', 'application/json');
    }

    /** @return array<string,mixed> */
    public static function body(Request $request): array
    {
        $parsed = $request->getParsedBody();
        if (!is_array($parsed)) {
            throw new ApiException('VALIDATION', 'request body must be a JSON object');
        }
        return $parsed;
    }

    /** @param array<string,mixed> $body */
    public static function str(array $body, string $key, ?string $default = null): string
    {
        $value = $body[$key] ?? $default;
        if (!is_string($value)) {
            throw new ApiException('VALIDATION', "field '{$key}' is required");
        }
        return $value;
    }

    /** @return array<string,mixed> the authenticated user attribute */
    public static function user(Request $request): array
    {
        return $request->getAttribute('user');
    }
}
