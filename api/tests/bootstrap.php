<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use SlySplit\Support\Env;

Env::bootstrap();

// Tests ALWAYS run against the dedicated test database — override whatever
// DB_NAME the environment provided so a test run can never touch dev data.
$testDb = getenv('DB_TEST_NAME') ?: 'slysplit_test';
putenv("DB_NAME={$testDb}");

// A pepper is required by AuthService; provide a throwaway for test runs
// that don't configure one.
if (getenv('SESSION_PEPPER') === false || getenv('SESSION_PEPPER') === '') {
    putenv('SESSION_PEPPER=test-only-pepper-not-a-secret');
}
