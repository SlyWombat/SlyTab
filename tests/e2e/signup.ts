import { expect, type Page } from '@playwright/test';

/**
 * Sign up and land on Home.
 *
 * Two screens, not one: creating the account drops you on the first-run
 * welcome (#36), which every test has to walk through before it can see
 * anything else. Keeping that here means a change to the welcome screen
 * breaks one function rather than every spec.
 */
export async function signUp(page: Page, name: string) {
  const email = `e2e-${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}@example.com`;

  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  // First run: name and home currency are prefilled, so this is one press.
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByText('All settled up')).toBeVisible();

  return email;
}
