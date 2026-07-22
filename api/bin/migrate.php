<?php

declare(strict_types=1);

/**
 * Apply pending migrations: php bin/migrate.php
 * Used by local dev (npm run db:migrate) and the deploy step.
 */

require dirname(__DIR__) . '/vendor/autoload.php';

use SlySplit\Db\Db;
use SlySplit\Db\Migrator;

$ran = (new Migrator(Db::pdo()))->migrate();
echo $ran === []
    ? "up to date — no pending migrations\n"
    : 'applied: ' . implode(', ', $ran) . "\n";
