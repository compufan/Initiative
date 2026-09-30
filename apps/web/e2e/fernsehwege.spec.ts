import { crc32, deflateSync } from 'node:zlib';
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Die drei Wege auf den Fernseher – an den Stellen, an denen sie kaputt waren.
 *
 * `fernsehen.spec.ts` prüft, dass eine Diashow überhaupt ankommt. Hier geht
 * es um das, was danach schiefging, und jede Prüfung steht für einen Fehler,
 * den es gab:
 *
 *   * **Code-Weg:** „Pause" setzte ein laufendes Video an den Anfang, Videos
 *     liefen immer stumm, „Weiter" am Telefon sprang nach ein paar Minuten
 *     Schau zurück an den Anfang, und für jedes neue Foto hiess es „Beenden"
 *     und den Code neu abtippen.
 *   * **Ein Tipp:** Die Adresse mit Eintrittskarte kam erst NACH dem Tipp ins
 *     Video – die eingebauten Cast- und AirPlay-Knöpfe schickten deshalb eine
 *     Adresse ohne Karte (401), und `prompt()` lief zu spät für den Tipp.
 *     Ohne gefundenes Gerät stand an einem Video gar nichts, und ein
 *     abgebrochener Versuch endete in Stille.
 *   * **Spiegeln:** Den Weg gab es nicht.
 *
 * Kein Chromecast im Testlauf – die Remote Playback API wird deshalb dort, wo
 * es um den Tipp geht, durch eine Attrappe ersetzt, die festhält, WANN und
 * MIT WELCHER ADRESSE `prompt()` gerufen wurde. Das ist genau die Stelle, an
 * der der Fehler sass.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  /** Womit sich das Telefon im Browser anmeldet – siehe `seiteFuer`. */
  anmeldung: { username: string; password: string };
}

type Kopf = Record<string, string>;

function pngAus(kante: number, farbe: [number, number, number]): Buffer {
  const roh = Buffer.alloc((kante * 3 + 1) * kante);
  let at = 0;
  for (let y = 0; y < kante; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < kante; x += 1) {
      roh[at] = farbe[0];
      roh[at + 1] = farbe[1];
      roh[at + 2] = farbe[2];
      at += 3;
    }
  }
  const bloecke: Buffer[] = [];
  const block = (typ: string, daten: Buffer) => {
    const kopf = Buffer.alloc(8);
    kopf.writeUInt32BE(daten.length, 0);
    kopf.write(typ, 4, 'ascii');
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(crc32(Buffer.concat([Buffer.from(typ, 'ascii'), daten])) >>> 0, 0);
    bloecke.push(kopf, daten, pruef);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(kante, 0);
  ihdr.writeUInt32BE(kante, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  block('IHDR', ihdr);
  block('IDAT', deflateSync(roh));
  block('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...bloecke]);
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const anmeldung = { username: `${prefix}${suffix}`, password: 'passwort123' };
  const antwort = await http.post(`${API}/auth/register`, {
    data: { ...anmeldung, displayName: `${prefix.toUpperCase()} ${suffix}` },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return { ...(await antwort.json()), anmeldung };
}

async function hochladen(
  http: APIRequestContext,
  kopf: Kopf,
  art: 'image' | 'video',
  typ: string,
  name: string,
  daten: Buffer,
  masse: { width: number; height: number; durationMs?: number },
): Promise<string> {
  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: kopf,
      data: { kind: art, mime: typ, size: daten.length, fileName: name },
    })
  ).json();
  const hoch = await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: kopf,
    multipart: { file: { name, mimeType: typ, buffer: daten } },
  });
  expect(hoch.ok(), `Hochladen ${name}: ${hoch.status()}`).toBeTruthy();
  await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: kopf,
    data: masse,
  });
  return upload.attachmentId as string;
}

function bildHochladen(
  http: APIRequestContext,
  kopf: Kopf,
  name: string,
  kante: number,
  farbe: [number, number, number],
) {
  return hochladen(http, kopf, 'image', 'image/png', name, pngAus(kante, farbe), {
    width: kante,
    height: kante,
  });
}

/**
 * Ein echtes Video von dreissig Sekunden – in einer Sekunde gerechnet.
 *
 * Über den eigenen Kodierer der App (`videoSchreiben`) und nicht über
 * `MediaRecorder`: Der nähme die Wanduhr, und dreissig Sekunden Video kosteten
 * dreissig Sekunden Test. Dreissig und nicht fünf, weil Chrome bei Videos bis
 * 15 Sekunden gar keinen Fernseher anbietet – geprüft werden soll der Fall,
 * in dem es das tut.
 */
async function videoErzeugen(seite: Page, wurzel: string): Promise<Buffer | null> {
  await seite.goto(wurzel);
  const roh = await seite.evaluate(async () => {
    const pfad = '/src/modules/video/schreiben.ts';
    const modul = (await import(
      /* @vite-ignore */ pfad
    )) as typeof import('../src/modules/video/schreiben.js');
    const tauglich = await modul.videoTauglich(160, 120);
    if (!tauglich.moeglich) return null;
    const leinwand = document.createElement('canvas');
    leinwand.width = 160;
    leinwand.height = 120;
    const ctx = leinwand.getContext('2d')!;
    const datei = await modul.videoSchreiben(
      30,
      (nummer) => {
        ctx.fillStyle = nummer % 2 === 0 ? '#e02020' : '#2040e0';
        ctx.fillRect(0, 0, 160, 120);
        return leinwand;
      },
      { breite: 160, hoehe: 120, bildrate: 1 },
    );
    return Array.from(new Uint8Array(await datei.arrayBuffer()));
  });
  return roh ? Buffer.from(roh) : null;
}

/**
 * Das Telefon – angemeldet IM Browser, nicht nur mit Schlüsseln im Speicher.
 *
 * Der Unterschied ist der Medien-Keks: Ihn setzt der Server bei der Anmeldung,
 * und nur mit ihm lädt das Telefon Fotos und Videos über die gewöhnliche
 * Adresse. Die Fernsehansicht tut genau das (sie zeigt im Telefon, der
 * Fernseher spiegelt nur). Schlüssel, die ausserhalb des Browsers geholt und
 * hineingelegt werden, bringen keinen Keks mit.
 */
async function seiteFuer(
  browser: Browser,
  sitzung: Sitzung,
  wurzel: string,
  vorher?: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (vorher) await page.addInitScript(vorher);
  await page.goto(wurzel);
  await page.evaluate(async (anmeldung) => {
    const antwort = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(anmeldung),
    });
    const werte = (await antwort.json()) as { accessToken: string; refreshToken: string };
    localStorage.setItem(
      'initiative.tokens',
      JSON.stringify({
        accessToken: werte.accessToken,
        refreshToken: werte.refreshToken,
        expiresAt: Date.now() + 3_600_000,
      }),
    );
  }, sitzung.anmeldung);
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

async function fernseherOeffnen(
  browser: Browser,
  wurzel: string,
): Promise<{ tv: Page; code: string }> {
  const tv = await (await browser.newContext()).newPage();
  await tv.goto(`${wurzel}/tv`);
  const codeFeld = tv.locator('#code');
  await expect(codeFeld).not.toHaveText('…', { timeout: 20_000 });
  return { tv, code: ((await codeFeld.textContent()) ?? '').trim() };
}

/** Welches Bild gerade auf dem Fernseher steht – über seine Kantenlänge. */
async function stehendesBild(tv: Page): Promise<number> {
  return await tv.evaluate(() => {
    const sichtbar = document.querySelector('img.bild.sichtbar') as HTMLImageElement | null;
    return sichtbar?.naturalWidth ?? 0;
  });
}

/** Der Zustand des Films auf dem Fernseher. */
async function film(tv: Page) {
  return await tv.evaluate(() => {
    const f = document.getElementById('film') as HTMLVideoElement;
    return { zeit: f.currentTime, pausiert: f.paused, stumm: f.muted, versteckt: f.hidden };
  });
}

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

async function gespraechMit(http: APIRequestContext, kopf: Kopf, mitId: string): Promise<string> {
  const chat = await (
    await http.post(`${API}/conversations`, {
      headers: kopf,
      data: { type: 'direct', memberIds: [mitId] },
    })
  ).json();
  return chat.id as string;
}

async function schicken(
  http: APIRequestContext,
  kopf: Kopf,
  chat: string,
  typ: 'image' | 'video',
  text: string,
  anhaenge: string[],
) {
  const gesendet = await http.post(`${API}/conversations/${chat}/messages`, {
    headers: kopf,
    data: { type: typ, body: text, attachmentIds: anhaenge },
  });
  expect(gesendet.ok(), `Nachricht: ${gesendet.status()}`).toBeTruthy();
}

/**
 * Die Attrappe für die Remote Playback API.
 *
 * Sie hält für jeden Aufruf von `prompt()` fest, ob er noch im Klick geschah
 * (`imKlick`: ein Merker, den ein Klick im Fangdurchgang setzt und der
 * nächste Takt wieder löscht) und welche Adresse das Video in dem Moment
 * trug. Genau das entscheidet in einem echten Browser, ob die Geräteliste
 * aufgeht und ob der Fernseher die Datei bekommt.
 */
function fernbedienungVortaeuschen(geraetDa: boolean): string {
  return `(() => {
    const je = new WeakMap();
    window.__prompts = [];
    window.__imKlick = false;
    document.addEventListener('click', () => {
      window.__imKlick = true;
      setTimeout(() => { window.__imKlick = false; }, 0);
    }, true);
    Object.defineProperty(HTMLMediaElement.prototype, 'remote', {
      configurable: true,
      get() {
        let r = je.get(this);
        if (!r) {
          const element = this;
          r = {
            state: 'disconnected',
            watchAvailability(melden) { setTimeout(() => melden(${geraetDa}), 50); return Promise.resolve(1); },
            cancelWatchAvailability() { return Promise.resolve(); },
            prompt() {
              window.__prompts.push({ imKlick: window.__imKlick === true, src: element.currentSrc || element.src });
              if (window.__promptAbbrechen) {
                return Promise.reject(new DOMException('The prompt was dismissed.', 'NotAllowedError'));
              }
              return Promise.resolve();
            },
            addEventListener() {},
            removeEventListener() {},
          };
          je.set(this, r);
        }
        return r;
      },
    });
  })();`;
}

/* ======================================================================== *
 * Code-Weg
 * ======================================================================== */

test('Code-Weg: Pause hält ein Video an derselben Stelle an – und OK schaltet den Ton ein', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const person = await registrieren(http, 'tvpause');
  const kopf = { authorization: `Bearer ${person.accessToken}` };

  const werkbank = await (await browser.newContext()).newPage();
  const bytes = await videoErzeugen(werkbank, wurzel);
  if (!bytes) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const video = await hochladen(http, kopf, 'video', 'video/webm', 'abend.webm', bytes, {
    width: 160,
    height: 120,
    durationMs: 30_000,
  });

  const { tv, code } = await fernseherOeffnen(browser, wurzel);
  const ein = await http.post(`${API}/tv/sitzungen/${encodeURIComponent(code)}/programm`, {
    headers: kopf,
    data: { attachmentIds: [video] },
  });
  expect(ein.ok(), `Einstellen: ${ein.status()}`).toBeTruthy();

  await expect
    .poll(async () => ((await film(tv)).versteckt ? 0 : (await film(tv)).zeit), {
      timeout: 25_000,
      message: 'das Video läuft auf dem Fernseher nicht an',
    })
    .toBeGreaterThan(2);

  // ---- Pause über die Fernbedienung ----------------------------------------
  const steuern = (daten: Record<string, unknown>) =>
    http.patch(`${API}/tv/sitzungen/${encodeURIComponent(code)}`, { headers: kopf, data: daten });
  expect((await steuern({ pausiert: true })).ok()).toBeTruthy();
  await expect.poll(async () => (await film(tv)).pausiert, { timeout: 10_000 }).toBe(true);
  const angehalten = (await film(tv)).zeit;
  /*
   * Der Kern: Das Video steht dort, wo es war. Vorher holte der Fernseher
   * nach jedem Griff an die Fernbedienung die ganze Liste neu – mit neuen
   * Adressen –, und `film.src = …; currentTime = 0` setzte es an den Anfang.
   */
  expect(angehalten, 'die Pause hat das Video an den Anfang gesetzt').toBeGreaterThan(1.5);
  // Und es bleibt dort, auch über den nächsten Takt hinweg.
  await tv.waitForTimeout(3_000);
  expect(Math.abs((await film(tv)).zeit - angehalten)).toBeLessThan(0.3);

  // ---- Weiter: vom selben Punkt, nicht von vorn ----------------------------
  expect((await steuern({ pausiert: false })).ok()).toBeTruthy();
  await expect.poll(async () => (await film(tv)).pausiert, { timeout: 10_000 }).toBe(false);
  expect((await film(tv)).zeit, '„Weiter" hat das Video von vorn gestartet').toBeGreaterThanOrEqual(
    angehalten - 0.2,
  );

  /*
   * ---- OK auf der Fernbedienung des Fernsehers: Ton an --------------------
   *
   * Stumm, weil ohne Tastendruck kein Browser Ton abspielt – aber jetzt mit
   * dem Satz, wie man ihn bekommt. Vorher gab es gar keinen Weg zum Ton.
   */
  expect((await film(tv)).stumm).toBe(true);
  await expect(tv.locator('#ton')).toBeVisible();
  await tv.keyboard.press('Enter');
  await expect.poll(async () => (await film(tv)).stumm, { timeout: 5_000 }).toBe(false);
  await expect(tv.locator('#ton')).toBeHidden();
  // Der erste OK gehört dem Ton, nicht der Pause.
  expect((await film(tv)).pausiert).toBe(false);
  expect(await tv.evaluate(() => sessionStorage.getItem('tv-ton'))).toBe('an');

  await http.dispose();
  await tv.context().close();
  await werkbank.context().close();
});

test('Code-Weg: Der Fernseher meldet seine Stelle – „Weiter" am Telefon rechnet von dort', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const person = await registrieren(http, 'tvstelle');
  const kopf = { authorization: `Bearer ${person.accessToken}` };
  const acht = await bildHochladen(http, kopf, 'acht.png', 8, [220, 40, 40]);
  const sechzehn = await bildHochladen(http, kopf, 'sechzehn.png', 16, [40, 200, 40]);
  const vierundzwanzig = await bildHochladen(http, kopf, 'vierundzwanzig.png', 24, [40, 80, 220]);

  const { tv, code } = await fernseherOeffnen(browser, wurzel);
  const ein = await http.post(`${API}/tv/sitzungen/${encodeURIComponent(code)}/programm`, {
    headers: kopf,
    data: { attachmentIds: [acht, sechzehn, vierundzwanzig], sekunden: 2 },
  });
  expect(ein.ok()).toBeTruthy();

  // Der Fernseher blättert selbst – bis zum dritten Bild.
  await expect
    .poll(() => stehendesBild(tv), { timeout: 30_000, message: 'die Diashow läuft nicht' })
    .toBe(24);
  // OK am Fernseher hält an – und auch das meldet er.
  await tv.keyboard.press('Enter');
  await tv.waitForTimeout(3_000);
  expect(await stehendesBild(tv), 'OK hat die Schau nicht angehalten').toBe(24);

  // ---- Das Telefon: die Fernbedienung aus dem Balken -----------------------
  const telefon = await seiteFuer(browser, person, wurzel);
  await telefon.getByRole('button', { name: 'Fernbedienung' }).click();
  await telefon.getByRole('button', { name: 'Weiter ›', exact: true }).click();

  /*
   * Vom dritten Bild eins weiter ist das erste – im Kreis. Vorher rechnete
   * das Telefon „Weiter" von der Stelle beim Einstellen aus (0 + 1), und der
   * Fernseher sprang auf das ZWEITE Bild zurück.
   *
   * Geprüft wird das ERSTE Bild nach dem Druck, nicht irgendeines danach:
   * Eine Schau, die weiterläuft, käme nach ein paar Sekunden ohnehin wieder
   * beim ersten an – und genau daran ist die erste Fassung dieser Prüfung
   * am alten Code vorbeigelaufen.
   */
  await expect
    .poll(() => stehendesBild(tv), { timeout: 15_000, message: '„Weiter" kam nicht an' })
    .not.toBe(24);
  expect(
    await stehendesBild(tv),
    '„Weiter" rechnet nicht von der Stelle, an der der Fernseher steht',
  ).toBe(8);
  // Und die Pause, die am Fernseher gedrückt wurde, gilt weiter.
  await tv.waitForTimeout(3_000);
  expect(await stehendesBild(tv), 'die Pause am Fernseher ging verloren').toBe(8);

  await http.dispose();
  await telefon.context().close();
  await tv.context().close();
});

test('Code-Weg: „Stattdessen dies zeigen" – ohne Beenden und ohne neuen Code', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const anna = await registrieren(http, 'tvstatt');
  const ben = await registrieren(http, 'tvstattb');
  const kopf = { authorization: `Bearer ${anna.accessToken}` };
  const chat = await gespraechMit(http, kopf, ben.user.id);
  const zwoelf = await bildHochladen(http, kopf, 'erstes.png', 12, [200, 60, 60]);
  const zwanzig = await bildHochladen(http, kopf, 'zweites.png', 20, [60, 60, 200]);
  await schicken(http, kopf, chat, 'image', 'Das erste Bild', [zwoelf]);
  await schicken(http, kopf, chat, 'image', 'Das zweite Bild', [zwanzig]);

  const { tv, code } = await fernseherOeffnen(browser, wurzel);
  const telefon = await seiteFuer(browser, anna, wurzel);
  await telefon.goto(`${wurzel}/chats/${chat}`);

  await langAntippen(telefon, 'Das erste Bild');
  await telefon.getByText('Auf den Fernseher').click();
  await telefon.locator('.tv-code-eingabe').fill(code);
  await telefon.getByRole('button', { name: 'Starten' }).click();
  await expect.poll(() => stehendesBild(tv), { timeout: 25_000 }).toBe(12);
  await telefon.keyboard.press('Escape');

  // Das nächste Foto auf DENSELBEN Fernseher – ein Tipp, kein Code.
  await langAntippen(telefon, 'Das zweite Bild');
  await telefon.getByText('Auf den Fernseher').click();
  await expect(telefon.locator('.tv-code-eingabe')).toHaveCount(0);
  await telefon.getByRole('button', { name: /Stattdessen dies zeigen/ }).click();
  await expect
    .poll(() => stehendesBild(tv), {
      timeout: 25_000,
      message: 'das neue Foto kam nicht auf den laufenden Fernseher',
    })
    .toBe(20);

  await http.dispose();
  await telefon.context().close();
  await tv.context().close();
});

/* ======================================================================== *
 * Ein Tipp – an der Videoblase
 * ======================================================================== */

async function chatMitVideo(browser: Browser, wurzel: string, prefix: string) {
  const http = await request.newContext();
  const anna = await registrieren(http, prefix);
  const ben = await registrieren(http, `${prefix}b`);
  const kopf = { authorization: `Bearer ${anna.accessToken}` };
  const werkbank = await (await browser.newContext()).newPage();
  const bytes = await videoErzeugen(werkbank, wurzel);
  await werkbank.context().close();
  if (!bytes) return null;
  const video = await hochladen(http, kopf, 'video', 'video/webm', 'urlaub.webm', bytes, {
    width: 160,
    height: 120,
    durationMs: 30_000,
  });
  const chat = await gespraechMit(http, kopf, ben.user.id);
  await schicken(http, kopf, chat, 'video', 'Das Video vom Berg', [video]);
  return { http, anna, chat };
}

test('Videoblase: Mit Fernseher in Reichweite steht die Karte VOR dem Tipp im Video – und die Liste geht im selben Takt auf', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const lage = await chatMitVideo(browser, wurzel, 'tvtipp');
  if (!lage) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const telefon = await seiteFuer(browser, lage.anna, wurzel, fernbedienungVortaeuschen(true));
  await telefon.goto(`${wurzel}/chats/${lage.chat}`);
  const video = telefon.locator('video.media-video').first();
  await expect(video).toBeVisible({ timeout: 15_000 });

  /*
   * Noch hat niemand getippt – und die Adresse trägt schon die Karte. Genau
   * die schicken Chromes Cast-Symbol und Safaris AirPlay-Knopf in der
   * Videosteuerung an den Fernseher. Vorher stand hier die Adresse ohne
   * Karte, und der Fernseher bekam 401.
   */
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentSrc), {
      timeout: 15_000,
      message: 'die Karte steht vor dem Tipp nicht im Video',
    })
    .toContain('tv=');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // Und der Fernseher kommt mit dieser Adresse ohne Anmeldung an die Datei.
  const adresse = await video.evaluate((v: HTMLVideoElement) => v.currentSrc);
  const ohneKonto = await request.newContext();
  const abruf = await ohneKonto.get(adresse, { headers: { range: 'bytes=0-15' } });
  expect([200, 206], `der Fernseher bekäme ${abruf.status()}`).toContain(abruf.status());
  await ohneKonto.dispose();

  await telefon.getByRole('button', { name: 'Auf den Fernseher' }).first().click();
  const aufrufe = await telefon.evaluate(
    () => (window as unknown as { __prompts: { imKlick: boolean; src: string }[] }).__prompts,
  );
  expect(aufrufe.length, 'ein Tipp auf 📺 hat keine Geräteliste geöffnet').toBe(1);
  /*
   * Im selben Takt wie der Finger. Vorher lagen ein Netzabruf und bis zu
   * zweieinhalb Sekunden Warten dazwischen – in Safari ist die Geste dann
   * verbraucht, und die AirPlay-Liste geht nie auf.
   */
  expect(aufrufe[0].imKlick, 'prompt() lief nicht mehr im Klick').toBe(true);
  expect(aufrufe[0].src).toContain('tv=');

  await lage.http.dispose();
  await telefon.context().close();
});

test('Videoblase: Ohne Fernseher führt „Auf den Fernseher" zu allen Wegen – mit Erklärung statt Stille, und zur Fernsehansicht', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const lage = await chatMitVideo(browser, wurzel, 'tvohne');
  if (!lage) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const telefon = await seiteFuer(browser, lage.anna, wurzel, fernbedienungVortaeuschen(false));
  await telefon.goto(`${wurzel}/chats/${lage.chat}`);
  const video = telefon.locator('video.media-video').first();
  await expect(video).toBeVisible({ timeout: 15_000 });

  /*
   * Der Knopf ist da, obwohl kein Gerät gemeldet ist. Vorher gab es an so
   * einem Video gar nichts – keinen Knopf, keinen Hinweis auf den Code.
   */
  const knopf = telefon.getByRole('button', { name: 'Auf den Fernseher' }).first();
  await expect(knopf).toBeVisible();
  // Und ohne Gerät steht auch keine Karte in der Seite.
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentSrc)).not.toContain('tv=');

  await knopf.click();
  const blatt = telefon.getByRole('dialog', { name: 'Auf den Fernseher' });
  await expect(blatt).toBeVisible();
  await expect(blatt.getByRole('button', { name: 'Code am Fernseher' })).toBeVisible();
  await expect(blatt.getByRole('button', { name: /Fernsehansicht zum Spiegeln/ })).toBeVisible();
  await expect(blatt.getByText('Kein Fernseher gefunden?')).toBeVisible();

  // ---- Der Versuch mit einem Tipp, den der Browser sofort abbricht --------
  const waehlen = blatt.getByRole('button', { name: /Fernseher wählen/ });
  await expect(waehlen).toBeEnabled({ timeout: 15_000 });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await telefon.evaluate(() => {
    (window as unknown as { __promptAbbrechen: boolean }).__promptAbbrechen = true;
  });
  await waehlen.click();
  /*
   * Chrome bricht ohne Gerät mit „The prompt was dismissed." ab – wie beim
   * Schliessen der Liste. Die App schwieg dann. Jetzt steht da ein Satz, und
   * die Erklärung klappt auf.
   */
  await expect(blatt.getByText('Der Browser hat keinen Fernseher angeboten.')).toBeVisible();
  await expect(blatt.locator('details.fw-erklaerung')).toHaveAttribute('open', '');

  // ---- Der dritte Weg: die Fernsehansicht ----------------------------------
  await blatt.getByRole('button', { name: /Fernsehansicht zum Spiegeln/ }).click();
  await expect(telefon.getByText('Zuerst: Mitteilungen aus.').first()).toBeVisible();
  await telefon.getByRole('button', { name: /Fernsehansicht starten/ }).click();
  const ansicht = telefon.getByRole('dialog', { name: 'Fernsehansicht' });
  await expect(ansicht).toBeVisible();

  const filmFa = ansicht.locator('video.fa-film');
  /*
   * Die iPhone-Falle: Beim Spiegeln übergibt iOS ein Video im Vollbild an
   * AirPlay, und der Fernseher holt es sich ohne Anmeldung – schwarz. Also:
   * im Bild, ohne eigene Steuerung (kein Vollbildknopf) und mit dem einen
   * Schalter, der die Übergabe in WebKit wirklich abstellt.
   */
  await expect(filmFa).toHaveAttribute('x-webkit-wirelessvideoplaybackdisabled', '');
  await expect(filmFa).toHaveAttribute('playsinline', '');
  expect(await filmFa.getAttribute('controls')).toBeNull();
  // Mit Ton – der Tipp auf „starten" war die Freigabe dafür.
  await expect
    .poll(() => filmFa.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(0.5);
  expect(await filmFa.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  await lage.http.dispose();
  await telefon.context().close();
});

/* ======================================================================== *
 * Spiegeln – die Fernsehansicht aus dem Nachrichtenmenü
 * ======================================================================== */

test('Fernsehansicht: aus dem Nachrichtenmenü, mit Warnung vorab – blättert und hört auf', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const anna = await registrieren(http, 'tvspiegel');
  const ben = await registrieren(http, 'tvspiegelb');
  const kopf = { authorization: `Bearer ${anna.accessToken}` };
  const chat = await gespraechMit(http, kopf, ben.user.id);
  const klein = await bildHochladen(http, kopf, 'klein.png', 8, [220, 40, 40]);
  const gross = await bildHochladen(http, kopf, 'gross.png', 24, [40, 80, 220]);
  await schicken(http, kopf, chat, 'image', 'Zwei vom Abend', [klein, gross]);

  const telefon = await seiteFuer(browser, anna, wurzel);
  await telefon.goto(`${wurzel}/chats/${chat}`);
  await langAntippen(telefon, 'Zwei vom Abend');
  await telefon.getByText('Auf den Fernseher').click();

  // Im Blatt des Code-Wegs steht der dritte Weg – für Fernseher ohne Browser.
  await telefon.getByRole('button', { name: /Telefon spiegeln/ }).click();
  const anleitung = telefon.getByRole('dialog', { name: 'Telefon auf den Fernseher spiegeln' });
  await expect(anleitung).toBeVisible();
  // Die Warnung vor Mitteilungen steht VOR dem Start – Pflicht, kein Tipp.
  await expect(anleitung.getByText('Zuerst: Mitteilungen aus.').first()).toBeVisible();
  await expect(anleitung.getByText(/entsperrt bleiben/).first()).toBeVisible();
  await anleitung.getByRole('button', { name: /Fernsehansicht starten/ }).click();

  const ansicht = telefon.getByRole('dialog', { name: 'Fernsehansicht' });
  await expect(ansicht).toBeVisible();
  const bild = ansicht.locator('img.fa-bild');
  const kante = () => bild.evaluate((b: HTMLImageElement) => b.naturalWidth).catch(() => 0);
  await expect.poll(kante, { timeout: 10_000 }).toBe(8);
  // Die App tritt zurück: ihre Hinweise lägen sonst mitten auf dem Fernseher.
  expect(
    await telefon.evaluate(() => document.body.classList.contains('fernsehansicht-offen')),
  ).toBe(true);

  // Weiter mit der Pfeiltaste …
  await telefon.keyboard.press('ArrowRight');
  await expect.poll(kante, { timeout: 10_000 }).toBe(24);

  // … und zurück mit einem Wischen nach rechts.
  const flaeche = await ansicht.boundingBox();
  if (!flaeche) throw new Error('Die Ansicht hat keine Fläche');
  const mitteY = flaeche.y + flaeche.height / 2;
  await telefon.mouse.move(flaeche.x + flaeche.width * 0.3, mitteY);
  await telefon.mouse.down();
  await telefon.mouse.move(flaeche.x + flaeche.width * 0.7, mitteY, { steps: 5 });
  await telefon.mouse.up();
  await expect.poll(kante, { timeout: 10_000 }).toBe(8);

  // Esc beendet – und die App ist wieder die App.
  await telefon.keyboard.press('Escape');
  await expect(ansicht).toBeHidden();
  expect(
    await telefon.evaluate(() => document.body.classList.contains('fernsehansicht-offen')),
  ).toBe(false);

  await http.dispose();
  await telefon.context().close();
});
