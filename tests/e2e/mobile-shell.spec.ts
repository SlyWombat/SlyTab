import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * The bottom of a phone-width browser is shared by three fixed things — the
 * nav bar, the FAB and any open sheet — and nothing measures the others by
 * itself. That is what put the bar on top of the "Add expense" button, and
 * then on top of every sheet's primary action (reported 2026-07-31).
 *
 * So this locks the edge rather than the pixels: who clears whom, and who
 * paints on top. `--ss-navbar-h` in styles/index.css is one side of a
 * contract, and this is what fails when someone changes the other.
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** What the user would actually touch at the centre of `box`. */
async function topmostAt(page: import('@playwright/test').Page, box: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return {
      label: el?.closest('button')?.textContent?.trim() ?? null,
      layer: el?.closest('.sheet, .sheet-back, .railnav, .fab')?.className ?? null,
    };
  }, [box.x + box.width / 2, box.y + box.height / 2]);
}

test('the bottom bar does not cover the add-expense button', async ({ page }) => {
  await signUp(page, 'Mobile E2E');

  const bar = page.getByRole('navigation', { name: 'Main' });
  const fab = page.getByRole('button', { name: 'Add expense' });
  const barBox = (await bar.boundingBox())!;
  const fabBox = (await fab.boundingBox())!;

  // Every pixel of the button, label included, sits above the bar.
  expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(barBox.y);
  // And nothing is painted over it.
  expect((await topmostAt(page, fabBox)).label).toContain('Add expense');
});

test('a sheet covers the bottom bar, not the other way round', async ({ page }) => {
  await signUp(page, 'Sheet E2E');

  await page.getByRole('button', { name: 'New group' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();

  // The sheet's primary action is the thing the bar used to sit on.
  const submit = sheet.getByRole('button', { name: 'Create group' });
  await expect(submit).toBeVisible();
  expect((await topmostAt(page, (await submit.boundingBox())!)).label).toContain('Create group');

  // A destination in the bar is under the modal layer while the sheet is
  // open: the scrim or the sheet takes the touch, never the tab.
  const tab = page.getByRole('button', { name: 'Groups', exact: true });
  expect((await topmostAt(page, (await tab.boundingBox())!)).layer).not.toContain('railnav');
});
