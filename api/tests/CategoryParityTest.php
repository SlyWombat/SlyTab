<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use SlyTab\Support\Categories;

/**
 * Cross-language parity for the category taxonomy (issue #18), the same
 * gate the money math uses: packages/core owns the taxonomy, this asserts
 * the PHP mirror still agrees with it. Add a category on one side only and
 * this fails — rather than the API rejecting an expense the client happily
 * offered.
 */
final class CategoryParityTest extends TestCase
{
    /** @return list<string> */
    private static function sharedSlugs(): array
    {
        $path = dirname(__DIR__, 2) . '/packages/core/test-vectors/categories.json';
        $json = json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
        return $json['slugs'];
    }

    public function testPhpSlugsMatchTheSharedTaxonomyExactly(): void
    {
        self::assertSame(self::sharedSlugs(), Categories::SLUGS);
    }

    public function testEveryHeadingIsAlsoAnAssignableSlug(): void
    {
        foreach (Categories::HEADINGS as $heading) {
            self::assertTrue(Categories::isValid($heading), "{$heading} must stay assignable");
            self::assertSame($heading, Categories::heading($heading));
        }
    }

    public function testLeavesResolveToTheirHeading(): void
    {
        foreach (Categories::SLUGS as $slug) {
            $heading = Categories::heading($slug);
            self::assertContains($heading, Categories::HEADINGS, "{$slug} belongs to no heading");
        }
    }

    /**
     * The five original slugs are on every expense already stored — they
     * must never stop validating.
     */
    public function testLegacyCategoriesStillValidate(): void
    {
        foreach (['drinks', 'dining', 'travel', 'adulting', 'other'] as $legacy) {
            self::assertTrue(Categories::isValid($legacy));
        }
        self::assertFalse(Categories::isValid('food'));       // pre-2026-07 vocabulary
        self::assertFalse(Categories::isValid('travel.jet')); // not in the taxonomy
    }
}
