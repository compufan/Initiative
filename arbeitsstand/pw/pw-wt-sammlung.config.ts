import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/wt-sammlung/apps/web/e2e',
  outputDir: '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-sammlung/test-results',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5195' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: '/opt/pw-browsers/chromium' } },
    },
  ],
});
