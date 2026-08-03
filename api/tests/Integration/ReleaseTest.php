<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use SlyTab\Services\ReleaseService;
use PHPUnit\Framework\TestCase;

final class ReleaseTest extends TestCase
{
    /**
     * The app cannot tell it is out of date without this, and on Android that
     * is the only signal there is: the APK is sideloaded and never updates
     * itself (#118).
     */
    public function testReportsTheCurrentReleasePerPlatform(): void
    {
        $current = (new ReleaseService())->current();

        self::assertArrayHasKey('ios', $current);
        self::assertArrayHasKey('android', $current);
        // Integers that only go up is the whole contract — the client compares
        // its own build against these and nothing else.
        self::assertIsInt($current['ios']['build']);
        self::assertIsInt($current['android']['build']);
        self::assertGreaterThan(0, $current['ios']['build']);
        self::assertGreaterThan(0, $current['android']['build']);
        self::assertMatchesRegularExpression('/^\d+\.\d+/', $current['ios']['version']);
    }
}
