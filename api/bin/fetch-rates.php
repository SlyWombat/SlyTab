<?php

declare(strict_types=1);

/** Daily ECB rate fetch (cPanel cron): php bin/fetch-rates.php */

require dirname(__DIR__) . '/vendor/autoload.php';

use SlyTab\Db\Db;
use SlyTab\Services\FxService;

$r = (new FxService(Db::pdo()))->refresh();
echo "stored {$r['count']} EUR rates for {$r['date']}\n";
