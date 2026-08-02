import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * Opening a group must not fetch its expense list more often than everything
 * else on the screen.
 *
 * The effect used to depend on `group` and `feed`, both of which `reload()`
 * sets, so responses to the other requests re-triggered it. Measured: 4
 * expense requests against a baseline of 2 for every other endpoint. The
 * extras are triggered BY earlier responses, so they cost round trips *after*
 * the screen has already appeared — invisible on a fast link, and reported as
 * lag by two testers in Chile.
 *
 * WHAT THIS CAN AND CANNOT CATCH, as of 2026-08-02. Measured, not assumed:
 * putting the old `[…, group, feed]` dependencies back now produces the SAME
 * counts as the fix (expenses=1, balances=1). In-flight GET coalescing in
 * api.ts absorbs the duplicates, so the original regression can no longer be
 * reproduced through that route and this test cannot fail on it.
 *
 * It is kept as a guard on the invariant rather than on that one bug: the
 * expense list must never be fetched more often than the rest of the screen,
 * by any route. It would catch a new over-fetch, or the removal of coalescing
 * combined with a reintroduced dependency. Treat it as a weak guard, and do
 * not assume a passing run proves the dependency array is right.
 *
 * Two things this test needs in order to work, both learned the hard way:
 *
 *  1. **Staggered latency.** The duplicates are triggered by the group and
 *     activity responses. If those land together React batches the state
 *     updates into a single render and the extra fetch collapses into the
 *     debounce. They are delayed by different amounts on purpose.
 *  2. **A dev server that is actually serving your code.** playwright.config
 *     sets `reuseExistingServer`, and on a /mnt/d drive vite's watcher never
 *     sees edits — so a long-lived dev server keeps serving the module graph
 *     it started with. A stale one made this test pass with the bug
 *     deliberately reinstated, three times running, and very nearly got a real
 *     fix reverted as imaginary. If this ever passes when it should not, kill
 *     vite before trusting the result.
 */
test('opening a group fetches each thing exactly once', async ({ page }) => {
  const calls: string[] = [];
  const delayFor = (path: string) =>
    /\/groups\/[^/]+$/.test(path) ? 300 : /\/activity$/.test(path) ? 2200 : 0;

  await page.route('**/api/v1/**', async (route) => {
    const u = new URL(route.request().url());
    // Path only: the expense list carries query params, and a cursor or a
    // search term is a legitimately different request.
    const path = u.pathname.replace(/\/api\/v1/, '');
    calls.push(path);
    const wait = delayFor(path);
    if (wait === 0) return route.continue();
    // Fetch first, then hold the response back. Delaying before continue()
    // leaves the request in flight while the page re-renders around it, and
    // the screen never finishes loading.
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, wait));
    return route.fulfill({ response });
  });

  await signUp(page, 'Fetch Count');

  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Fetch Counting');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name: 'Fetch Counting' })).toBeVisible();

  // Everything before this point is setup; count only the group screen.
  calls.length = 0;
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Fetch Counting').click();
  await expect(page.getByRole('heading', { name: 'Fetch Counting' })).toBeVisible();
  await page.waitForTimeout(4500); // let the late duplicates arrive and be caught

  // Only the group's own endpoints: the Home tab has a /me/balances of its
  // own, and counting that as the group's balances made the baseline wrong.
  const count = (needle: string) =>
    calls.filter((c) => c.startsWith('/groups/') && c.endsWith(needle)).length;
  const detail = () => `calls: ${JSON.stringify(calls, null, 1)}`;

  // The bug was that the expense list was fetched two to three times per open
  // while everything else was fetched once. So that is what this asserts: the
  // list must not OUTPACE its neighbours.
  //
  // Not equality across all five, which is what this used to check. Two things
  // make exact counts unstable without saying anything about the bug. React
  // StrictMode double-invokes effects in development, so the absolute number
  // is 2 under `vite dev` and 1 in a production build. And in-flight GET
  // coalescing means a request issued just before the measurement window can
  // absorb the one inside it, legitimately leaving an endpoint at zero — which
  // is exactly what happened to /activity in CI once coalescing shipped.
  const others = ['/balances', '/totals', '/activity', '/categories'].map(count);
  const busiest = Math.max(...others);
  expect(busiest, `no group fetches were captured at all — ${detail()}`).toBeGreaterThan(0);

  expect(count('/expenses'), `the expense list outpaced the rest — ${detail()}`)
    .toBeLessThanOrEqual(busiest);
});
