/**
 * The expense category taxonomy (issue #18).
 *
 * Two levels: five HEADINGS — the owner's snarky five, whose slugs are the
 * ones already stored on every existing expense — and a set of
 * subcategories under each. Both levels are assignable: an expense may sit
 * on a heading ("Getting there") or on a leaf ("Taxi & rideshare"), which
 * is what lets old data stay valid and lets the Splitwise import land
 * somewhere more specific than "other".
 *
 * Slugs are stable API identifiers and must never be reworded — labels are
 * what humans see, and a group may override any of them (see
 * `resolveCategories`). Leaf slugs are namespaced by their heading so a
 * slug alone tells you where it belongs.
 */

export interface CategoryNode {
  slug: string;
  label: string;
  emoji: string;
}

export interface CategoryHeading extends CategoryNode {
  children: CategoryNode[];
}

export const CATEGORY_TREE: CategoryHeading[] = [
  {
    slug: 'drinks', label: 'Liquid assets', emoji: '🍸',
    children: [
      { slug: 'drinks.bar', label: 'Bars', emoji: '🍸' },
      { slug: 'drinks.wine', label: 'Wine', emoji: '🍷' },
      { slug: 'drinks.beer', label: 'Beer', emoji: '🍺' },
      { slug: 'drinks.coffee', label: 'Coffee', emoji: '☕' },
      { slug: 'drinks.liquor', label: 'Liquor store', emoji: '🥃' },
    ],
  },
  {
    slug: 'dining', label: 'Overpriced calories', emoji: '🍽️',
    children: [
      { slug: 'dining.restaurant', label: 'Restaurants', emoji: '🍽️' },
      { slug: 'dining.groceries', label: 'Groceries', emoji: '🛒' },
      { slug: 'dining.takeout', label: 'Takeout & delivery', emoji: '🥡' },
      { slug: 'dining.snacks', label: 'Snacks', emoji: '🍿' },
      { slug: 'dining.dessert', label: 'Dessert', emoji: '🍰' },
    ],
  },
  {
    slug: 'travel', label: 'Getting there', emoji: '✈️',
    children: [
      { slug: 'travel.taxi', label: 'Taxi & rideshare', emoji: '🚕' },
      { slug: 'travel.flights', label: 'Flights', emoji: '✈️' },
      { slug: 'travel.lodging', label: 'Hotels & lodging', emoji: '🏨' },
      { slug: 'travel.fuel', label: 'Gas & fuel', emoji: '⛽' },
      { slug: 'travel.transit', label: 'Public transit', emoji: '🚌' },
      { slug: 'travel.rental', label: 'Car rental', emoji: '🚗' },
      { slug: 'travel.parking', label: 'Parking & tolls', emoji: '🅿️' },
    ],
  },
  {
    slug: 'adulting', label: 'Adulting', emoji: '🧾',
    children: [
      { slug: 'adulting.rent', label: 'Rent', emoji: '🏠' },
      { slug: 'adulting.utilities', label: 'Utilities', emoji: '💡' },
      { slug: 'adulting.internet', label: 'Internet & phone', emoji: '📶' },
      { slug: 'adulting.insurance', label: 'Insurance', emoji: '🛡️' },
      { slug: 'adulting.household', label: 'Household supplies', emoji: '🧻' },
      { slug: 'adulting.maintenance', label: 'Repairs & maintenance', emoji: '🔧' },
      { slug: 'adulting.medical', label: 'Medical', emoji: '💊' },
    ],
  },
  {
    slug: 'other', label: 'Questionable choices', emoji: '🎲',
    children: [
      { slug: 'other.entertainment', label: 'Entertainment', emoji: '🎭' },
      { slug: 'other.activities', label: 'Activities & tickets', emoji: '🎟️' },
      { slug: 'other.shopping', label: 'Shopping', emoji: '🛍️' },
      { slug: 'other.gifts', label: 'Gifts', emoji: '🎁' },
      { slug: 'other.fees', label: 'Fees & charges', emoji: '🏦' },
      { slug: 'other.pets', label: 'Pets', emoji: '🐾' },
    ],
  },
];

/** The five heading slugs — what expenses carried before subcategories. */
export const CATEGORY_HEADINGS = CATEGORY_TREE.map((h) => h.slug);

/** Every assignable slug, headings included, in display order. */
export const CATEGORY_SLUGS: string[] = CATEGORY_TREE.flatMap(
  (h) => [h.slug, ...h.children.map((c) => c.slug)],
);

const NODES = new Map<string, CategoryNode>(
  CATEGORY_TREE.flatMap((h) => [
    [h.slug, { slug: h.slug, label: h.label, emoji: h.emoji }] as const,
    ...h.children.map((c) => [c.slug, c] as const),
  ]),
);

export function isCategorySlug(slug: string): boolean {
  return NODES.has(slug);
}

/** The heading a slug belongs to ('travel.taxi' → 'travel'); itself if it is one. */
export function categoryHeading(slug: string): string {
  const dot = slug.indexOf('.');
  return dot === -1 ? slug : slug.slice(0, dot);
}

/**
 * A group's per-category overrides, keyed by slug. Sparse: only the
 * categories a group actually customised are stored, so the shipped
 * defaults stay free to improve.
 */
export interface CategoryOverride {
  label?: string;
  hidden?: boolean;
  sortOrder?: number;
}

export interface ResolvedHeading extends ResolvedCategory {
  children: ResolvedCategory[];
}

export interface ResolvedCategory extends CategoryNode {
  /** Heading slug, or the category's own slug when it IS a heading. */
  heading: string;
  hidden: boolean;
  /** True when this group renamed it — the UI offers "reset to default". */
  renamed: boolean;
  defaultLabel: string;
}

/**
 * Apply a group's overrides to the shipped taxonomy. Hidden categories are
 * still returned (the manage screen needs them, and an expense already
 * filed under one must still render its label) — callers building a picker
 * filter on `hidden` themselves.
 */
export function resolveCategories(
  overrides: Record<string, CategoryOverride> = {},
): ResolvedHeading[] {
  const apply = (n: CategoryNode, heading: string): ResolvedCategory => {
    const o = overrides[n.slug] ?? {};
    const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : n.label;
    return {
      slug: n.slug,
      label,
      emoji: n.emoji,
      heading,
      hidden: o.hidden === true,
      renamed: label !== n.label,
      defaultLabel: n.label,
    };
  };
  const order = (a: CategoryNode, b: CategoryNode, fallback: number): number => {
    const ao = overrides[a.slug]?.sortOrder;
    const bo = overrides[b.slug]?.sortOrder;
    if (ao === undefined && bo === undefined) return fallback;
    return (ao ?? Number.MAX_SAFE_INTEGER) - (bo ?? Number.MAX_SAFE_INTEGER);
  };

  return CATEGORY_TREE
    .map((h, hi) => ({
      ...apply(h, h.slug),
      children: h.children
        .map((c, ci) => ({ node: apply(c, h.slug), i: ci }))
        .sort((a, b) => order(a.node, b.node, a.i - b.i))
        .map((x) => x.node),
      _i: hi,
    }))
    .sort((a, b) => order(a, b, a._i - b._i))
    .map(({ _i, ...h }) => h);
}

/**
 * Human label for a stored slug, honouring group overrides. Unknown slugs
 * (data from before the taxonomy, or a category retired later) render as
 * themselves rather than disappearing.
 */
export function categoryLabel(
  slug: string,
  overrides: Record<string, CategoryOverride> = {},
): string {
  const o = overrides[slug]?.label;
  if (typeof o === 'string' && o.trim() !== '') return o.trim();
  return NODES.get(slug)?.label ?? slug;
}

export function categoryEmoji(slug: string): string {
  return NODES.get(slug)?.emoji ?? '🏷️';
}
