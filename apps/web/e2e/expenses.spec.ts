import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Ausgaben durch die echte Oberfläche.
 *
 * Der Kern sind zwei Dinge, die man nur am laufenden System sieht: dass die
 * Aufteilung **vorgerechnet** wird, bevor gespeichert wird, und dass ein
 * Geschenk vor dem Beschenkten wirklich unsichtbar bleibt – auch in seinem
 * Saldo.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: {
      username: `${prefix}${suffix}`,
      password: 'passwort123',
      displayName: `${prefix.toUpperCase()} ${suffix}`,
    },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(baseURL);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

test('Ausgabe teilen, Saldo sehen, Geschenk verbergen', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'anna');
  const ben = await registrieren(http, 'ben');
  const cem = await registrieren(http, 'cem');

  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: { authorization: `Bearer ${anna.accessToken}` },
      data: {
        type: 'group',
        title: `Kasse ${Date.now()}`,
        memberIds: [ben.user.id, cem.user.id],
      },
    })
  ).json();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const annaPage = await seiteFuer(browser, anna, wurzel);
  const cemPage = await seiteFuer(browser, cem, wurzel);

  // ---- Anna trägt 10 € für drei ein --------------------------------------
  await annaPage.goto(`${wurzel}/ausgaben`);
  await annaPage.getByRole('button', { name: 'Ausgabe eintragen' }).first().click();
  await annaPage.locator('#exp-title').fill('Getränke');
  await annaPage.locator('#exp-amount').fill('10,00');
  await annaPage.locator('#exp-chat').selectOption({ label: gruppe.title });

  // Genau der Punkt: 10 Euro auf drei sind 3,34 + 3,33 + 3,33 – vorgerechnet,
  // bevor gespeichert wird, nicht hinterher erklärt.
  await expect(annaPage.getByText(/Aufgeteilt: 3,34/)).toBeVisible({ timeout: 15_000 });

  await annaPage.getByRole('button', { name: 'Speichern' }).click();
  await expect(annaPage.getByText('Getränke')).toBeVisible({ timeout: 15_000 });

  // ---- Cem sieht, dass er Anna etwas schuldet ----------------------------
  await cemPage.goto(`${wurzel}/ausgaben`);
  await expect(cemPage.getByText(/Du schuldest/)).toBeVisible({ timeout: 15_000 });
  await expect(cemPage.getByText(/3,3\d\s*€/).first()).toBeVisible();

  // ---- Das Geschenk: Anna und Ben legen für Cem zusammen -----------------
  await http.post(`${API}/expenses`, {
    headers: { authorization: `Bearer ${anna.accessToken}` },
    data: {
      conversationId: gruppe.id,
      title: 'Geschenk für Cem',
      amountCents: 6000,
      shares: [{ userId: anna.user.id }, { userId: ben.user.id }],
      hiddenFromIds: [cem.user.id],
    },
  });

  // Anna sieht es …
  await annaPage.reload();
  await expect(annaPage.getByText('Geschenk für Cem')).toBeVisible({ timeout: 15_000 });

  // … Cem nicht. Weder in der Liste …
  await cemPage.reload();
  await expect(cemPage.getByText('Getränke')).toBeVisible({ timeout: 15_000 });
  await expect(cemPage.getByText('Geschenk für Cem')).toHaveCount(0);

  // … noch in seinem Saldo: der bleibt bei seinem Getränkeanteil.
  const saldoText = await cemPage.locator('.exp-summe').innerText();
  expect(saldoText).toMatch(/Du schuldest 3,3\d/);

  await http.dispose();
});
