import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Dateien & Sammlungen durch die echte Oberfläche.
 *
 * Der Kern ist nicht, dass etwas ankommt, sondern **wer was darf**. Deshalb
 * prüft dieser Test vor allem die Grenze: Anna sieht Bens Sammlung, weil beide
 * im selben Chat sind – und darf sie trotzdem nicht löschen.
 *
 * Chat und Anhang werden über die API vorbereitet. Das Verschicken von Dateien
 * hat mit `messenger.spec.ts` einen eigenen Test; hier soll nur das
 * Hinzufügen aus dem Chat und die Rechteansicht geprüft werden, und ein
 * Umweg über den Dateiwähler würde diesen Test nur brüchig machen.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

/** 1×1 transparentes PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  username: string;
}

function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const daten = credentials(prefix);
  const antwort = await http.post(`${API}/auth/register`, { data: daten });
  expect(antwort.ok(), `Registrierung ${daten.username}: ${antwort.status()}`).toBeTruthy();
  return { ...(await antwort.json()), username: daten.username };
}

/** Eine angemeldete Seite, ohne den Anmeldebildschirm durchzuklicken. */
async function seiteFuer(browser: Browser, sitzung: Sitzung, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(baseURL);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    {
      accessToken: sitzung.accessToken,
      refreshToken: sitzung.refreshToken,
      expiresAt: Date.now() + 3_600_000,
    },
  );
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

/**
 * Langes Antippen auf einer Nachricht.
 *
 * Die Handler hängen an `.msg-col`; ein Klick reicht nicht, es braucht die
 * Pause zwischen Drücken und Loslassen.
 */
async function langAntippen(page: Page, text: string) {
  const blase = page.locator('.msg-col').filter({ hasText: text }).first();
  await expect(blase).toBeVisible({ timeout: 15_000 });
  const kasten = await blase.boundingBox();
  if (!kasten) throw new Error('Die Nachricht hat keine Fläche');
  await page.mouse.move(kasten.x + kasten.width / 2, kasten.y + kasten.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

test('eine Datei aus dem Chat in eine Sammlung legen', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'anna');
  const ben = await registrieren(http, 'ben');
  const alsAnna = { authorization: `Bearer ${anna.accessToken}` };

  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: alsAnna,
      data: { type: 'direct', memberIds: [ben.user.id] },
    })
  ).json();

  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: alsAnna,
      data: { kind: 'image', mime: 'image/png', size: PNG.length, fileName: 'urlaub.png' },
    })
  ).json();
  const hoch = await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: alsAnna,
    multipart: { file: { name: 'urlaub.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(hoch.ok(), `Hochladen: ${hoch.status()}`).toBeTruthy();
  await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: alsAnna,
    data: { width: 1, height: 1 },
  });
  await http.post(`${API}/conversations/${chat.id}/messages`, {
    headers: alsAnna,
    data: { type: 'image', body: 'Vom Urlaub', attachmentIds: [upload.attachmentId] },
  });

  const wurzel = baseURL ?? 'http://localhost:5173';
  const annaPage = await seiteFuer(browser, anna, wurzel);
  const benPage = await seiteFuer(browser, ben, wurzel);

  // ---- Ben legt die Datei aus dem Chat in eine neue Sammlung --------------
  await benPage.goto(`${wurzel}/chats/${chat.id}`);
  await langAntippen(benPage, 'Vom Urlaub');

  await benPage.getByText('Zur Sammlung hinzufügen').click();
  await benPage.getByText('Neue Sammlung anlegen').click();
  const name = `Urlaubsbilder ${Date.now()}`;
  await benPage.locator('#col-name').fill(name);
  await benPage.getByRole('button', { name: 'Speichern' }).click();
  await expect(benPage.getByText('Zur Sammlung hinzugefügt.')).toBeVisible({ timeout: 15_000 });

  // ---- Ben besitzt sie ---------------------------------------------------
  await benPage.goto(`${wurzel}/dateien`);
  await expect(benPage.getByText(name)).toBeVisible({ timeout: 15_000 });
  await benPage.getByText(name).click();
  await expect(benPage.getByText('urlaub.png').first()).toBeVisible({ timeout: 15_000 });
  await expect(benPage.getByRole('button', { name: 'Löschen' })).toBeVisible();

  // ---- Anna kommt über den Chat hinein, ohne eigenes Recht ---------------
  await annaPage.goto(`${wurzel}/dateien`);
  await expect(annaPage.getByText(name)).toBeVisible({ timeout: 15_000 });
  await annaPage.getByText(name).click();
  await expect(annaPage.getByText('urlaub.png').first()).toBeVisible({ timeout: 15_000 });
  await expect(annaPage.getByText('ansehen und ändern')).toBeVisible();
  // Aber löschen darf sie nicht: die Sammlung gehört Ben.
  await expect(annaPage.getByRole('button', { name: 'Löschen' })).toHaveCount(0);

  await http.dispose();
});
