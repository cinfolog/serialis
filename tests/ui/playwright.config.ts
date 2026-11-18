import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['UI_TESTS_PORT'] ?? 4173);
/** Optional: use an already installed browser (e.g. UI_TESTS_BROWSER_CHANNEL=chrome) instead of the bundled Chromium. */
const channel = process.env['UI_TESTS_BROWSER_CHANNEL'];
const executablePath = process.env['UI_TESTS_BROWSER_PATH'];

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'fr-FR',
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
    env: { UI_TESTS_PORT: String(port) },
  },
});
