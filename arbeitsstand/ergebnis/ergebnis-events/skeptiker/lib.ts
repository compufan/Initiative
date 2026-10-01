import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
export const API = `${API_URL}/api/v1`;

export interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; username: string };
}

export async function registrieren(http: APIRequestContext, prefix: string, anzeige?: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: {
      username: `${prefix}${suffix}`,
      password: 'passwort123',
      displayName: anzeige ?? `${prefix.toUpperCase()} ${suffix}`,
    },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

export async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string, breite = 1280, hoehe = 900): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: breite, height: hoehe } });
  const page = await ctx.newPage();
  await page.goto(wurzel);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

export const als = (s: Sitzung) => ({ authorization: `Bearer ${s.accessToken}` });
