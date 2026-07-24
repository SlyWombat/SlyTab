<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use SlyTab\Support\Env;

Env::bootstrap();

// Tests ALWAYS run against the dedicated test database — override whatever
// DB_NAME the environment provided so a test run can never touch dev data.
$testDb = getenv('DB_TEST_NAME') ?: 'slytab_test';
putenv("DB_NAME={$testDb}");

// Peppers/keys are required by the services; provide throwaways for test
// runs that don't configure them.
foreach (['SESSION_PEPPER', 'INVITE_HMAC_KEY', 'MIGRATE_TOKEN'] as $key) {
    if (getenv($key) === false || getenv($key) === '') {
        putenv("{$key}=test-only-{$key}-not-a-secret");
    }
}
putenv('MAIL_DISABLE=1');
putenv('PUSH_DISABLE=1'); // never attempt real mail from a test run
putenv('FX_OFFLINE=1');   // never fetch live FX rates from a test run
