/**
 * The shot list: every screen the user manual documents, what renders it, and
 * where it is written about (issue #104).
 *
 * This file is the join between three things that must not drift apart:
 *
 *   screen  ──sources──▶  the code that draws it
 *      │
 *      └────doc────────▶  the section of the manual that explains it
 *
 * `sources` feeds the staleness gate (scripts/docs/check-docs.mjs): when any
 * of those files change, the gate demands that the matching prose section be
 * re-read and re-stamped. Getting `sources` wrong is the one way this whole
 * pipeline can lie, so keep the globs tight and honest.
 *
 * `screen` is the heading from docs/design/ui_requirements.md §2 that this
 * shot covers. check-docs.mjs cross-references the §4 v1.0 screen checklist
 * and fails when a screen there has no shot at all.
 */

const WEB_SHELL = ['apps/web/src/Shell.tsx', 'apps/web/src/ui.tsx', 'apps/web/src/Icon.tsx',
  'apps/web/src/styles/**'];

export const DEVICES = {
  // Wide enough for the left rail (§1: rail above 760px).
  desktop: { width: 1280, height: 900, deviceScaleFactor: 2 },
  // Phone-width browser: bottom bar instead of the rail. Same code, and the
  // manual has to show what a phone user actually sees.
  narrow: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

/**
 * Screens on the ui_requirements.md §4 checklist that deliberately have no
 * shot, with the reason. The gate reports these as notes instead of failures,
 * so a known gap stays visible without permanently redding the build — and so
 * that adding one silently is impossible.
 */
export const UNSHOT = {
  'First-run setup':
    'needs a never-onboarded account; add a fifth demo person with onboarded:false when the manual covers it',
  'Receipt capture → review → assign':
    'needs the self-hosted vision model running and a fixture receipt photo — a scan is not reproducible offline (docs/llm-requirements.md)',
};

export const SHOTS = [
  {
    id: 'welcome',
    screen: '2.1 Welcome / auth',
    title: 'The sign-in screen',
    device: 'desktop',
    // Signed-out: the manual's first screenshot is what a new user sees.
    signedOut: true,
    sources: ['apps/web/src/screens/Auth.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'signing-in' },
    expect: ['Create an account'],
    steps: async ({ settle }) => { await settle(); },
  },
  {
    id: 'settle',
    screen: '2.7 Settle up',
    title: 'Settling up with someone',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'settling-up' },
    expect: ['Record cash'],
    steps: async ({ openGroup, page, settle }) => {
      await openGroup('Cottage Trip');
      await page.getByRole('tab', { name: 'Balances' }).click();
      await settle();
      await page.getByRole('button', { name: 'Settle' }).first().click();
      await settle();
    },
  },
  {
    id: 'home',
    screen: '2.2 Home',
    title: 'Home — where you stand across every group',
    device: 'desktop',
    sources: ['apps/web/src/screens/Home.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'home' },
    expect: ['Cottage Trip', 'Household', 'Priya'],
    steps: async ({ dest, settle }) => { await dest('Home'); await settle(); },
  },
  {
    id: 'home-narrow',
    screen: '2.2 Home',
    title: 'Home on a phone-width browser',
    device: 'narrow',
    sources: ['apps/web/src/screens/Home.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'home' },
    expect: ['Cottage Trip'],
    steps: async ({ dest, settle }) => { await dest('Home'); await settle(); },
  },
  {
    id: 'groups',
    screen: '2.3 Groups list',
    title: 'Groups',
    device: 'desktop',
    sources: ['apps/web/src/screens/Groups.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'groups' },
    expect: ['Cottage Trip', 'Household'],
    steps: async ({ dest, settle }) => { await dest('Groups'); await settle(); },
  },
  {
    id: 'group-expenses',
    screen: '2.4 Group detail — Expenses',
    title: 'A group’s expenses',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'group-expenses' },
    expect: ['Groceries', 'Ferry tickets', 'Dinner at the marina'],
    steps: async ({ openGroup, settle }) => { await openGroup('Cottage Trip'); await settle(); },
  },
  {
    id: 'group-balances',
    screen: '2.4 Group detail — Balances',
    title: 'Balances and the settle-up plan',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'group-balances' },
    expect: ['Alice', 'Jon'],
    steps: async ({ openGroup, page, settle }) => {
      await openGroup('Cottage Trip');
      await page.getByRole('tab', { name: 'Balances' }).click();
      await settle();
    },
  },
  {
    id: 'group-totals',
    screen: '2.4 Group detail — Totals',
    title: 'Totals by person and category',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'group-totals' },
    expect: ['Cottage Trip'],
    steps: async ({ openGroup, page, settle }) => {
      await openGroup('Cottage Trip');
      await page.getByRole('tab', { name: 'Totals' }).click();
      await settle();
    },
  },
  {
    id: 'add-expense',
    screen: '2.5 Add / edit expense',
    title: 'Adding an expense',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', 'packages/core/src/split.ts', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'add-expense' },
    // Typed text lives in input *values*, not in the text layer — assert on
    // the sheet's own chrome instead.
    expect: ['Save expense'],
    steps: async ({ openGroup, page, settle }) => {
      await openGroup('Cottage Trip');
      await page.getByRole('button', { name: 'Add expense' }).click();
      await page.getByLabel('Amount').fill('64.50');
      await page.getByLabel('Description').fill('Kayak rental');
      await settle();
    },
  },
  {
    id: 'expense-foreign-currency',
    screen: '2.8 Expense detail (multi-currency)',
    title: 'A foreign-currency expense and its locked rate',
    device: 'desktop',
    sources: ['apps/web/src/screens/Group.tsx', 'packages/core/src/money.ts', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'currencies' },
    expect: ['Ferry tickets'],
    steps: async ({ openGroup, page, settle }) => {
      await openGroup('Cottage Trip');
      await page.getByText('Ferry tickets').first().click();
      await settle();
    },
  },
  {
    id: 'activity',
    screen: '2.9 Activity',
    title: 'Activity',
    device: 'desktop',
    sources: ['apps/web/src/screens/Activity.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'activity' },
    expect: ['Activity'],
    steps: async ({ dest, settle }) => { await dest('Activity'); await settle(); },
  },
  {
    id: 'profile',
    screen: '2.10 Profile & settings',
    title: 'Profile and settings',
    device: 'desktop',
    sources: ['apps/web/src/screens/Profile.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'profile' },
    expect: ['Profile'],
    // Profile is taller than the viewport and the manual needs all of it.
    fullPage: true,
    // The signed-in devices list is the one genuinely per-run region on any
    // screen: real server timestamps rendered as "last active …" against the
    // frozen browser clock. Masked in the image, collapsed in the signature.
    mask: [{ selector: '.row', hasText: 'last active' }],
    steps: async ({ dest, settle }) => { await dest('Profile'); await settle(); },
  },
  {
    id: 'my-expenses',
    screen: '2.11 My expenses',
    title: 'Everything you have spent, across groups',
    device: 'desktop',
    sources: ['apps/web/src/screens/MyExpenses.tsx', 'apps/web/src/screens/Activity.tsx', ...WEB_SHELL],
    doc: { file: 'docs/user-guide/manual.md', anchor: 'my-expenses' },
    expect: ['My expenses'],
    steps: async ({ dest, page, settle }) => {
      await dest('Activity');
      await page.getByRole('tab', { name: 'My expenses' }).click();
      await settle();
    },
  },
];
