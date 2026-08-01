<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SlyTab\Services\ClientTimingService;

/**
 * Path templating for client timings (#111).
 *
 * This is the privacy boundary, not a formatting nicety: without it the table
 * would hold a row per group per request — a record of who opened what and
 * when, gathered for no reason beyond finding out that a screen is slow. It is
 * also what makes percentiles meaningful, since a per-id name has one sample.
 */
final class ClientTimingTemplateTest extends TestCase
{
    /** @return array<string,array{0:string,1:string}> */
    public static function paths(): array
    {
        return [
            'group id'         => ['/groups/01KY89N8SZ0257NPFDKG8238PS', '/groups/:id'],
            'nested group id'  => ['/groups/01KY89N8SZ0257NPFDKG8238PS/expenses', '/groups/:id/expenses'],
            'two ids'          => [
                '/groups/01KY89N8SZ0257NPFDKG8238PS/expenses/01KYXNTKH0P5EMEW5G4HE7QN71',
                '/groups/:id/expenses/:id',
            ],
            'api prefix'       => ['/api/v1/groups/01KY89N8SZ0257NPFDKG8238PS', '/groups/:id'],
            'invite token'     => ['/join/0123456789abcdef0123456789abcdef', '/join/:token'],
            'numeric id'       => ['/splitwise/groups/12345', '/splitwise/groups/:n'],
            'no id'            => ['/me/balances', '/me/balances'],
            'query dropped'    => ['/groups/01KY89N8SZ0257NPFDKG8238PS/expenses?q=dinner', '/groups/:id/expenses'],
        ];
    }

    #[DataProvider('paths')]
    public function testTemplateStripsIdentifiers(string $input, string $expected): void
    {
        self::assertSame($expected, ClientTimingService::template($input));
    }

    public function testNoRawIdentifierSurvivesAnywhere(): void
    {
        // The property that matters: whatever the shape, a 26-character ULID
        // must not come out the other side.
        $ulid = '01KY89N8SZ0257NPFDKG8238PS';
        foreach ([
            "/groups/{$ulid}",
            "/groups/{$ulid}/expenses/{$ulid}/comments",
            "/receipts/{$ulid}/image",
            "/api/v1/groups/{$ulid}/totals?from=2026-01-01",
        ] as $path) {
            self::assertStringNotContainsString(
                $ulid,
                ClientTimingService::template($path),
                "identifier leaked from {$path}",
            );
        }
    }

    public function testLengthIsBounded(): void
    {
        // A pathological name must not become a pathological column write.
        self::assertLessThanOrEqual(120, strlen(ClientTimingService::template('/' . str_repeat('a', 500))));
    }

    /** A search term is a user's own words and has no business being a metric name. */
    public function testQueryStringIsNotKept(): void
    {
        $t = ClientTimingService::template('/groups/01KY89N8SZ0257NPFDKG8238PS/expenses?q=divorce%20lawyer');
        self::assertStringNotContainsString('divorce', $t);
        self::assertStringNotContainsString('?', $t);
    }
}
