import { expect, test } from '@playwright/test';
import { signUp } from './signup';

/**
 * A scan that reads the lines but finds no printed total must fill the amount
 * from the lines and say that it did.
 *
 * The payload below is verbatim from a real scan (a card statement photographed
 * as a receipt, 2026-08-01): three charge lines, `totalMinor: null`. Before the
 * fix the amount stayed at zero and nothing was shown, which read as the scan
 * having failed outright.
 *
 * The upload is stubbed rather than really scanned — the parser is a vision
 * model on our own server and is neither available nor deterministic here. What
 * is being tested is what the client does with an answer of this shape.
 */
const PARSED = {
  date: '2023-08-01',
  scale: 1,
  currency: 'CLP',
  merchant: 'Marriott',
  taxMinor: null,
  tipMinor: null,
  confidence: 'low',
  totalMinor: null,
  subtotalMinor: null,
  items: [
    { name: 'SERV RECA FONDOS AN...', quantity: 1, totalMinor: 28000 },
    { name: 'MERCADOPAGO*CLUBLA...', quantity: 1, totalMinor: 23100 },
    { name: 'MERCADOPAGO*CLUBLA...', quantity: 1, totalMinor: 60000 },
  ],
};

test('a scan with no printed total fills in the line sum and says so', async ({ page }) => {
  await page.route('**/api/v1/groups/*/receipts', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: '01KYYZQ98DZ06AKN5Z6M4A2P7F', parsed: PARSED, parseError: null }),
    }));

  await signUp(page, 'Scan Note');
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Scan Group');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name: 'Scan Group' })).toBeVisible();

  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByRole('button', { name: /Scan receipt/ }).click();
  await page.setInputFiles('input[type="file"]', {
    name: 'statement.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
  });

  // The amount comes from the lines: 28000 + 23100 + 60000, CLP being
  // zero-decimal so minor units are whole pesos.
  await expect(page.locator('input.amt').first()).toHaveValue(/111,?100/);

  // And it must say where that number came from, rather than presenting a
  // figure we invented as though it had been read off the receipt.
  // Scoped to the notice: the figure also appears in the amount field, and an
  // unscoped match would pass on that alone — which would defeat the point.
  const notice = page.getByText(/could not find a printed total/i);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/111,?100/);
  await expect(notice).toContainText(/3 lines/);
});
