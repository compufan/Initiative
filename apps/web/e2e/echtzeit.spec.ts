import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Ohne Zutun aktuell.
 *
 * Der Anwender meldete: „Ausgaben, Events und so weiter muss man immer noch
 * aktiv aktualisieren, damit Änderungen gezeigt werden.“ Für etwas, das zu
 * zweit gepflegt wird, ist das die falsche Voreinstellung – man sieht dann
 * nicht, was der andere gerade eingetragen hat, und trägt es ein zweites Mal.
 *
 * Der Test macht nichts als warten: Er lädt die Seite EINMAL und prüft, ob
 * eine von aussen angelegte Ausgabe von selbst erscheint.
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

async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(wurzel);
  await page.evaluate(
    (werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)),
    {
      accessToken: sitzung.accessToken,
      refreshToken: sitzung.refreshToken,
      expiresAt: Date.now() + 3_600_000,
    },
  );
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

test('eine neue Ausgabe erscheint ohne Neuladen', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const ida = await registrieren(http, 'rta');
  const jan = await registrieren(http, 'rtb');
  const alsIda = { authorization: `Bearer ${ida.accessToken}` };

  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: alsIda,
      data: { type: 'direct', memberIds: [jan.user.id] },
    })
  ).json();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const janPage = await seiteFuer(browser, jan, wurzel);

  // Jan schaut auf die Ausgaben – und lädt danach NIE wieder.
  await janPage.goto(`${wurzel}/ausgaben`);
  await expect(janPage.getByRole('heading', { name: 'Salden' })).toBeVisible({ timeout: 15_000 });

  const titel = `Pizza ${Date.now()}`;
  await http.post(`${API}/expenses`, {
    headers: alsIda,
    data: {
      conversationId: chat.id,
      title: titel,
      amountCents: 2400,
      paidBy: ida.user.id,
      shares: [{ userId: ida.user.id }, { userId: jan.user.id }],
    },
  });

  // Ohne reload(), ohne Klick: sie muss von selbst auftauchen.
  await expect(janPage.getByText(titel)).toBeVisible({ timeout: 20_000 });

  // Und der Saldo rechnet sich mit – 12 Euro von 24.
  await expect(janPage.getByText(/12,00/).first()).toBeVisible({ timeout: 20_000 });

  // Auch das Abhaken kommt an: Ida bestätigt, Jans Ansicht zieht nach.
  const liste = await (
    await http.get(`${API}/expenses?includeSettled=true`, { headers: alsIda })
  ).json();
  const ausgabe = liste.items.find((eintrag: { title: string }) => eintrag.title === titel);
  expect(ausgabe, 'Ausgabe gefunden').toBeTruthy();

  await http.post(`${API}/expenses/${ausgabe.id}/settle`, {
    headers: alsIda,
    data: { userId: jan.user.id, settled: true },
  });

  await expect(janPage.getByText('Bezahlung bestätigt').first()).toBeVisible({ timeout: 20_000 });

  await http.dispose();
  await janPage.context().close();
});
