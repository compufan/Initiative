import { defineConfig, devices } from '@playwright/test';

/** Prüfgerüst für „mehrere Bereiche im Video" – liegt ausserhalb des Repos, spricht den Vite-Server auf 5193 an. */
export default defineConfig({
  testDir: '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-bereiche/pruef',
  outputDir: '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-bereiche/pruef/test-results',
  timeout: 900_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5193' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: '/opt/pw-browsers/chromium' } },
    },
  ],
});
