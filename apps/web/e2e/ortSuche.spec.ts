import { expect, request, test, type Page } from '@playwright/test';

/**
 * Die Ortssuche beim Tippen im Terminblatt.
 *
 * Der Suchdienst ist abgefangen: Der Test prüft die Verdrahtung (Tippen,
 * Wartezeit, Liste, Tastatur, Übernahme, Fehlerfall), nicht OpenStreetMap.
 * Die Sortierung und das Lesen der Antwort stehen in `modules/orte.rs`.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

const TREFFER = [
  {
    text: 'Willy-Brandt-Platz, 64293 Darmstadt',
    titel: 'Willy-Brandt-Platz',
    zeile: '64293 Darmstadt',
    lat: 49.876,
    lon: 8.65,
    land: 'DE',
  },
  {
    text: 'Hauptbahnhof, Willy-Brandt-Platz 1, 38102 Braunschweig',
    titel: 'Hauptbahnhof',
    zeile: 'Willy-Brandt-Platz 1, 38102 Braunschweig',
    lat: 52.25,
    lon: 10.54,
    land: 'DE',
  },
];

async function anmelden(page: Page, wurzel: string) {
  const http = await request.newContext();
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: { username: `orts${suffix}`, password: 'passwort123', displayName: `Orts ${suffix}` },
  });
  expect(antwort.ok()).toBeTruthy();
  const sitzung = await antwort.json();
  await http.dispose();
  await page.goto(wurzel);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    {
      accessToken: sitzung.accessToken,
      refreshToken: sitzung.refreshToken,
      expiresAt: Date.now() + 3_600_000,
    },
  );
}

async function blattOeffnen(page: Page, wurzel: string) {
  await anmelden(page, wurzel);
  await page.goto(`${wurzel}/kalender`);
  await page.getByRole('button', { name: /Neuer Termin/ }).click();
}

test('„Willy“ schlägt Orte vor, die Übernahme setzt die Zeile ins Feld', async ({
  page,
  baseURL,
}) => {
  const anfragen: string[] = [];
  await page.route('**/orte/suche*', async (route) => {
    anfragen.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    await route.fulfill({
      json: { items: TREFFER, quelle: '© OpenStreetMap-Mitwirkende' },
    });
  });
  await blattOeffnen(page, baseURL ?? 'http://localhost:5173');

  const feld = page.locator('#cal-location');
  await expect(feld).toHaveAttribute('role', 'combobox');
  await feld.pressSequentially('Willy', { delay: 40 });

  const liste = page.getByRole('listbox', { name: 'Ortsvorschläge' });
  await expect(liste).toBeVisible();
  await expect(liste.getByRole('option')).toHaveCount(2);
  await expect(liste).toContainText('© OpenStreetMap-Mitwirkende');
  // Eine Anfrage für das fertig getippte Wort, nicht eine je Buchstabe.
  expect(anfragen).toEqual(['Willy']);

  await feld.press('ArrowDown');
  await expect(liste.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await feld.press('Enter');
  await expect(feld).toHaveValue('Willy-Brandt-Platz, 64293 Darmstadt');
  await expect(liste).toBeHidden();
  await expect(page.locator('#cal-location-hint')).toContainText('Ort aus der Kartensuche');

  // Die Übernahme sucht nicht von vorn.
  await page.waitForTimeout(600);
  expect(anfragen).toEqual(['Willy']);
});

test('Escape schliesst nur die Liste, Webadressen gehen nicht an den Suchdienst', async ({
  page,
  baseURL,
}) => {
  const anfragen: string[] = [];
  await page.route('**/orte/suche*', async (route) => {
    anfragen.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    await route.fulfill({ json: { items: TREFFER, quelle: '© OpenStreetMap-Mitwirkende' } });
  });
  await blattOeffnen(page, baseURL ?? 'http://localhost:5173');
  const feld = page.locator('#cal-location');

  await feld.fill('https://zoom.us/j/123456789');
  await page.waitForTimeout(700);
  expect(anfragen).toEqual([]);

  await feld.fill('64293 Darmstadt Willy');
  const liste = page.getByRole('listbox', { name: 'Ortsvorschläge' });
  await expect(liste).toBeVisible();
  await feld.press('Escape');
  await expect(liste).toBeHidden();
  await expect(feld).toHaveValue('64293 Darmstadt Willy');
  // Das Blatt ist noch da.
  await expect(page.locator('#cal-title')).toBeVisible();
});

test('fällt der Suchdienst aus, bleibt das Feld ein Textfeld', async ({ page, baseURL }) => {
  await page.route('**/orte/suche*', (route) =>
    route.fulfill({
      status: 502,
      json: { error: { code: 'upstream_unavailable', message: 'Die Ortssuche ist gerade nicht erreichbar.' } },
    }),
  );
  await blattOeffnen(page, baseURL ?? 'http://localhost:5173');
  const feld = page.locator('#cal-location');
  await feld.fill('Stadtpark, Eingang Nord');
  await page.waitForTimeout(700);
  await expect(page.getByRole('listbox', { name: 'Ortsvorschläge' })).toBeHidden();
  await expect(feld).toHaveValue('Stadtpark, Eingang Nord');
});
