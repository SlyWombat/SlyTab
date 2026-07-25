<?php

declare(strict_types=1);

/**
 * Feedback pipeline cron (FR-10.3): file GitHub issues for new bug
 * reports; email reporters when their issue closes. Runs every 10
 * minutes on the cPanel host — survives any dev session.
 *
 * Cron: APP_CONFIG_PATH=$HOME/slytab/config.env php $HOME/slytab/api/bin/bug-issue-sync.php
 */

require dirname(__DIR__) . '/vendor/autoload.php';

use SlyTab\Db\Db;
use SlyTab\Services\BugReportService;

$r = (new BugReportService(Db::pdo()))->syncGithub();
echo gmdate('c') . " filed={$r['filed']} notified={$r['notified']}"
    . ($r['skipped'] !== '' ? " skipped: {$r['skipped']}" : '') . "\n";
