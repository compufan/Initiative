import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Die Diashow auf dem Fernseher – durch beide Geräte hindurch.
 *
 * # Warum das hier und nicht in der API-Prüfung steht
 *
 * Die API-Prüfung (`apps/api/tests/fernsehen.rs`) weiss, dass eine
 * Eintrittskarte genau eine Datei öffnet und dass ein Fremder nicht
 * dazwischenkommt. Was sie NICHT sehen kann, ist das Entscheidende an diesem
 * Weg: ob am Ende wirklich ein Bild auf dem Fernseher steht.
 *
 * Dazwischen liegen vier Dinge, die alle einzeln stillschweigend scheitern
 * können – die Umschreibung von `/tv` auf `tv.html`, das Blatt selbst, der
 * Abruf OHNE Anmeldung und die Mischung, die auf beiden Geräten dieselbe sein
 * muss. Deshalb laufen hier zwei Browserfenster nebeneinander: eines ohne
 * Konto (der Fernseher) und eines mit (das Telefon).
 *
 * # Warum zwei verschieden GROSSE Bilder
 *
 * Weil `naturalWidth` damit sagt, WELCHES Bild gerade steht. Zwei gleich
 * grosse Bilder liessen die Fernbedienung durchgehen, ohne dass sich etwas
 * bewegt – und genau das wäre der Fehler, den man sucht.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

/** Ein einfarbiges PNG in der gewünschten Kantenlänge. */
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

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const daten = {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
  const antwort = await http.post(`${API}/auth/register`, { data: daten });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return await antwort.json();
}

async function bildHochladen(
  http: APIRequestContext,
  kopf: Record<string, string>,
  name: string,
  kante: number,
  farbe: [number, number, number],
): Promise<string> {
  const daten = pngAus(kante, farbe);
  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: kopf,
      data: { kind: 'image', mime: 'image/png', size: daten.length, fileName: name },
    })
  ).json();
  const hoch = await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: kopf,
    multipart: { file: { name, mimeType: 'image/png', buffer: daten } },
  });
  expect(hoch.ok(), `Hochladen ${name}: ${hoch.status()}`).toBeTruthy();
  await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: kopf,
    data: { width: kante, height: kante },
  });
  return upload.attachmentId as string;
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

/** Welches Bild gerade auf dem Fernseher steht – über seine Kantenlänge. */
async function stehendesBild(tv: Page): Promise<number> {
  return await tv.evaluate(() => {
    const sichtbar = document.querySelector('img.bild.sichtbar') as HTMLImageElement | null;
    return sichtbar?.naturalWidth ?? 0;
  });
}

test('eine Sammlung läuft als Diashow auf einem Fernseher', async ({ browser, baseURL }) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const person = await registrieren(http, 'tv');
  const kopf = { authorization: `Bearer ${person.accessToken}` };

  // Zwei verschieden grosse Bilder – die Kantenlänge sagt später, welches steht.
  const klein = await bildHochladen(http, kopf, 'klein.png', 8, [220, 40, 40]);
  const gross = await bildHochladen(http, kopf, 'gross.png', 24, [40, 80, 220]);

  const sammlung = await (
    await http.post(`${API}/collections`, {
      headers: kopf,
      data: { name: `Fernsehabend ${Date.now()}` },
    })
  ).json();
  for (const anhang of [klein, gross]) {
    const rein = await http.post(`${API}/collections/${sammlung.id}/items`, {
      headers: kopf,
      data: { attachmentId: anhang },
    });
    expect(rein.ok(), `Einlegen: ${rein.status()}`).toBeTruthy();
  }

  /*
   * Der Fernseher: ein eigenes Browserfenster OHNE jede Anmeldung. Genau das
   * ist der Punkt – ein Chromecast, ein Samsung, ein Beamer am Laptop haben
   * kein Konto in dieser App und bekommen auch keines.
   */
  const tv = await (await browser.newContext()).newPage();
  await tv.goto(`${wurzel}/tv`);

  const codeFeld = tv.locator('#code');
  await expect(codeFeld).not.toHaveText('…', { timeout: 20_000 });
  const code = ((await codeFeld.textContent()) ?? '').trim();
  expect(code, 'der Fernseher zeigt keinen brauchbaren Code').toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // ---- Das Telefon: Sammlung öffnen und auf den Fernseher schicken --------
  const telefon = await seiteFuer(browser, person, wurzel);
  await telefon.goto(`${wurzel}/dateien/${sammlung.id}`);
  await telefon.getByRole('button', { name: /Auf den Fernseher/ }).click();
  await telefon.locator('.tv-code-eingabe').fill(code);
  /*
   * Das kürzeste Tempo, und das ist kein Geschmack, sondern die Voraussetzung
   * für die Messung weiter unten: Bei zwei Sekunden je Bild heisst „es hat
   * sich neun Sekunden lang nichts bewegt" wirklich, dass die Pause greift.
   */
  await telefon.locator('.tv-einstellen input[type="range"]').fill('2');
  await telefon.getByRole('button', { name: 'Starten' }).click();
  await expect(telefon.getByText(/Läuft auf dem Fernseher/).first()).toBeVisible({
    timeout: 20_000,
  });

  /*
   * Und jetzt die eine Frage, die keine Prüfung auf der Serverseite
   * beantworten kann: Steht da wirklich ein Bild?
   *
   * `naturalWidth > 0` heisst, der Fernseher hat die Bytes geholt und
   * entschlüsselt – ohne Kopf, ohne Keks, allein mit der Karte in der Adresse.
   * Ein `<img>` mit einer 401 dahinter hätte hier null.
   */
  await expect
    .poll(() => stehendesBild(tv), {
      timeout: 25_000,
      message: 'auf dem Fernseher steht kein geladenes Bild',
    })
    .toBeGreaterThan(0);

  expect([8, 24], `unerwartete Kantenlänge ${await stehendesBild(tv)}`).toContain(
    await stehendesBild(tv),
  );

  /*
   * ---- Die Fernbedienung ------------------------------------------------
   *
   * Erst PAUSE, und zwar nicht aus Höflichkeit: Ohne sie läuft die Diashow
   * von selbst weiter, und „das Bild hat gewechselt" wäre nach ein paar
   * Sekunden auch ohne jeden Knopfdruck wahr. Genau daran ist die erste
   * Fassung dieser Prüfung vorbeigelaufen – eine Fernbedienung, die den
   * Fernseher gar nicht erreicht, bestand sie anstandslos.
   */
  await telefon.getByRole('button', { name: '⏸ Pause' }).click();
  // Zwei Takte, damit die Pause beim Fernseher angekommen ist.
  await tv.waitForTimeout(5_000);
  const stehtStill = await stehendesBild(tv);
  expect(stehtStill).toBeGreaterThan(0);
  await tv.waitForTimeout(9_000);
  expect(
    await stehendesBild(tv),
    'die Pause hält die Diashow nicht an – vier Standzeiten sind vergangen',
  ).toBe(stehtStill);

  // Und jetzt bewegt nur noch der Knopf etwas.
  await telefon.getByRole('button', { name: 'Weiter ›' }).click();
  await expect
    .poll(() => stehendesBild(tv), {
      timeout: 25_000,
      message: 'die Fernbedienung bewegt nichts auf dem Fernseher',
    })
    .not.toBe(stehtStill);

  // ---- Beenden ------------------------------------------------------------
  await telefon.getByRole('button', { name: 'Beenden' }).click();
  /*
   * Danach zeigt der Fernseher wieder seinen Code, und zwar DENSELBEN: Die
   * Sitzung bleibt, nur ihr Inhalt geht. Ein neuer Code hiesse, dass man beim
   * nächsten Mal wieder aufstehen und ablesen müsste.
   */
  await expect(tv.locator('#anmeldung')).toBeVisible({ timeout: 25_000 });
  await expect(codeFeld).toHaveText(code);
});

test('die Mischung ist auf beiden Geräten dieselbe', async ({ page }) => {
  /*
   * Der Grund, warum die Reihenfolge gerechnet und nicht gewürfelt wird.
   *
   * Der Fernseher zeigt, das Telefon sagt „Bild 7". Mischte jedes Gerät für
   * sich, meinte „Bild 7" auf beiden Seiten etwas anderes – und wer am
   * Telefon „zurück" drückt, landete auf dem Fernseher irgendwo. Die Saat
   * kommt deshalb vom Server, und beide rechnen dieselbe Liste daraus.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const laden = '/src/tv/mischen.ts';
    const mischen = (await import(
      /* @vite-ignore */ laden
    )) as typeof import('../src/tv/mischen.js');

    const a = mischen.reihenfolge(50, 'zufall', 12345);
    const b = mischen.reihenfolge(50, 'zufall', 12345);
    const c = mischen.reihenfolge(50, 'zufall', 12346);
    const gerade = mischen.reihenfolge(50, 'linear', 12345);
    return {
      gleich: JSON.stringify(a) === JSON.stringify(b),
      andereSaat: JSON.stringify(a) === JSON.stringify(c),
      vollstaendig: JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify(gerade),
      gemischt: JSON.stringify(a) !== JSON.stringify(gerade),
      linearIstDerReihe: JSON.stringify(gerade) === JSON.stringify([...Array(50).keys()]),
      leer: mischen.reihenfolge(0, 'zufall', 1).length,
      eins: JSON.stringify(mischen.reihenfolge(1, 'zufall', 1)),
    };
  });

  expect(ergebnis.gleich, 'dieselbe Saat ergibt eine andere Reihenfolge').toBe(true);
  expect(ergebnis.andereSaat, 'eine andere Saat ergibt dieselbe Reihenfolge').toBe(false);
  /*
   * Eine Mischung darf nichts verlieren und nichts verdoppeln. Das ist der
   * Fehler, den man bei einer selbstgebauten Mischung wirklich macht – und
   * auf dem Fernseher sähe man ihn als ein Foto, das zweimal kommt, während
   * ein anderes fehlt.
   */
  expect(ergebnis.vollstaendig, 'die Mischung verliert oder verdoppelt Stücke').toBe(true);
  expect(ergebnis.gemischt, 'es wurde gar nicht gemischt').toBe(true);
  expect(ergebnis.linearIstDerReihe).toBe(true);
  // Und die Ränder, an denen eine Schleife rückwärts gern danebengreift.
  expect(ergebnis.leer).toBe(0);
  expect(ergebnis.eins).toBe('[0]');
});

test('die Auslieferung schreibt `/tv` wirklich auf `tv.html` um', () => {
  /*
   * Eine Prüfung der Auslieferungsregeln, und zwar mit Absicht.
   *
   * Der Entwicklungsserver löst `/tv` von selbst auf – ein Einstiegspunkt
   * namens `tv.html` beantwortet dort auch `/tv`. Nachgemessen: Nimmt man die
   * Umschreibung ganz heraus, läuft die Prüfung oben trotzdem durch.
   *
   * In der Auslieferung tut das niemand von selbst. Ohne die Umschreibung
   * bekommt `/tv` über `try_files` die App-Hülle – mit HTTP 200, also ohne
   * jede Fehlermeldung, und auf dem Fernseher steht ein Anmeldeschirm, den
   * dort niemand bedienen kann. Kein Ablauftest kann das sehen; deshalb steht
   * die Regel hier.
   */
  const hier = fileURLToPath(new URL('.', import.meta.url));
  const caddy = readFileSync(`${hier}../Caddyfile`, 'utf8');
  expect(caddy, 'im Caddyfile fehlt die Umschreibung – `/tv` landet dort in der App-Hülle').toMatch(
    /rewrite\s+@tv\s+\/tv\.html/,
  );
  expect(caddy).toMatch(/@tv\s+path\s+\/tv\b/);

  const vercel = JSON.parse(readFileSync(`${hier}../vercel.json`, 'utf8')) as {
    rewrites: { source: string; destination: string }[];
  };
  const treffer = vercel.rewrites.findIndex((regel) => regel.source === '/tv');
  expect(treffer, 'in vercel.json fehlt die Umschreibung für /tv').toBeGreaterThanOrEqual(0);
  expect(vercel.rewrites[treffer].destination).toBe('/tv.html');
  /*
   * Und VOR der Auffangregel. Vercel nimmt die erste Regel, die passt – die
   * Auffangregel passt auf alles, also auch auf `/tv`.
   */
  const auffang = vercel.rewrites.findIndex((regel) => regel.destination === '/index.html');
  expect(treffer, 'die Umschreibung steht hinter der Auffangregel').toBeLessThan(auffang);
});
