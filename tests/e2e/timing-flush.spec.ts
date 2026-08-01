import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * The client must actually send its timings (#111).
 *
 * Written because push notifications shipped, were assumed to work, and had
 * never once registered a token — the failure was invisible precisely because
 * nothing checked that the thing being sent arrived. Instrumentation that
 * silently sends nothing is the same mistake in a smaller hat.
 */
test('timings are batched and flushed to the server', async ({ page }) => {
  const posted: unknown[][] = [];
  await page.route('**/api/v1/timings', async (route) => {
    const body = route.request().postDataJSON() as { items?: unknown[] };
    posted.push(body?.items ?? []);
    return route.continue();
  });

  await signUp(page, 'Timing Flush');

  // Wait out the natural 20s flush timer rather than simulating a trigger.
  await expect.poll(() => posted.length, { timeout: 40_000, intervals: [1000] }).toBeGreaterThan(0);

  const items = posted.flat() as { kind: string; name: string; ms: number; status: number }[];
  expect(items.length, 'a flush carried no measurements').toBeGreaterThan(0);

  // Shape the server expects.
  for (const it of items) {
    expect(it.kind).toBe('api');
    expect(typeof it.ms).toBe('number');
    expect(it.name).toMatch(/^(GET|POST|PATCH|DELETE|PUT) \//);
  }

  // The one that would be a bug: measuring the measurements.
  expect(items.some((i) => i.name.includes('/timings')), 'timings measured themselves').toBe(false);

  // Real requests from signing up should be in there.
  expect(items.some((i) => i.name.includes('/auth/register') || i.name.includes('/me'))).toBe(true);
});
