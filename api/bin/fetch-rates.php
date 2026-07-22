<?php

declare(strict_types=1);

/**
 * Daily ECB rate fetch (cPanel cron): php bin/fetch-rates.php
 * Pulls the latest EUR-base reference rates from api.frankfurter.dev and
 * upserts them into fx_rates. Currency codes only leave the server — no
 * user data is ever sent (NFR-1).
 */

require dirname(__DIR__) . '/vendor/autoload.php';

use SlyTab\Db\Db;

$json = file_get_contents('https://api.frankfurter.dev/v1/latest?base=EUR');
if ($json === false) {
    fwrite(STDERR, "fetch failed\n");
    exit(1);
}
$data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
$date = $data['date'];
$rates = $data['rates'] + ['EUR' => 1.0];

$stmt = Db::pdo()->prepare(
    'INSERT INTO fx_rates (rate_date, base, quote, rate) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
);
foreach ($rates as $quote => $rate) {
    $stmt->execute([$date, 'EUR', $quote, (string) $rate]);
}
echo 'stored ' . count($rates) . " EUR rates for {$date}\n";
