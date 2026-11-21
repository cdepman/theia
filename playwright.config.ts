import { defineConfig, devices } from '@playwright/test';

// End-to-end smoke tests run against tests/e2e/harness.ts: the built app, the real gate and
// API, and an in-process Postgres seeded through the real pipeline with recorded feed metadata.
// Build first: `npm run build && npm run test:e2e`.
// Uses an installed Chrome (channel: 'chrome'); set PW_CHROMIUM=1 to use Playwright's own Chromium.
const channel = process.env.PW_CHROMIUM ? undefined : 'chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', channel, launchOptions: { args: ['--no-sandbox'] } },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
  ],
  webServer: {
    command: 'npx tsx tests/e2e/harness.ts',
    url: 'http://127.0.0.1:4173/auth/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { E2E_EMPTY_COUNTRY: '' },
  },
});
