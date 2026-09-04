import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Ereignisse im Kalendertab.
 *
 * Geprüft wird das, was neu ist: ein Termin, dessen Zeitpunkt noch abgestimmt
 * wird, steht mit dem Vermerk „in Abstimmung“ im Kalender; die Abstimmung
 * läuft in mehreren Chats mit **einem** Ergebnis; Notizen richten sich nach
 * ihrer eigenen Rechteangabe.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  username: string;
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const daten = {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
  const antwort = await http.post(`${API}/auth/register`, { data: daten });
  expect(antwort.ok(), `Registrierung ${daten.username}: ${antwort.status()}`).toBeTruthy();
  return { ...(await antwort.json()), username: daten.username };
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

test('Termin abstimmen, Zeitpunkt festlegen, Notiz mit eigenen Rechten', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'anna');
  const ben = await registrieren(http, 'ben');
  const alsAnna = { authorization: `Bearer ${anna.accessToken}` };

  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: alsAnna,
      data: { type: 'group', title: `Runde ${Date.now()}`, memberIds: [ben.user.id] },
    })
  ).json();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const annaPage = await seiteFuer(browser, anna, wurzel);
  const benPage = await seiteFuer(browser, ben, wurzel);

  // ---- Anna legt einen Termin zur Abstimmung an --------------------------
  await annaPage.goto(`${wurzel}/kalender`);
  await annaPage.getByRole('button', { name: /Abstimmen/ }).click();

  const titel = `Grillabend ${Date.now()}`;
  await annaPage.locator('#plan-title').fill(titel);
  await annaPage.locator('#plan-chat').selectOption({ label: gruppe.title });

  // Zwei Vorschläge sind vorbelegt; der zweite bekommt ein festes Datum,
  // damit der Test nachher weiss, worauf er prüft. Bewusst innerhalb der
  // nächsten 60 Tage – nur so weit reicht die Agenda.
  const zweiterTag = new Date();
  zweiterTag.setDate(zweiterTag.getDate() + 20);
  const tagesteil = `${zweiterTag.getFullYear()}-${String(zweiterTag.getMonth() + 1).padStart(2, '0')}-${String(zweiterTag.getDate()).padStart(2, '0')}`;
  await annaPage.getByLabel('Vorschlag 2, Beginn').fill(`${tagesteil}T18:00`);
  await annaPage.getByLabel('Vorschlag 2, Ende').fill(`${tagesteil}T22:00`);

  await annaPage.getByRole('button', { name: 'Abstimmen lassen' }).click();

  // Danach steht man im Termin, und die Abstimmung ist da.
  await expect(annaPage.getByText('Zeitpunkt wird abgestimmt')).toBeVisible({ timeout: 15_000 });
  await expect(annaPage.getByRole('heading', { name: titel }).first()).toBeVisible();

  // ---- Der Termin steht im Kalender, als „in Abstimmung“ -----------------
  await benPage.goto(`${wurzel}/kalender`);
  await benPage.getByRole('tab', { name: 'Agenda' }).click();
  await expect(benPage.getByText(titel)).toBeVisible({ timeout: 15_000 });
  await expect(benPage.getByText('in Abstimmung').first()).toBeVisible();

  // ---- Ben stimmt ab, Anna sieht es --------------------------------------
  await benPage.getByText(titel).click();
  await expect(benPage.getByText('Zeitpunkt wird abgestimmt')).toBeVisible({ timeout: 15_000 });
  const zweiterVorschlag = benPage.locator('.cal-poll-option').nth(1);
  await zweiterVorschlag.getByRole('button', { name: /Passt$/ }).click();
  await expect(zweiterVorschlag.getByText('✅ 1')).toBeVisible({ timeout: 15_000 });

  // ---- Anna legt den Zeitpunkt fest --------------------------------------
  await annaPage.reload();
  const annasZweiter = annaPage.locator('.cal-poll-option').nth(1);
  await expect(annasZweiter.getByText('✅ 1')).toBeVisible({ timeout: 15_000 });
  await annasZweiter.getByRole('button', { name: 'Diesen nehmen' }).click();

  // Der Termin rückt an seinen Platz – und es entsteht kein zweiter.
  await expect(annaPage.getByText('Zeitpunkt wird abgestimmt')).toHaveCount(0, { timeout: 15_000 });
  await annaPage.goto(`${wurzel}/kalender`);
  await annaPage.getByRole('tab', { name: 'Agenda' }).click();
  await expect(annaPage.getByText(titel)).toHaveCount(1, { timeout: 15_000 });
  await expect(annaPage.getByText('in Abstimmung')).toHaveCount(0);

  // ---- Notiz mit eigenen Rechten -----------------------------------------
  await annaPage.getByText(titel).click();
  // Seit Notizen und Listen getrennt sind, gibt es zwei Knoepfe statt einem.
  // Hier ist ein Text gemeint, also „Notiz“.
  await annaPage.getByRole('button', { name: 'Notiz', exact: true }).click();
  await annaPage.locator('#note-title-neu').fill('Ansprache');
  await annaPage.locator('#note-body-neu').fill('Erst Rede, dann Essen.');
  // Voreinstellung ist „Nur ich“.
  await annaPage.getByRole('button', { name: 'Speichern' }).click();
  await expect(annaPage.getByText('Erst Rede, dann Essen.')).toBeVisible({ timeout: 15_000 });

  // Ben sieht sie, darf sie aber nicht ändern.
  await benPage.reload();
  await expect(benPage.getByText('Erst Rede, dann Essen.')).toBeVisible({ timeout: 15_000 });
  await expect(benPage.getByRole('button', { name: 'Bearbeiten' })).toHaveCount(0);

  await http.dispose();
});
