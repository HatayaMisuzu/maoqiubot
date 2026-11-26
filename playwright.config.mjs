import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    viewport: { width: 1280, height: 840 },
    channel: process.env.MAOQIU_E2E_BROWSER_CHANNEL || undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  forbidOnly: !!process.env.CI
});
