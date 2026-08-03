<?php

declare(strict_types=1);

namespace SlyTab\Services;

/**
 * What the current released app is, so a running one can notice it is behind.
 *
 * The app had no way to know a newer build existed. On iOS that mostly sorts
 * itself out, because the App Store updates in the background. On Android it
 * does not: the APK is downloaded straight from the site rather than installed
 * from Play, and a sideloaded APK never updates itself. Someone could sit on a
 * months-old build indefinitely with no hint that the bug they reported was
 * fixed — while the resolution email tells them to "update to the latest
 * version".
 *
 * The numbers come from apps/mobile/versions.json, copied in by
 * scripts/deploy-api.sh. One source of truth: the same file the release
 * scripts bump is the one this reads, so it cannot drift from what was
 * actually built.
 *
 * Advisory only, deliberately. There is no minimum-supported version and no
 * way for this to lock anyone out — an expense-splitting app for a family has
 * no business refusing to open because a build is old, and a forced-upgrade
 * switch is a foot-gun that eventually fires on a Sunday.
 */
final class ReleaseService
{
    private const FILE = 'releases.json';

    /**
     * @return array{
     *   ios?: array{version: string, build: int},
     *   android?: array{version: string, build: int}
     * }
     */
    public function current(): array
    {
        // Deployed: scripts/deploy-api.sh drops it beside src/. In a checkout
        // there is no copy and there should not be one — a second file would
        // be free to disagree with the first — so fall back to the mobile
        // app's own versions.json, which is the original either way.
        $path = dirname(__DIR__, 2) . '/' . self::FILE;
        if (!is_readable($path)) {
            $path = dirname(__DIR__, 3) . '/apps/mobile/versions.json';
        }
        if (!is_readable($path)) {
            // Not deployed yet, or deployed without it. An app that cannot
            // find out stays quiet rather than guessing it is out of date.
            return [];
        }
        $raw = json_decode((string) @file_get_contents($path), true);
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        // iOS counts with buildNumber, Android with versionCode. Both are
        // integers that only go up, which is the only property being relied on.
        if (isset($raw['ios']['version'], $raw['ios']['buildNumber'])) {
            $out['ios'] = [
                'version' => (string) $raw['ios']['version'],
                'build' => (int) $raw['ios']['buildNumber'],
            ];
        }
        if (isset($raw['android']['version'], $raw['android']['versionCode'])) {
            $out['android'] = [
                'version' => (string) $raw['android']['version'],
                'build' => (int) $raw['android']['versionCode'],
            ];
        }
        return $out;
    }
}
