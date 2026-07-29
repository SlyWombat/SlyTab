<?php

declare(strict_types=1);

namespace SlyTab\Db;

use PDO;
use SlyTab\Support\Env;

/** Lazy PDO holder. Configuration comes from Env (see Support\Env). */
final class Db
{
    private static ?PDO $pdo = null;

    /**
     * A connect failure is remembered for the rest of the request, so a
     * request that asks twice (bootstrap, then the deep health check) waits
     * one timeout rather than two. Cleared by set().
     */
    private static ?\Throwable $failure = null;

    public static function pdo(): PDO
    {
        if (self::$failure !== null) {
            throw self::$failure;
        }
        if (self::$pdo === null) {
            $host = Env::require('DB_HOST');
            $port = Env::get('DB_PORT', '3306');
            $name = Env::require('DB_NAME');
            $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
            $options = [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                // Fail fast when the database is unreachable. Without this,
                // a dead tunnel left every PHP worker blocked on connect for
                // 20s+ and the whole API timed out — including endpoints that
                // never touch the database (incident 2026-07-28).
                PDO::ATTR_TIMEOUT => (int) Env::get('DB_CONNECT_TIMEOUT', '5'),
            ];
            // Production reaches MySQL over a public tunnel: encrypt with the
            // server's own CA (self-signed, so hostname verification is off —
            // the CA pin is the trust anchor).
            $sslCa = Env::get('DB_SSL_CA');
            if ($sslCa !== '') {
                $options[PDO::MYSQL_ATTR_SSL_CA] = $sslCa;
                $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
            }
            try {
                self::$pdo = new PDO($dsn, Env::require('DB_USER'), Env::require('DB_PASS'), $options);
            } catch (\Throwable $e) {
                self::$failure = $e;
                throw $e;
            }
        }
        return self::$pdo;
    }

    /** Tests inject their own connection (pointed at the test database). */
    public static function set(?PDO $pdo): void
    {
        self::$pdo = $pdo;
        self::$failure = null;
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
