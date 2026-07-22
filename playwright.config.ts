import { defineConfig } from '@playwright/test';

/**
 * E2E golden path against the real stack: Vite dev server (started here)
 * proxying /api to a PHP server the CI job starts on :8100 with a MySQL
 * service behind it. Locally: `npm run dev` in one shell, then
 * `npx playwright test`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:8000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -w @slytab/web',
    port: 8000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
