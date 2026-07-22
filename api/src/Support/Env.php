<?php

declare(strict_types=1);

namespace SlySplit\Support;

/**
 * Configuration bootstrap. Resolution order:
 *   1. Real environment variables (CI, docker --env-file) — always win.
 *   2. APP_CONFIG_PATH file (production: lives above public_html).
 *   3. Repo-root .env (local dev convenience).
 * Values are exposed via getenv(); this loader never logs or echoes them.
 */
final class Env
{
    private static bool $loaded = false;

    public static function bootstrap(): void
    {
        if (self::$loaded) {
            return;
        }
        self::$loaded = true;

        if (getenv('DB_HOST') !== false) {
            return; // real environment already configured
        }

        $candidates = [];
        $configured = getenv('APP_CONFIG_PATH');
        if ($configured !== false && $configured !== '') {
            $candidates[] = $configured;
        }
        $candidates[] = dirname(__DIR__, 3) . '/.env';

        foreach ($candidates as $path) {
            if (is_readable($path)) {
                self::loadFile($path);
                return;
            }
        }
    }

    private static function loadFile(string $path): void
    {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            $eq = strpos($line, '=');
            if ($eq === false) {
                continue;
            }
            $key = trim(substr($line, 0, $eq));
            $val = trim(substr($line, $eq + 1));
            if (strlen($val) >= 2 && ($val[0] === '"' || $val[0] === "'") && str_ends_with($val, $val[0])) {
                $val = substr($val, 1, -1);
            }
            if (getenv($key) === false) {
                putenv("{$key}={$val}");
            }
        }
    }

    public static function require(string $key): string
    {
        self::bootstrap();
        $val = getenv($key);
        if ($val === false || $val === '') {
            throw new \RuntimeException("missing required configuration: {$key}");
        }
        return $val;
    }

    public static function get(string $key, string $default = ''): string
    {
        self::bootstrap();
        $val = getenv($key);
        return $val === false ? $default : $val;
    }
}
