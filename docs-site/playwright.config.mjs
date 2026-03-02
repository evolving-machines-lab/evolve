import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'visual.spec.mjs',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3457',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx serve out -l 3457 --no-clipboard',
    port: 3457,
    reuseExistingServer: !process.env.CI,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: './test-results',
});
