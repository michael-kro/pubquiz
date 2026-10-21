// The browser tour: `npm run test:browser`. Needs `npx playwright install chromium` once.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: 'test-results/report' }]] : 'list',
  outputDir: 'test-results/playwright',
  expect: { timeout: 10_000 },
  use: { browserName: 'chromium', trace: 'retain-on-failure', actionTimeout: 10_000, navigationTimeout: 20_000 },
});
