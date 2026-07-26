import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_HEADINGS,
  CATEGORY_SLUGS,
  CATEGORY_TREE,
  categoryHeading,
  categoryLabel,
  isCategorySlug,
  resolveCategories,
} from '../src/categories.js';

/**
 * The taxonomy (#18) and the group overrides that ride on top of it. The
 * parity fixture is what the PHP side asserts against, so it is checked
 * here rather than assumed.
 */
describe('category taxonomy', () => {
  it('matches the shared parity vector the API validates against', () => {
    const vector = JSON.parse(
      readFileSync(new URL('../test-vectors/categories.json', import.meta.url), 'utf8'),
    );
    expect(vector.slugs).toEqual(CATEGORY_SLUGS);
  });

  it('keeps the five original slugs assignable, so stored expenses stay valid', () => {
    for (const legacy of ['drinks', 'dining', 'travel', 'adulting', 'other']) {
      expect(isCategorySlug(legacy)).toBe(true);
      expect(CATEGORY_HEADINGS).toContain(legacy);
    }
  });

  it('has unique slugs and namespaces every leaf under its heading', () => {
    expect(new Set(CATEGORY_SLUGS).size).toBe(CATEGORY_SLUGS.length);
    for (const heading of CATEGORY_TREE) {
      for (const child of heading.children) {
        expect(child.slug.startsWith(`${heading.slug}.`)).toBe(true);
        expect(categoryHeading(child.slug)).toBe(heading.slug);
      }
    }
  });

  it('resolves labels from group overrides and reports what was renamed', () => {
    const overrides = { 'travel.taxi': { label: 'Chariots' }, drinks: { label: '  ' } };
    expect(categoryLabel('travel.taxi', overrides)).toBe('Chariots');
    expect(categoryLabel('travel.taxi')).toBe('Taxi & rideshare');
    // A blank override is not a rename — fall back to the shipped label.
    expect(categoryLabel('drinks', overrides)).toBe('Liquid assets');
    expect(categoryLabel('nonsense.slug')).toBe('nonsense.slug');

    const tree = resolveCategories(overrides);
    const taxi = tree.find((h) => h.slug === 'travel')!.children.find((c) => c.slug === 'travel.taxi')!;
    expect(taxi.label).toBe('Chariots');
    expect(taxi.renamed).toBe(true);
    expect(taxi.defaultLabel).toBe('Taxi & rideshare');
  });

  it('keeps hidden categories in the resolved tree for the manage screen', () => {
    const tree = resolveCategories({ 'drinks.beer': { hidden: true } });
    const beer = tree.find((h) => h.slug === 'drinks')!.children.find((c) => c.slug === 'drinks.beer')!;
    expect(beer.hidden).toBe(true);
  });

  it('applies sortOrder while leaving un-ordered entries in shipped order', () => {
    const tree = resolveCategories({ other: { sortOrder: -1 } });
    expect(tree[0]!.slug).toBe('other');

    const drinks = resolveCategories({ 'drinks.liquor': { sortOrder: -1 } })
      .find((h) => h.slug === 'drinks')!;
    expect(drinks.children[0]!.slug).toBe('drinks.liquor');
    expect(drinks.children.slice(1).map((c) => c.slug)).toEqual([
      'drinks.bar', 'drinks.wine', 'drinks.beer', 'drinks.coffee',
    ]);
  });

  it('leaves the shipped tree untouched when a group has no overrides', () => {
    expect(resolveCategories()).toEqual(resolveCategories({}));
    expect(resolveCategories().flatMap((h) => [h.slug, ...h.children.map((c) => c.slug)]))
      .toEqual(CATEGORY_SLUGS);
  });
});
