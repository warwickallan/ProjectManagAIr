import { defineConfig } from '@playwright/test';

const node = JSON.stringify(process.execPath);
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4318);
const baseURL = `http://127.0.0.1:${port}`;
const serverCommand = process.env.PLAYWRIGHT_DEV_SERVER === '1'
  ? `${node} node_modules/tsx/dist/cli.mjs scripts/start-e2e-server.ts`
  : `${node} node_modules/tsx/dist/cli.mjs scripts/start-e2e-server.ts --production`;

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e.spec.ts', 'sourceIntelligence.e2e.spec.ts', 'promptsAndConsultantView.e2e.spec.ts'],
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: serverCommand,
    url: `${baseURL}/api/health`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
    timeout: 120000,
  },
});
