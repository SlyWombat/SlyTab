<?php

declare(strict_types=1);

namespace SlyTab\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use SlyTab\Services\AuthService;
use SlyTab\Support\ApiException;

/**
 * Bearer-token authentication. On success the request carries a `user`
 * attribute (public user shape + sessionId).
 */
final class RequireAuth implements MiddlewareInterface
{
    public function __construct(private readonly AuthService $auth) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $header = $request->getHeaderLine('Authorization');
        if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/i', $header, $m)) {
            throw new ApiException('UNAUTHENTICATED', 'sign in to continue', 401);
        }
        $user = $this->auth->verifyToken($m[1]);
        return $handler->handle($request->withAttribute('user', $user));
    }
}
