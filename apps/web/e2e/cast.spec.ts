import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { expect, request, test, type Browser, type Page } from '@playwright/test';

/**
 * Google Cast – und vor allem die Schwelle davor.
 *
 * # Was hier wirklich geprüft wird
 *
 * Nicht, ob ein Chromecast im Testlauf ein Bild zeigt: In einem kopflosen
 * Browser gibt es keinen, und es gäbe ihn auch auf keinem Bauserver.
 *
 * Geprüft wird die Zusage, die in der Datenschutzerklärung steht: „Die Seite
 * lädt von sich aus nichts von fremden Servern." Das ist eine Aussage über
 * das Verhalten der App, und sie lässt sich messen – am Netzverkehr. Ein
 * Skript, das versehentlich beim Start geladen wird, bricht keine Funktion
 * und fällt deshalb sonst NIEMANDEM auf; die einzige Stelle, an der es
 * auffällt, ist eine Prüfung wie diese.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;
const HIER = fileURLToPath(new URL('.', import.meta.url));

function pngAus(kante: number): Buffer {
  const roh = Buffer.alloc((kante * 3 + 1) * kante);
  let at = 0;
  for (let y = 0; y < kante; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < kante; x += 1) {
      roh[at] = (x * 7 + y * 13) % 256;
      roh[at + 1] = (x * 29 + y * 3) % 256;
      roh[at + 2] = 128;
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

async function anmelden(browser: Browser, wurzel: string): Promise<{ seite: Page; token: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const seite = await (await browser.newContext()).newPage();
  await seite.goto(wurzel);
  await seite.getByRole('button', { name: /Noch kein Konto/ }).click();
  await seite.getByLabel('Benutzername').fill(`cast${suffix}`);
  await seite.getByLabel('Anzeigename').fill(`Cast ${suffix}`);
  await seite.getByLabel('Passwort', { exact: true }).fill('passwort123');
  await seite.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(seite.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  const token = await seite.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('initiative.tokens') ?? '{}') as { accessToken?: string })
        .accessToken ?? '',
  );
  return { seite, token };
}

test('ohne Zustimmung geht nichts an Google – und mit Zustimmung genau eine Datei', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const { seite, token } = await anmelden(browser, wurzel);
  const kopf = { authorization: `Bearer ${token}` };

  /*
   * Jede Anfrage an eine fremde Herkunft mitschreiben – nicht nur die an
   * gstatic. Wer nur auf einen Namen prüft, übersieht den Tag, an dem das
   * Skript von woanders kommt.
   */
  const fremd: string[] = [];
  seite.on('request', (anfrage) => {
    const u = anfrage.url();
    if (
      !u.startsWith(wurzel) &&
      !u.startsWith(API_URL) &&
      !u.startsWith('data:') &&
      !u.startsWith('blob:')
    ) {
      fremd.push(u);
    }
  });

  // Ein Foto in einen Chat legen und öffnen.
  const daten = pngAus(64);
  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: kopf,
      data: { kind: 'image', mime: 'image/png', size: daten.length, fileName: 'cast.png' },
    })
  ).json();
  await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: kopf,
    multipart: { file: { name: 'cast.png', mimeType: 'image/png', buffer: daten } },
  });
  await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: kopf,
    data: { width: 64, height: 64 },
  });
  const sammlung = await (
    await http.post(`${API}/collections`, { headers: kopf, data: { name: `Cast ${Date.now()}` } })
  ).json();
  await http.post(`${API}/collections/${sammlung.id}/items`, {
    headers: kopf,
    data: { attachmentId: upload.attachmentId },
  });

  await seite.goto(`${wurzel}/dateien/${sammlung.id}`);
  await expect(seite.locator('.fil-tile').first()).toBeVisible({ timeout: 20_000 });
  await seite.waitForTimeout(1500);

  /*
   * Der Kern der Prüfung: Bis hierher hat niemand etwas eingeschaltet, also
   * darf auch nichts hinausgegangen sein.
   */
  expect(fremd, `die App hat von sich aus fremde Server angefragt: ${fremd.join(', ')}`).toEqual(
    [],
  );

  const castMoeglich = await seite.evaluate(
    () => window.isSecureContext && 'presentation' in navigator,
  );
  if (!castMoeglich) {
    test.skip(true, 'Dieser Browser kann gar nicht casten – dann gibt es auch nichts zu zeigen.');
    return;
  }

  /*
   * Der Knopf davor ist NICHT der Cast-Knopf, sondern der Schalter, der ihn
   * erscheinen lässt. Ihn anzutippen darf noch nichts laden – erst die
   * Abfrage erklären.
   */
  const schalter = seite.getByRole('button', { name: /Chromecast/ }).first();
  await expect(schalter).toBeVisible({ timeout: 15_000 });
  await schalter.click();
  await expect(seite.getByText(/Skript von Google/)).toBeVisible({ timeout: 10_000 });
  await seite.waitForTimeout(700);
  expect(fremd, `schon beim Lesen der Abfrage ging etwas hinaus: ${fremd.join(', ')}`).toEqual([]);

  // Und die Abfrage muss den Weg OHNE Google nennen. Eine Einwilligung, zu
  // der es keine Alternative gibt, ist keine.
  await expect(seite.getByText(/Ohne Google geht es auch/)).toBeVisible();

  /*
   * Die Abfrage muss auch sagen, was NACH der Zustimmung passiert.
   *
   * Der Knopf hiess einmal „Erlauben und verbinden" und verband nicht: Der
   * Gerätewähler von Chrome geht nur aus einer frischen Fingerbewegung auf,
   * und die ist nach dem Laden des SDK vorbei. Wer das nicht sagt, lässt
   * jemanden vor einem Bildschirm sitzen, auf dem nichts geschieht.
   */
  await expect(seite.getByText(/[Ee]inmal darauf tippen/)).toBeVisible();

  /* Jetzt erlauben – und erst jetzt darf genau eine Adresse hinausgehen. */
  await seite.getByRole('button', { name: 'Erlauben', exact: true }).click();
  await expect
    .poll(() => fremd.length, {
      timeout: 15_000,
      message: 'nach der Zustimmung ging nichts hinaus',
    })
    .toBeGreaterThan(0);

  for (const u of fremd) {
    expect(u, `unerwartete fremde Adresse: ${u}`).toMatch(/^https:\/\/www\.gstatic\.com\//);
  }
  expect(fremd.some((u) => u.includes('cast_sender.js'))).toBe(true);

  /*
   * Und die Entscheidung überlebt einen Neustart der App – sonst stünde die
   * Abfrage bei jedem Foto wieder da, und das ist keine Einwilligung, sondern
   * eine Belästigung.
   */
  const gemerkt = await seite.evaluate(() => localStorage.getItem('initiative.cast-erlaubt'));
  expect(gemerkt).toBe('ja');

  /*
   * Und jetzt die Prüfung, die hier gefehlt hat.
   *
   * Dieser Test sah nach der Zustimmung nur noch auf den Netzverkehr und auf
   * den lokalen Speicher – nie auf den Bildschirm. Deshalb blieb er grün,
   * während ein Anwender berichtete:
   *
   *   „Danach passiert gar nichts. Der Fernseher-Button ist danach auch weg."
   *
   * Genau so war es: Die Komponente gab `null` zurück, solange das SDK noch
   * lud, und dauerhaft, wenn kein Chromecast im WLAN steht. Auf dem Testläufer
   * steht keiner – der schlimmste Fall ist hier also der Normalfall, und das
   * macht ihn zur richtigen Zusicherung.
   *
   * Was geprüft wird, ist bewusst nicht ein bestimmter Text: Sichtbar bleiben
   * muss ETWAS – ein Ladezeichen, der echte Cast-Knopf, ein Hinweis. Was es
   * genau ist, hängt vom Netz des Läufers ab; dass die Stelle nicht leer ist,
   * hängt von nichts ab.
   */
  const leiste = seite.locator('.fil-toolbar').first();
  await expect(leiste).toBeVisible();
  await expect
    .poll(
      async () =>
        leiste.evaluate((el) => {
          const cast = el.querySelector(
            '.cast-knopf, .cast-laedt, .cast-hinweis, google-cast-launcher',
          );
          return cast ? 1 : 0;
        }),
      {
        timeout: 20_000,
        message:
          'nach der Zustimmung steht an der Stelle des Cast-Knopfes nichts mehr – genau der gemeldete Fehler',
      },
    )
    .toBe(1);
});

test('die Auslieferungsregel erlaubt gstatic im Skript – und sonst nirgends', () => {
  /*
   * Eine Prüfung der Auslieferungsregeln, und zwar aus zwei Gründen.
   *
   * Erstens: Ohne `https://www.gstatic.com` in `script-src` lädt das Skript
   * nicht, und der Knopf dreht sich ins Leere. Das sieht man im
   * Entwicklungsserver nicht – dort setzt niemand eine Richtlinie.
   *
   * Zweitens, und wichtiger: gstatic gehört NUR in `script-src`. Alle drei
   * Cast-Skripte wurden heruntergeladen und durchgesehen; sie machen selbst
   * keine Anfragen. Stünde die Domain auch in `connect-src`, wäre eine Tür
   * offen, für die es keinen Grund gibt – und niemandem fiele es auf, weil
   * nichts kaputtginge.
   */
  const caddy = readFileSync(`${HIER}../Caddyfile`, 'utf8');
  const vercel = JSON.parse(readFileSync(`${HIER}../vercel.json`, 'utf8')) as {
    headers: { headers: { key: string; value: string }[] }[];
  };
  const ausVercel = vercel.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy')?.value;

  for (const [name, regel] of [
    ['Caddyfile', caddy.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? ''],
    ['vercel.json', ausVercel ?? ''],
  ] as const) {
    expect(regel, `${name}: keine Richtlinie gefunden`).not.toBe('');
    const teile = Object.fromEntries(
      regel
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
          const [kopf, ...rest] = t.split(/\s+/);
          return [kopf, rest.join(' ')];
        }),
    );
    expect(teile['script-src'], `${name}: gstatic fehlt in script-src`).toContain(
      'https://www.gstatic.com',
    );
    expect(teile['connect-src'] ?? '', `${name}: gstatic steht in connect-src`).not.toContain(
      'gstatic',
    );
    expect(teile['img-src'] ?? '', `${name}: gstatic steht in img-src`).not.toContain('gstatic');
    // Und die wichtigste Zeile bleibt sonst, wie sie war.
    expect(teile['default-src'], `${name}: default-src wurde aufgeweicht`).toBe("'self'");
    expect(teile['object-src'], `${name}: object-src wurde aufgeweicht`).toBe("'none'");
  }
});

test('die Datenschutzerklärung nennt Google beim Namen', async () => {
  /*
   * Die Erklärung ist keine Dekoration, sondern eine vertragliche Pflicht:
   * Google APIs ToS §3(d) verlangt ausdrücklich eine Datenschutzerklärung,
   * die beschreibt, welche Daten mit Google geteilt werden.
   *
   * Sie steht als Text im Rust-Dienst, also lässt sie sich hier lesen. Ein
   * Ablauftest sähe nur, dass eine Seite da ist – nicht, dass das Richtige
   * darauf steht.
   */
  const text = readFileSync(`${HIER}../../api/src/modules/datenschutz.rs`, 'utf8');
  for (const [was, muster] of [
    ['der Empfänger', /Google (Ireland|LLC)/],
    ['die Herkunft des Skripts', /gstatic\.com/],
    ['die übermittelten Daten', /IP-Adresse/],
    ['der Widerruf', /widerruf/i],
    ['die Markenangabe', /Google Cast is a trademark of Google LLC/],
    ['dass die Fotos NICHT über Google gehen', /nicht über Google/],
  ] as const) {
    expect(text, `in der Datenschutzerklärung fehlt: ${was}`).toMatch(muster);
  }
  /*
   * Und der Satz, der vorher pauschal war, darf nicht mehr pauschal
   * dastehen: „lädt nichts von fremden Servern" wäre mit Cast schlicht
   * falsch.
   */
  expect(
    text.includes('Die Seite lädt nichts von fremden Servern'),
    'der pauschale Satz steht noch da, obwohl es jetzt eine Ausnahme gibt',
  ).toBe(false);
});
