import { expect, test } from '@playwright/test';

/**
 * The golden path (requirements §5): sign up → create a group → add an
 * equal-split expense → see it and the balances → save payment handles.
 * Runs against a fresh database, so fixed emails are fine.
 */
test('sign up, create group, add expense, check balances, save profile', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  // --- sign up ---
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Your name').fill('Dave E2E');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('All settled up ✓')).toBeVisible();

  // --- create a group ---
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Name').fill('Cottage E2E');
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
  await page.getByRole('button', { name: '‹' }).click();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByLabel('Interac e-Transfer email').fill('pay-dave@example.com');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeHidden();

  // --- invite link exists ---
  await page.getByText('Cottage E2E').click();
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(/\/join\/[a-f0-9]{32}/)).toBeVisible();
});
