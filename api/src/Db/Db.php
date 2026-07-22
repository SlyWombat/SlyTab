<?php

declare(strict_types=1);

namespace SlySplit\Db;

use PDO;
use SlySplit\Support\Env;

/** Lazy PDO holder. Configuration comes from Env (see Support\Env). */
final class Db
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $host = Env::require('DB_HOST');
            $port = Env::get('DB_PORT', '3306');
            $name = Env::require('DB_NAME');
            $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
            self::$pdo = new PDO($dsn, Env::require('DB_USER'), Env::require('DB_PASS'), [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
        }
        return self::$pdo;
    }

    /** Tests inject their own connection (pointed at the test database). */
    public static function set(?PDO $pdo): void
    {
        self::$pdo = $pdo;
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
