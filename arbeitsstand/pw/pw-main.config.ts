import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '/home/user/Initiative/apps/web/e2e',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5183' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: '/opt/pw-browsers/chromium' } },
    },
  ],
});
