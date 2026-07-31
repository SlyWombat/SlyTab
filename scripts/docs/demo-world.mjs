/**
 * The demo world the user manual is photographed in (issue #104).
 *
 * Every number, name and date here is fixed on purpose. Screenshots are
 * regenerated at every release and diffed; anything that moves on its own —
 * a real balance, today's date, a live FX rate — would make every rebuild
 * look like a change and train people to ignore the diff.
 *
 * Rules this file obeys, and that anything added to it must obey:
 *   - No clock. `TODAY` is pinned and the browser clock is frozen to it
 *     during capture, so "this month" and relative dates never move.
 *   - No live FX. Foreign-currency expenses pass `fxRateOverride`, which the
 *     API stores as source `manual` — no call to the ECB feed, no rate that
 *     differs between two runs (FR-5.2/FR-5.4).
 *   - No real people. All addresses are on example.com (RFC 2606) and the
 *     accounts are flagged `is_test` where the schema allows it.
 *   - Amounts are integer minor units and every split sums to the total
 *     exactly, because the API rejects anything else.
 *
 * SEED_REV namespaces the demo accounts. Bump it when the world below
 * changes shape, so a re-seed builds a clean world instead of colliding with
 * the previous one. Bumping it changes the email shown on the Profile
 * screenshot, so bump deliberately.
 */

export const SEED_REV = 'r2';

/** Pinned "now". Bump deliberately (and re-accept the docs) — never automatically. */
export const TODAY = '2026-07-15T10:24:00-04:00';

/** Same password for every demo account; these accounts exist only on a dev DB. */
export const DEMO_PASSWORD = 'slytab-demo-account-pw';

const at = (local) => `demo-${local}-${SEED_REV}@example.com`;

export const PEOPLE = {
  dave: {
    key: 'dave',
    email: at('dave'),
    displayName: 'Dave',
    defaultCurrency: 'CAD',
    paymentHandles: { interacEmail: at('dave'), paypalMe: 'davedemo' },
  },
  alice: {
    key: 'alice',
    email: at('alice'),
    displayName: 'Alice',
    defaultCurrency: 'CAD',
    paymentHandles: { interacEmail: at('alice') },
  },
  jon: {
    key: 'jon',
    email: at('jon'),
    displayName: 'Jon',
    defaultCurrency: 'USD',
    paymentHandles: { venmo: 'jondemo' },
  },
  priya: {
    key: 'priya',
    email: at('priya'),
    displayName: 'Priya',
    defaultCurrency: 'CAD',
    paymentHandles: {},
  },
};

/** The account the manual is written from. */
export const READER = PEOPLE.dave;

/**
 * Equal split helper: the API requires shares to sum to the total exactly,
 * so the remainder goes to the earlier members one minor unit at a time —
 * the same largest-remainder rule @slytab/core uses.
 */
function equal(total, keys) {
  const base = Math.floor(total / keys.length);
  let rem = total - base * keys.length;
  return keys.map((k) => ({ key: k, amountMinor: base + (rem-- > 0 ? 1 : 0) }));
}

export const GROUPS = [
  {
    key: 'cottage',
    name: 'Cottage Trip',
    emoji: '🏡',
    homeCurrency: 'CAD',
    members: ['dave', 'alice', 'jon'],
    expenses: [
      {
        description: 'Groceries',
        amountMinor: 18240,
        currency: 'CAD',
        expenseDate: '2026-07-04',
        category: 'dining.groceries',
        splitMethod: 'equal',
        payers: [{ key: 'dave', amountMinor: 18240 }],
        shares: equal(18240, ['dave', 'alice', 'jon']),
      },
      {
        description: 'Firewood',
        amountMinor: 4500,
        currency: 'CAD',
        expenseDate: '2026-07-05',
        category: 'adulting.household',
        splitMethod: 'equal',
        payers: [{ key: 'alice', amountMinor: 4500 }],
        shares: equal(4500, ['dave', 'alice', 'jon']),
      },
      {
        // The multi-currency exhibit: a US ferry ticket in a CAD group. The
        // rate is pinned, so the converted figure in the manual is the same
        // every rebuild and matches the prose (FR-5.2, FR-5.3).
        description: 'Ferry tickets',
        amountMinor: 9600,
        currency: 'USD',
        fxRateOverride: 1.37,
        expenseDate: '2026-07-06',
        category: 'travel.transit',
        splitMethod: 'equal',
        payers: [{ key: 'jon', amountMinor: 9600 }],
        shares: equal(9600, ['dave', 'alice', 'jon']),
      },
      {
        // The exhibit for a non-equal split: Dave ordered the expensive thing.
        description: 'Dinner at the marina',
        amountMinor: 21000,
        currency: 'CAD',
        expenseDate: '2026-07-08',
        category: 'dining.restaurant',
        splitMethod: 'exact',
        payers: [{ key: 'dave', amountMinor: 21000 }],
        shares: [
          { key: 'dave', amountMinor: 9000 },
          { key: 'alice', amountMinor: 6000 },
          { key: 'jon', amountMinor: 6000 },
        ],
      },
    ],
  },
  {
    key: 'household',
    name: 'Household',
    emoji: '🏠',
    homeCurrency: 'CAD',
    members: ['dave', 'alice'],
    expenses: [
      {
        description: 'Internet',
        amountMinor: 8999,
        currency: 'CAD',
        expenseDate: '2026-06-30',
        category: 'adulting.internet',
        splitMethod: 'equal',
        payers: [{ key: 'alice', amountMinor: 8999 }],
        shares: equal(8999, ['dave', 'alice']),
      },
      {
        // Alice pays both household bills on purpose. The reader has to OWE
        // somebody somewhere or the manual can never photograph settling up —
        // the Settle button only renders on a row where you are the payer of
        // the suggested transfer. It also gives Home both halves of its
        // "you're owed … · you owe …" line instead of a one-sided balance.
        description: 'Hydro',
        amountMinor: 14215,
        currency: 'CAD',
        expenseDate: '2026-07-01',
        category: 'adulting.utilities',
        splitMethod: 'equal',
        payers: [{ key: 'alice', amountMinor: 14215 }],
        shares: equal(14215, ['dave', 'alice']),
      },
    ],
  },
];

/** 1:1 "split with a friend" groups (POST /friends), which Home lists first. */
export const FRIENDS = [
  {
    key: 'priya',
    with: 'priya',
    homeCurrency: 'CAD',
    expenses: [
      {
        description: 'Concert tickets',
        amountMinor: 12000,
        currency: 'CAD',
        expenseDate: '2026-07-10',
        category: 'other.entertainment',
        splitMethod: 'equal',
        payers: [{ key: 'dave', amountMinor: 12000 }],
        shares: equal(12000, ['dave', 'priya']),
      },
    ],
  },
];
