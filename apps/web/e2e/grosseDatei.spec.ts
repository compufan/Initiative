import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Eine grosse Datei durch die echte Oberfläche – in Stücken, mit Abriss.
 *
 * Was hier zählt:
 *
 *   1. Eine Datei von 300 MB geht über den Dateiwähler hinaus, und die Blase
 *      zeigt Fortschritt und den Hinweis, dass die App offen bleiben muss.
 *   2. Reisst das Netz mittendrin ab (hier: jede Stück-Anfrage scheitert ein
 *      paar Sekunden lang), geht es danach weiter – ohne schon empfangene
 *      Stücke noch einmal zu schicken.
 *   3. Nach einem Neuladen der Seite (die Datei liegt bewusst NICHT in
 *      IndexedDB) bittet die Blase um die Datei, und der Upload setzt dort
 *      fort, wo der Server steht.
 *   4. Beim Empfänger kommt Byte für Byte dieselbe Datei an (sha256), und ein
 *      Sprung mitten hinein (`Range`, wie beim Spulen eines Videos) liefert
 *      genau den Ausschnitt – ohne dass der Service Worker die Datei ablegt.
 *
 * Die Testdatei liegt im Temp-Verzeichnis und ist danach weg. `GROSS_MB`
 * setzt die Grösse für einen Lauf von Hand.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;
const MB = 1024 * 1024;
const GROESSE = Number(process.env.GROSS_MB ?? 300) * MB;
const STUECK = 8 * MB;

let ordner = '';
let pfad = '';
let pruefsumme = '';

test.beforeAll(async () => {
  ordner = mkdtempSync(join(process.env.GROSS_ORDNER ?? tmpdir(), 'initiative-gross-'));
  pfad = join(ordner, 'grosser-film.mp4');
  const hasher = createHash('sha256');
  const aus = createWriteStream(pfad);
  for (let geschrieben = 0; geschrieben < GROESSE;) {
    const stueck = randomBytes(Math.min(4 * MB, GROESSE - geschrieben));
    // Wie ein MP4 anfangen – dann ist auch der Typ beim Ausliefern echt.
    if (geschrieben === 0) stueck.set(Buffer.from('ftypisom'), 4);
    hasher.update(stueck);
    if (!aus.write(stueck)) await new Promise<void>((r) => aus.once('drain', () => r()));
    geschrieben += stueck.length;
  }
  await new Promise<void>((fertig, fehler) =>
    aus.end((e?: Error | null) => (e ? fehler(e) : fertig())),
  );
  pruefsumme = hasher.digest('hex');
});

test.afterAll(() => {
  if (ordner) rmSync(ordner, { recursive: true, force: true });
});

interface Sitzung {
  accessToken: string;
  user: { id: string; displayName: string };
  username: string;
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const daten = {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix} ${suffix}`,
  };
  const antwort = await http.post(`${API}/auth/register`, { data: daten });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return { ...(await antwort.json()), username: daten.username };
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(wurzel);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

test('300 MB in Stücken: Abriss, Neuladen, Fortsetzen – und beim Empfänger dieselben Bytes', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(600_000);
  const http = await request.newContext();
  const anna = await registrieren(http, 'anna');
  const ben = await registrieren(http, 'ben');
  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: { authorization: `Bearer ${anna.accessToken}` },
      data: { type: 'direct', memberIds: [ben.user.id] },
    })
  ).json();

  const wurzel = baseURL ?? 'http://localhost:5173';
  const page = await seiteFuer(browser, anna, wurzel);

  // Jede erfolgreich angenommene Stück-Anfrage, nach Bereich gezählt.
  const angenommen = new Map<string, number>();
  const zaehlen = (p: Page) =>
    p.on('response', (antwort) => {
      const anfrage = antwort.request();
      if (anfrage.method() !== 'PUT' || !anfrage.url().includes('/media/stuecke/')) return;
      if (antwort.status() !== 200) return;
      const bereich = anfrage.headers()['content-range'] ?? '?';
      angenommen.set(bereich, (angenommen.get(bereich) ?? 0) + 1);
    });
  zaehlen(page);

  // Nach dem achten Stück reisst das Netz für ein paar Sekunden ab.
  let netzWeg = false;
  await page.route('**/api/v1/media/stuecke/**', async (route) => {
    if (netzWeg && route.request().method() === 'PUT') {
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  await page.goto(`${wurzel}/chats/${chat.id}`);
  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await page.getByText('Datei', { exact: true }).click();
  await page.locator('input[type=file]').first().setInputFiles(pfad);
  // Der ehrliche Hinweis schon beim Wählen.
  await expect(page.getByText(/Bitte die App offen lassen/).first()).toBeVisible();
  await page.locator('.btn-primary').getByText('Senden', { exact: true }).click();

  // Fortschritt in der Blase.
  const fortschritt = page.locator('.media-upload-text').first();
  await expect(fortschritt).toContainText('%', { timeout: 60_000 });
  await expect(page.locator('.media-upload-hinweis').first()).toContainText('App offen lassen');

  await expect.poll(() => angenommen.size, { timeout: 120_000 }).toBeGreaterThanOrEqual(8);
  netzWeg = true;
  await page.waitForTimeout(4_000);
  netzWeg = false;

  // Weiter bis gut zur Hälfte – dann die Seite neu laden.
  const anzahl = Math.ceil(GROESSE / STUECK);
  await expect
    .poll(() => angenommen.size, { timeout: 240_000 })
    .toBeGreaterThanOrEqual(Math.floor(anzahl / 2));
  await page.reload();

  // Die Datei lag nur im Speicher des Tabs – die Blase bittet um sie.
  await expect(page.getByText(/noch einmal aus – der Upload geht dort weiter/).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  const vorDemNeuwaehlen = angenommen.size;
  const waehler = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Datei wählen' }).first().click();
  await (await waehler).setFiles(pfad);

  // Fertig: Die Dateiblase mit „Herunterladen" ersetzt die wartende.
  await expect(
    page.locator('.media-file-name').filter({ hasText: 'grosser-film.mp4' }).first(),
  ).toBeVisible({
    timeout: 300_000,
  });
  expect(vorDemNeuwaehlen).toBeLessThan(anzahl);
  expect(angenommen.size, 'jedes Stück genau einmal angekommen').toBe(anzahl);
  // Doppelt angenommen höchstens, was beim Neuladen gerade unterwegs war.
  const doppelt = [...angenommen.values()].reduce((s, n) => s + (n - 1), 0);
  expect(doppelt).toBeLessThanOrEqual(3);

  // ---- Beim Empfänger ------------------------------------------------------
  const liste = await (
    await http.get(`${API}/conversations/${chat.id}/messages`, {
      headers: { authorization: `Bearer ${ben.accessToken}` },
    })
  ).json();
  const anhang = (liste.items as { attachments: { id: string; size: number }[] }[])
    .flatMap((m) => m.attachments)
    .find((a) => a.size === GROESSE);
  expect(anhang, 'Ben sieht den Anhang').toBeTruthy();

  // Ganz herunterladen, im Strom gehasht.
  const antwort = await fetch(`${API}/media/${anhang!.id}/download`, {
    headers: { authorization: `Bearer ${ben.accessToken}` },
  });
  expect(antwort.status).toBe(200);
  const hasher = createHash('sha256');
  let bytes = 0;
  const leser = antwort.body!.getReader();
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    bytes += value.length;
    hasher.update(value);
  }
  expect(bytes).toBe(GROESSE);
  expect(hasher.digest('hex')).toBe(pruefsumme);

  // Spulen im Browser des Empfängers: ein Bereich mitten aus der Datei,
  // durch den Service Worker – und die Datei landet nicht in dessen Speicher.
  const benPage = await seiteFuer(browser, ben, wurzel);
  // Der Medien-Keks entsteht beim Anmelden – mit dem eingeschobenen Token
  // allein hat der Browser keinen. Über den Anfragekontext der Seite
  // angemeldet, landet er in deren Keksdose.
  const anmeldung = await benPage.request.post(`${wurzel}/api/v1/auth/login`, {
    data: { username: ben.username, password: 'passwort123' },
  });
  expect(anmeldung.ok(), `Anmeldung: ${anmeldung.status()}`).toBeTruthy();
  const mitte = Math.floor(GROESSE / 2);
  const ergebnis = await benPage.evaluate(
    async ({ id, mitte }) => {
      const url = `/api/v1/media/${id}`;
      const teil = await fetch(url, { headers: { range: `bytes=${mitte}-${mitte + 99}` } });
      const daten = new Uint8Array(await teil.arrayBuffer());
      // Einmal ganz anfragen (wie ein Abspieler ohne Range) und gleich abbrechen.
      const ganz = await fetch(url);
      await ganz.body?.cancel();
      await new Promise((r) => setTimeout(r, 1500));
      const cache = await caches.open('initiative-media-v1');
      const abgelegt = (await cache.keys()).some((k) => k.url.includes(id));
      return {
        status: teil.status,
        bereich: teil.headers.get('content-range'),
        laenge: daten.length,
        erste: Array.from(daten.slice(0, 8)),
        abgelegt,
        ganzStatus: ganz.status,
      };
    },
    { id: anhang!.id, mitte },
  );
  expect(ergebnis.status).toBe(206);
  expect(ergebnis.bereich).toBe(`bytes ${mitte}-${mitte + 99}/${GROESSE}`);
  expect(ergebnis.laenge).toBe(100);
  expect(ergebnis.ganzStatus).toBe(200);
  expect(ergebnis.abgelegt, 'grosse Dateien gehören nicht in den Medienspeicher').toBe(false);

  // Dieselben Bytes wie in der Datei an dieser Stelle.
  const datei = await open(pfad, 'r');
  const soll = Buffer.alloc(8);
  await datei.read(soll, 0, 8, mitte);
  await datei.close();
  expect(ergebnis.erste).toEqual(Array.from(soll));
});
