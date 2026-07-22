<?php

declare(strict_types=1);

namespace SlySplit\Support;

/**
 * A request-level failure that maps to the error envelope
 * { "error": { "code", "message" } } with an HTTP status.
 */
final class ApiException extends \RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 400,
    ) {
        parent::__construct($message);
    }
}
