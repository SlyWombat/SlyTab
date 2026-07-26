<?php

declare(strict_types=1);

namespace SlyTab\Support;

/**
 * The assignable category slugs (issue #18) — five headings and their
 * leaves. The API only ever needs the slugs: labels and emoji live in
 * @slytab/core for the clients, and a group's renames live in
 * group_categories.
 *
 * This list mirrors packages/core/src/categories.ts. CategoryParityTest
 * asserts the two agree against the shared vector, the same gate the money
 * math uses (architecture §3) — so a slug added on one side and forgotten
 * on the other fails CI rather than silently rejecting expenses.
 */
final class Categories
{
    public const HEADINGS = ['drinks', 'dining', 'travel', 'adulting', 'other'];

    public const SLUGS = [
        'drinks', 'drinks.bar', 'drinks.wine', 'drinks.beer', 'drinks.coffee', 'drinks.liquor',
        'dining', 'dining.restaurant', 'dining.groceries', 'dining.takeout', 'dining.snacks', 'dining.dessert',
        'travel', 'travel.taxi', 'travel.flights', 'travel.lodging', 'travel.fuel', 'travel.transit',
        'travel.rental', 'travel.parking',
        'adulting', 'adulting.rent', 'adulting.utilities', 'adulting.internet', 'adulting.insurance',
        'adulting.household', 'adulting.maintenance', 'adulting.medical',
        'other', 'other.entertainment', 'other.activities', 'other.shopping', 'other.gifts',
        'other.fees', 'other.pets',
    ];

    public static function isValid(string $slug): bool
    {
        return in_array($slug, self::SLUGS, true);
    }

    /** 'travel.taxi' → 'travel'; a heading maps to itself. */
    public static function heading(string $slug): string
    {
        $dot = strpos($slug, '.');
        return $dot === false ? $slug : substr($slug, 0, $dot);
    }
}
