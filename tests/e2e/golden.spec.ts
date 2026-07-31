import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * The golden path (requirements §5): sign up → create a group → add an
 * equal-split expense → see it and the balances → save payment handles.
 * Runs against a fresh database, so fixed emails are fine.
 */
test('sign up, create group, add expense, check balances, save profile', async ({ page }) => {
  // --- sign up ---
  await signUp(page, 'Dave E2E');

  // --- create a group ---
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Cottage E2E');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name: 'Cottage E2E' })).toBeVisible();

  // --- add an expense (solo equal split) ---
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount').fill('82.10');
  await page.getByLabel('Description').fill('Groceries');
  await page.getByRole('button', { name: 'Save expense' }).click();
  await expect(page.getByText('Groceries')).toBeVisible();
  await expect(page.getByText('Dave E2E paid', { exact: false })).toBeVisible();

  // --- balances: solo payer+sharer nets to settled ---
  await page.getByRole('tab', { name: 'Balances' }).click();
  await expect(page.getByText('Everyone is settled up ✓')).toBeVisible();

  // --- profile: save a payment handle ---
  // Home also has a Profile chip in its header, so navigate by the shell.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await page.getByRole('button', { name: 'Back' }).click();
  await nav.getByRole('button', { name: 'Profile' }).click();
  await page.getByLabel('Interac e-Transfer email').fill('pay-dave@example.com');
  await page.getByRole('button', { name: 'Save profile' }).click();
  // Profile is a destination now, not a sheet that closes on save (#103), so
  // the proof it saved is that it comes back after a reload.
  await page.reload();
  await nav.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByLabel('Interac e-Transfer email')).toHaveValue('pay-dave@example.com');

  // --- invite link exists ---
  await nav.getByRole('button', { name: 'Home' }).click();
  await page.getByText('Cottage E2E').click();
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(/\/join\/[a-f0-9]{32}/)).toBeVisible();
});
