import { writeFileSync } from 'node:fs';
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Bestandsaufnahme "Einladen" im Browser (Ergaenzung zu einladen-bestand.mjs).
 *
 * 1. Was steht im Feld "Eingeladen" des Termin-Editors, ohne dass man sucht?
 * 2. Bleibt die Karte eines Termins in einem gerade NICHT geoeffneten Chat
 *    stehen, wenn anderswo zugesagt wird? (Zwei Karten, ein Termin.)
 */
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;
const OUT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events';

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: { username: `${prefix}${suffix}`, password: 'passwort123', displayName: `${prefix.toUpperCase()} ${suffix}` },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
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

/** Innerhalb der App navigieren, ohne neu zu laden: Der Chat-Speicher bleibt. */
async function imAppWeg(page: Page, pfad: string) {
  await page.evaluate((ziel) => {
    window.history.pushState({}, '', ziel);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, pfad);
}

const als = (s: Sitzung) => ({ authorization: `Bearer ${s.accessToken}` });

test('Einladungsfeld: was steht ohne Suche da', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'eia');
  const b = await registrieren(http, 'eib');
  const c = await registrieren(http, 'eic');
  const d = await registrieren(http, 'eid');
  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: als(a),
      data: { type: 'group', title: 'Gruppe ABC', memberIds: [b.user.id, c.user.id] },
    })
  ).json();
  // D kennt A nur ueber einen Einzelchat: ein "verfuegbarer" Mensch, der in keiner Gruppe steht.
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'direct', memberIds: [d.user.id] } });

  const wurzel = baseURL ?? 'http://localhost:5183';
  const seite = await seiteFuer(browser, a, wurzel);
  await seite.goto(`${wurzel}/kalender`);
  await seite.getByRole('button', { name: /Neuer Termin/ }).first().click();
  const feld = seite.locator('fieldset').filter({ hasText: 'Eingeladen' });
  await expect(feld).toBeVisible();

  const lesen = async () => ({
    zeilen: await feld.locator('.pw-zeile').allInnerTexts(),
    zaehler: (await feld.locator('.pw-zahl').innerText()).trim(),
    hinweis: (await feld.locator('.cal-hint').first().innerText()).trim(),
    suchfeld: await feld.locator('input[type=search]').count(),
    schnellwahl: await feld.locator('button').allInnerTexts(),
  });

  const ohneChat = await lesen();
  await seite.screenshot({ path: `${OUT}/editor-ohne-chat.png`, fullPage: false });
  await seite.locator('#cal-conversation').selectOption({ value: gruppe.id });
  await expect(feld.locator('.pw-zeile').first()).toBeVisible({ timeout: 10_000 });
  const mitGruppe = await lesen();
  await seite.screenshot({ path: `${OUT}/editor-mit-gruppe.png`, fullPage: false });

  const befund = { ohneChat, mitGruppe, dNamen: d.user.displayName };
  writeFileSync(`${OUT}/browser-editor.json`, JSON.stringify(befund, null, 2));
  console.log(JSON.stringify(befund, null, 2));
  await http.dispose();
  await seite.context().close();
});

test('Zwei Karten, ein Termin: die Karte im gerade nicht offenen Chat', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'eka');
  const b = await registrieren(http, 'ekb');
  const gruppe = await (
    await http.post(`${API}/conversations`, {
      headers: als(a),
      data: { type: 'group', title: 'Gruppe AB', memberIds: [b.user.id] },
    })
  ).json();
  const einzel = await (
    await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'direct', memberIds: [b.user.id] } })
  ).json();
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  const termin = await (
    await http.post(`${API}/calendar/events`, {
      headers: als(a),
      data: {
        conversationId: gruppe.id,
        title: `Karten ${Date.now()}`,
        startsAt: beginn.toISOString(),
        endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
      },
    })
  ).json();
  expect(termin.id).toBeTruthy();
  // Zweite Karte, wie sie der Wunsch braucht: derselbe Termin im Einzelchat.
  const zweite = await http.post(`${API}/conversations/${einzel.id}/messages`, {
    headers: als(a),
    data: { type: 'event', metadata: { eventId: termin.id }, clientId: `z-${Date.now()}` },
  });
  expect(zweite.status()).toBe(201);

  const wurzel = baseURL ?? 'http://localhost:5183';
  const seite = await seiteFuer(browser, b, wurzel);
  const zaehler = seite.locator('.cal-bubble-counts');

  // 1. Gruppe oeffnen: die Karte dort zeigt Annas Zusage.
  await imAppWeg(seite, `/chats/${gruppe.id}`);
  await expect(zaehler.first()).toBeVisible({ timeout: 15_000 });
  const gruppeVorher = (await zaehler.first().innerText()).trim();

  // 2. In den Einzelchat wechseln: die Gruppenkarte wird ausgehaengt.
  await imAppWeg(seite, `/chats/${einzel.id}`);
  await expect(zaehler.first()).toBeVisible({ timeout: 15_000 });
  const einzelVorher = (await zaehler.first().innerText()).trim();

  // 3. Anna sagt ab (Zusage ueber den Termin, nicht ueber eine Karte).
  const absage = await http.post(`${API}/calendar/events/${termin.id}/rsvp`, {
    headers: als(a),
    data: { status: 'no' },
  });
  expect(absage.status()).toBe(200);
  await seite.waitForTimeout(1500);
  const einzelNachher = (await zaehler.first().innerText()).trim();

  // 4. Zurueck in die Gruppe – ohne Neuladen der Seite.
  await imAppWeg(seite, `/chats/${gruppe.id}`);
  await expect(zaehler.first()).toBeVisible({ timeout: 15_000 });
  await seite.waitForTimeout(2500);
  const gruppeNachher = (await zaehler.first().innerText()).trim();

  // 5. Zur Gegenprobe ein Neuladen: Jetzt liefert der Server den Stand.
  await seite.reload();
  await expect(zaehler.first()).toBeVisible({ timeout: 15_000 });
  await seite.waitForTimeout(1500);
  const gruppeNachNeuladen = (await zaehler.first().innerText()).trim();

  const befund = { gruppeVorher, einzelVorher, einzelNachher, gruppeNachher, gruppeNachNeuladen };
  writeFileSync(`${OUT}/browser-karten.json`, JSON.stringify(befund, null, 2));
  console.log(JSON.stringify(befund, null, 2));
  await http.dispose();
  await seite.context().close();
});
