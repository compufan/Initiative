import { crc32, deflateSync } from 'node:zlib';
import { expect, request, test, type Browser, type Page } from '@playwright/test';

/**
 * Miniaturbilder in der Kachelansicht – kommen sie wirklich an?
 *
 * # Warum das hier geprüft wird und nicht nur auf dem Server
 *
 * Die API-Prüfung weiss, dass die Route ein kleines JPEG herausgibt und
 * dieselbe Tür zuhält wie die Auslieferung. Was sie nicht sehen kann, ist das
 * Entscheidende: ob die Kachel es auch ANFRAGT. Genau das war der Zustand
 * vorher – die Kachel zeigte die eingebettete Vorschau von 160 Punkten, und
 * daneben wurde nie etwas Schärferes geholt.
 *
 * # Der Massstab
 *
 * Gemessen wird an `naturalWidth` des Bildes in der Kachel. Bei der
 * eingebetteten Vorschau steht dort 160; bei einem Miniaturbild vom Server
 * steht dort, was die Kachel wirklich braucht – auf einem Telefon mit
 * mehrfacher Punktdichte deutlich mehr.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

/** Ein einfarbiges PNG – klein genug für die eingebettete Vorschau. */
function flachesPng(kante: number): Buffer {
  return pngRoh(kante, () => [90, 110, 140]);
}

/** Ein verrauschtes PNG – so schlecht zu packen wie ein Foto. */
function pngAus(kante: number): Buffer {
  return pngRoh(kante, (x, y) => [
    (x * 7 + y * 13) % 256,
    (x * 29 + y * 3) % 256,
    (x * 5 + y * 31) % 256,
  ]);
}

function pngRoh(kante: number, farbe: (x: number, y: number) => number[]): Buffer {
  const roh = Buffer.alloc((kante * 3 + 1) * kante);
  let at = 0;
  for (let y = 0; y < kante; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < kante; x += 1) {
      const c = farbe(x, y);
      roh[at] = c[0];
      roh[at + 1] = c[1];
      roh[at + 2] = c[2];
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

/**
 * Anmelden durch die ECHTE Oberfläche – und nicht mit eingesetzten Token.
 *
 * Das ist hier kein Schönheitsfehler, sondern die Voraussetzung. Ein `<img>`
 * kann keinen `Authorization`-Kopf setzen; es weist sich mit dem Medien-Keks
 * aus, und den setzt die API in der Antwort auf die ANMELDUNG. Wer die Token
 * von aussen in den Browserspeicher legt, hat eine App, die angemeldet
 * aussieht und keinen Keks hat – jedes Bild vom Server bekommt dann 401.
 *
 * Und dieser 401 kommt als JSON. Chrome blockiert ein JSON, das ein `<img>`
 * angefordert hat, mit `ERR_BLOCKED_BY_ORB` – im Netzwerkfenster steht dann
 * eine Blockade, wo in Wahrheit eine fehlende Anmeldung steht. Genau daran
 * ist der erste Anlauf dieser Prüfung eine halbe Stunde lang hängen
 * geblieben.
 */
async function anmelden(browser: Browser, wurzel: string): Promise<{ seite: Page; token: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const seite = await (await browser.newContext()).newPage();
  await seite.goto(wurzel);
  await seite.getByRole('button', { name: /Noch kein Konto/ }).click();
  await seite.getByLabel('Benutzername').fill(`mini${suffix}`);
  await seite.getByLabel('Anzeigename').fill(`Mini ${suffix}`);
  await seite.getByLabel('Passwort', { exact: true }).fill('passwort123');
  await seite.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(seite.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  const token = await seite.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('initiative.tokens') ?? '{}') as { accessToken?: string })
        .accessToken ?? '',
  );
  expect(token, 'kein Zugangstoken im Browserspeicher').not.toBe('');
  return { seite, token };
}

test('eine Kachel zeigt ein Miniaturbild vom Server, nicht den eingebetteten Klecks', async ({
  browser,
  baseURL,
}) => {
  const wurzel = baseURL ?? 'http://localhost:5173';
  const http = await request.newContext();
  const { seite, token } = await anmelden(browser, wurzel);
  const kopf = { authorization: `Bearer ${token}` };

  const daten = pngAus(1200);
  const upload = await (
    await http.post(`${API}/media/uploads`, {
      headers: kopf,
      data: { kind: 'image', mime: 'image/png', size: daten.length, fileName: 'gross.png' },
    })
  ).json();
  const hoch = await http.post(`${API}/media/uploads/${upload.attachmentId}/data`, {
    headers: kopf,
    multipart: { file: { name: 'gross.png', mimeType: 'image/png', buffer: daten } },
  });
  expect(hoch.ok(), `Hochladen: ${hoch.status()}`).toBeTruthy();
  /*
   * Eine eingebettete Vorschau von 160 Punkten dazu – genau die, die vorher
   * das endgültige Bild der Kachel war. Ohne sie wäre der Vergleich unten
   * keiner.
   */
  const fertig = await http.post(`${API}/media/uploads/${upload.attachmentId}/complete`, {
    headers: kopf,
    data: {
      width: 1200,
      height: 1200,
      /*
       * Ein GLATTES Bild als Vorschau, nicht dasselbe Rauschen wie oben.
       *
       * Die eingebettete Vorschau ist eine data-URL in einer Textspalte und
       * hat eine harte Obergrenze (`LIMITS.previewDataUrlMax`). Ein
       * verrauschtes PNG von 160 Punkten sind base64 rund hundert Kilobyte –
       * die API weist es ab, `complete` scheitert, der Anhang bleibt
       * unfertig, und die Kachel erscheint gar nicht. Genau daran ist der
       * erste Anlauf gescheitert, und die Fehlermeldung sagte nur „element
       * not found".
       */
      previewDataUrl: 'data:image/png;base64,' + flachesPng(160).toString('base64'),
    },
  });
  expect(fertig.ok(), `Abschliessen: ${fertig.status()} ${await fertig.text()}`).toBeTruthy();

  const sammlung = await (
    await http.post(`${API}/collections`, {
      headers: kopf,
      data: { name: `Kacheln ${Date.now()}` },
    })
  ).json();
  const rein = await http.post(`${API}/collections/${sammlung.id}/items`, {
    headers: kopf,
    data: { attachmentId: upload.attachmentId },
  });
  expect(rein.ok(), `Einlegen: ${rein.status()}`).toBeTruthy();

  await seite.goto(`${wurzel}/dateien/${sammlung.id}`);

  const kachel = seite.locator('.fil-thumb-stapel img:not(.fil-thumb-klecks)').first();
  await expect(kachel).toBeAttached({ timeout: 20_000 });
  // `loading="lazy"`: Was nicht zu sehen ist, wird auch nicht geholt.

  /*
   * Es kommt wirklich vom Server. Ein `data:`-Verweis wäre wieder die
   * eingebettete Vorschau, nur an anderer Stelle.
   */
  const quelle = await kachel.getAttribute('src');
  expect(quelle, `die Kachel holt nichts vom Server: ${quelle}`).toContain('/miniatur?kante=');

  /*
   * Und es kommt in der Grösse, die die Kachel verlangt hat.
   *
   * Hier stand `toBeGreaterThan(160)`, und das konnte auf einem Bildschirm
   * ohne doppelte Punktdichte gar nicht stimmen: `miniaturSrc` multipliziert
   * die 160 der Kachel mit der Dichte, auf einem gewöhnlichen Schirm ist die
   * eins, also verlangt sie 160 – und bekommt 160. Der Test schlug damit im
   * Profil „Desktop Chrome" zuverlässig fehl und im Profil „Pixel 7"
   * zuverlässig nicht.
   *
   * Die Behauptung, um die es geht, ist ohnehin eine andere: Die Kachel zeigt,
   * was sie beim Server bestellt hat, und nicht den eingebetteten Klecks. Dass
   * es nicht der Klecks ist, steht eine Zeile höher (`data:` wäre er); dass
   * der Server die Bestellung ernst nimmt, steht hier.
   */
  const bestellt = Number(new URL(quelle!, wurzel).searchParams.get('kante'));
  expect(bestellt, `keine Kantenlänge in ${quelle}`).toBeGreaterThanOrEqual(160);
  await expect
    .poll(async () => kachel.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 20_000,
      message: 'in der Kachel steht kein geladenes Miniaturbild',
    })
    .toBe(bestellt);

  /*
   * Der Klecks liegt DARUNTER und bleibt liegen. Ohne ihn blitzte beim
   * Blättern durch einen Ordner an jeder Kachel eine leere Fläche auf.
   */
  await expect(seite.locator('.fil-thumb-klecks').first()).toBeAttached();
});
