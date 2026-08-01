import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * Opening a group must cost one request per thing it needs, not four.
 *
 * The expense-list effect used to depend on `group` and `feed`, both of which
 * `reload()` sets — so one refresh fetched the list three times: on mount, and
 * again as each of those resolved. The two extras were discarded, and because
 * later responses triggered them they cost sequential round trips rather than
 * running alongside the rest. Invisible on a fast link; a tester in Chile
 * reported the app as laggy.
 *
 * This counts requests instead of measuring time, so it fails for the reason
 * the bug existed rather than on whatever the CI machine's network is doing.
 */
test('opening a group fetches each thing exactly once', async ({ page }) => {
  const calls: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    const u = new URL(route.request().url());
    // Path only: the expense list carries query params, and a cursor or a
    // search term is a legitimately different request.
    calls.push(u.pathname.replace(/\/api\/v1/, ''));
    return route.continue();
  });

  await signUp(page, 'Fetch Count');

  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Group name').fill('Fetch Counting');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name: 'Fetch Counting' })).toBeVisible();

  // Everything before this point is setup; count only the group screen.
  calls.length = 0;
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Fetch Counting').click();
  await expect(page.getByRole('heading', { name: 'Fetch Counting' })).toBeVisible();
  await page.waitForTimeout(1200); // let any late duplicate arrive and be caught

  const count = (needle: string) => calls.filter((c) => c.includes(needle)).length;

  // The one that regressed. Three of these is the bug.
  expect(count('/expenses'), `expense fetches: ${JSON.stringify(calls)}`).toBe(1);

  // The others are already one apiece and must stay that way.
  for (const path of ['/balances', '/totals', '/activity']) {
    expect(count(path), `${path} fetches: ${JSON.stringify(calls)}`).toBe(1);
  }
});
