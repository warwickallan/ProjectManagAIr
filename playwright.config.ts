import { defineConfig } from '@playwright/test';

const serverCommand = process.env.PLAYWRIGHT_DEV_SERVER === '1'
  ? 'node node_modules/tsx/dist/cli.mjs server.ts'
  : 'node node_modules/tsx/dist/cli.mjs server.ts --production';

export default defineConfig({
  testDir: './tests',
  testMatch: 'e2e.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4318',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: serverCommand,
    url: 'http://127.0.0.1:4318/api/health',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
