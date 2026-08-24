import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/** Lädt die `.env` aus dem Repo-Wurzelverzeichnis, damit die API startklar ist. */
function rootEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
    return Object.fromEntries(
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

/**
 * Browser-Tests gegen den echten Stack: Rust-API + PWA.
 *
 * Beide Dienste werden bei Bedarf gestartet; laufen sie schon, werden sie
 * wiederverwendet. Die API braucht eine erreichbare Postgres-Datenbank
 * (DATABASE_URL, siehe .env).
 */
/**
 * Chromium-Pfad.
 *
 * Manche CI-Images bringen Chromium schon mit (PLAYWRIGHT_BROWSERS_PATH); dann
 * passt die Build-Nummer nicht zwangsläufig zur Playwright-Version, weshalb der
 * Pfad hier direkt gesetzt wird. Ohne Fund lädt Playwright wie üblich selbst.
 */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const candidate = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .map((entry) => resolve(root, entry, 'chrome-linux/chrome'))
    .find((path) => existsSync(path));
  return candidate;
}

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Kamera und Mikrofon ohne Nachfrage, damit Aufnahme-Dialoge testbar sind.
    permissions: ['camera', 'microphone'],
    launchOptions: {
      executablePath: chromiumPath(),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Ein echtes Mobilprofil – die App ist mobile first.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: [
    {
      command: 'cargo run --manifest-path ../../apps/api/Cargo.toml --bin initiative-api',
      url: `${API_URL}/healthz`,
      env: { ...rootEnv(), ...process.env } as Record<string, string>,
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm dev',
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
