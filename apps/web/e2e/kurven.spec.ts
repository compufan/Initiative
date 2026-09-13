import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Kurven und Farbbänder – von der Bedienung bis zum Bildpunkt.
 *
 * Dass die Rechnung stimmt, prüft `ton.spec.ts` auf beiden Wegen bis auf zwei
 * Stufen von 255. Hier geht es um die Strecke davor: Kommt ein gezogener
 * Kurvenpunkt überhaupt bis zur Leinwand? Ein Kurvenfeld, in dem sich Punkte
 * schön verschieben lassen und in dem sich nichts am Bild ändert, wäre kein
 * Werkzeug, sondern eine Zeichnung.
 *
 * Und für die Bänder das, was sie von einem Sättigungsregler unterscheidet:
 * Der eine Farbbereich ändert sich, der andere NICHT. Ein Band, das auf alles
 * wirkt, hat genau dann versagt, wenn es am besten aussieht.
 */

function pngAus(
  breite: number,
  hoehe: number,
  farbe: (x: number, y: number) => [number, number, number],
): Buffer {
  const roh = Buffer.alloc((breite * 3 + 1) * hoehe);
  let at = 0;
  for (let y = 0; y < hoehe; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < breite; x += 1) {
      const [r, g, b] = farbe(x, y);
      roh[at] = r;
      roh[at + 1] = g;
      roh[at + 2] = b;
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
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(hoehe, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  block('IHDR', ihdr);
  block('IDAT', deflateSync(roh));
  block('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...bloecke]);
}

/** Mittelgrau – für die Kurve, weil sich daran jede Anhebung ablesen lässt. */
const GRAU = pngAus(320, 240, () => [110, 110, 110]);

/**
 * Links Rot, rechts Grün – für die Bänder.
 *
 * Beide mit derselben Helligkeit und derselben Sättigung angesetzt: Wäre eine
 * Hälfte blasser, könnte ein Band, das auf ALLES wirkt, trotzdem wie ein
 * selektives aussehen.
 */
const ROT_GRUEN = pngAus(320, 240, (x) => (x < 160 ? [200, 60, 60] : [60, 200, 60]));

function credentials(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}${suffix}`,
    password: 'passwort123',
    displayName: `${prefix.toUpperCase()} ${suffix}`,
  };
}

async function signUp(browser: Browser, user: ReturnType<typeof credentials>): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(user.username);
  await page.getByLabel('Anzeigename').fill(user.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  return page;
}

/** Editor auf einem Bild aus der Auswahl – der kürzeste Weg dorthin. */
async function editorMit(browser: Browser, prefix: string, bild: Buffer): Promise<Page> {
  const alice = credentials(prefix);
  const bob = credentials(`${prefix}e`);
  const page = await signUp(browser, alice);
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();
  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await page.getByText('Foto/Video').click();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'probe.png', mimeType: 'image/png', buffer: bild });
  await page.locator('.media-tile-knopf').first().click();
  await expect(page.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Ton$/ }).click();
  return page;
}

/** Die mittleren Kanalwerte einer Bildhälfte auf der Arbeitsleinwand. */
async function haelfte(page: Page, seite: 'links' | 'rechts') {
  return await page
    .locator('.bild-leinwand')
    .first()
    .evaluate((el, welche) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      const d = ctx?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return { r: -1, g: -1, b: -1 };
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 0; y < c.height; y += 1) {
        // Der mittlere Streifen jeder Hälfte: Am Rand und an der Naht sitzen
        // Übergangspunkte, und die gehören zu keiner der beiden Farben.
        const von = welche === 'links' ? Math.round(c.width * 0.1) : Math.round(c.width * 0.6);
        const bis = welche === 'links' ? Math.round(c.width * 0.4) : Math.round(c.width * 0.9);
        for (let x = von; x < bis; x += 1) {
          const at = (y * c.width + x) * 4;
          if (d[at + 3] < 200) continue;
          r += d[at];
          g += d[at + 1];
          b += d[at + 2];
          n += 1;
        }
      }
      return n > 0 ? { r: r / n, g: g / n, b: b / n } : { r: -1, g: -1, b: -1 };
    }, seite);
}

/** Wie bunt eine Farbe ist – Maximum minus Minimum, in 0 … 255. */
function buntheit(farbe: { r: number; g: number; b: number }): number {
  return Math.max(farbe.r, farbe.g, farbe.b) - Math.min(farbe.r, farbe.g, farbe.b);
}

test('ein gezogener Kurvenpunkt hellt das Bild auf', async ({ browser }) => {
  const page = await editorMit(browser, 'kurv', GRAU);

  /*
   * Ein `summary` ist kein Knopf.
   *
   * `getByRole('button')` findet es nicht – es hat gar keine Rolle, die eine
   * Vorlesehilfe als Knopf meldet. Angeklickt wird es trotzdem, und genau so
   * bedient es auch ein Mensch.
   */
  await page.locator('.bild-klapp > summary', { hasText: 'Kurven' }).click();
  const feld = page.locator('.bild-kurve-feld');
  await expect(feld).toBeVisible();

  const vorher = (await haelfte(page, 'links')).r;
  expect(vorher).toBeGreaterThan(95);
  expect(vorher).toBeLessThan(125);

  /*
   * In die Mitte fassen und nach OBEN ziehen.
   *
   * Oben ist hell: Eine Leinwand zählt von oben, eine Kurve von unten, und
   * genau diese Umdrehung ist die Stelle, an der man sich verrechnet. Zöge
   * der Zug das Bild dunkler, stünde hier die Antwort darauf.
   */
  /*
   * Erst in den Blick rollen, DANN messen.
   *
   * Das Kurvenfeld steht unten in einem aufklappbaren Abschnitt und liegt
   * nach dem Aufklappen halb ausserhalb des sichtbaren Bereichs.
   * `boundingBox` liefert dann Koordinaten, die zwar im Fenster liegen, aber
   * nicht dort, wo das Feld nach dem Rollen steht – und die Maus landet
   * daneben, ohne dass irgendetwas fehlschlägt.
   */
  await feld.scrollIntoViewIfNeeded();
  const kasten = await feld.boundingBox();
  if (!kasten) throw new Error('kein Kurvenfeld');
  await page.mouse.move(kasten.x + kasten.width * 0.5, kasten.y + kasten.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(kasten.x + kasten.width * 0.5, kasten.y + kasten.height * 0.22, {
    steps: 10,
  });
  await page.mouse.up();

  await expect
    .poll(async () => (await haelfte(page, 'links')).r, { timeout: 10_000 })
    .toBeGreaterThan(vorher + 40);

  // „Gerade" nimmt es zurück – der Weg zurück ohne Rückgängig.
  await page.getByRole('button', { name: 'Gerade' }).click();
  await expect
    .poll(async () => (await haelfte(page, 'links')).r, { timeout: 10_000 })
    .toBeLessThan(vorher + 12);

  await page.context().close();
});

test('ein Farbband trifft nur seine Farbe', async ({ browser }) => {
  const page = await editorMit(browser, 'band', ROT_GRUEN);

  await page.locator('.bild-klapp > summary', { hasText: 'Farben einzeln' }).click();
  const rotVorher = await haelfte(page, 'links');
  const gruenVorher = await haelfte(page, 'rechts');
  expect(buntheit(rotVorher)).toBeGreaterThan(80);
  expect(buntheit(gruenVorher)).toBeGreaterThan(80);

  // Grün wählen und ganz entsättigen.
  await page.getByRole('button', { name: 'Grün', exact: true }).click();
  /*
   * „Sättigung" steht zweimal auf dem Schirm: einmal als globaler Regler,
   * einmal im Band. Ohne die Eingrenzung auf den Klappabschnitt zöge der Test
   * am falschen – und bestünde dabei sogar, weil Grün dann auch blasser wird.
   * Er würde nur nicht mehr messen, was er behauptet.
   */
  const saettigung = page
    .locator('.bild-klapp')
    .filter({ has: page.locator('summary', { hasText: 'Farben einzeln' }) })
    .getByLabel('Sättigung')
    .first();
  await saettigung.fill('-1');
  await saettigung.dispatchEvent('change');

  await expect
    .poll(async () => buntheit(await haelfte(page, 'rechts')), { timeout: 10_000 })
    .toBeLessThan(20);

  /*
   * Und die andere Hälfte steht noch da, wo sie war.
   *
   * Das ist die eigentliche Aussage. Ein Band, das sich wie der globale
   * Sättigungsregler verhält, bestünde die erste Messung mühelos – und wäre
   * trotzdem wertlos.
   */
  const rotNachher = await haelfte(page, 'links');
  expect(buntheit(rotNachher)).toBeGreaterThan(buntheit(rotVorher) - 12);

  await page.context().close();
});

/**
 * Die mittlere Helligkeit jeder Kachel in der Auswahl.
 *
 * Gelesen wird aus dem `<img>` der Kachel, also aus genau dem, was der
 * Anwender sieht – nicht aus einem Zwischenstand im Speicher.
 */
async function kachelHelligkeiten(page: Page): Promise<number[]> {
  return await page.locator('.media-tile img').evaluateAll((els) =>
    els.map((el) => {
      const bild = el as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return -1;
      ctx.drawImage(bild, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let summe = 0;
      for (let i = 0; i < 16 * 16; i += 1) summe += d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
      return summe / (16 * 16) / 3;
    }),
  );
}

test('Licht und Farbe lassen sich auf die ganze Auswahl übertragen', async ({ browser }) => {
  /*
   * Stapelarbeit: zwanzig Aufnahmen im selben Licht, eine eingestellt, alle
   * bekommen es.
   *
   * Der Test prüft zwei Dinge, und das zweite ist das wichtigere:
   *
   *   1. Die anderen Bilder ändern sich überhaupt.
   *   2. Sie ändern sich GENAUSO STARK wie das eine, an dem eingestellt
   *      wurde. Würde die Reihe auf der schon bearbeiteten Fassung statt auf
   *      dem Original rechnen, käme beim ersten Bild alles doppelt heraus –
   *      und das sähe nach „wirkt“ aus, nicht nach einem Fehler.
   */
  const alice = credentials('stap');
  const bob = credentials('stape');
  const page = await signUp(browser, alice);
  await signUp(browser, bob);
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByPlaceholder('Wen möchtest du anschreiben?').fill(bob.username);
  await page.getByText(bob.displayName).first().click();
  await expect(page.getByPlaceholder('Nachricht schreiben')).toBeVisible();

  await page.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await page.getByText('Foto/Video').click();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: GRAU },
    { name: 'b.png', mimeType: 'image/png', buffer: GRAU },
    { name: 'c.png', mimeType: 'image/png', buffer: GRAU },
  ]);
  await expect(page.locator('.media-tile')).toHaveCount(3);
  const vorher = await kachelHelligkeiten(page);
  for (const wert of vorher) {
    expect(wert).toBeGreaterThan(95);
    expect(wert).toBeLessThan(125);
  }

  /*
   * Zuerst das erste Bild WIRKLICH bearbeiten – mit „Übernehmen".
   *
   * Das ist der Fall, um den es geht: Danach steht die Aufhellung in seinen
   * Bildpunkten. Würde die Reihe gleich darauf weiterrechnen statt auf dem
   * Original, käme sie beim ersten Bild doppelt heraus. Ohne diesen Schritt
   * wäre `blob` überall noch dasselbe wie `original`, und der Test könnte
   * den Unterschied gar nicht sehen.
   */
  await page.locator('.media-tile-knopf').first().click();
  await expect(page.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Ton$/ }).click();
  const erste = page.getByLabel('Belichtung').first();
  await erste.fill('1.5');
  await erste.dispatchEvent('change');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByText('Bearbeitete Fassung übernommen.')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await kachelHelligkeiten(page))[0], { timeout: 30_000 })
    .toBeGreaterThan(vorher[0] + 30);

  // Jetzt am ZWEITEN Bild dasselbe einstellen und auf alle übertragen.
  await page.locator('.media-tile-knopf').nth(1).click();
  await expect(page.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Ton$/ }).click();
  const belichtung = page.getByLabel('Belichtung').first();
  await belichtung.fill('1.5');
  await belichtung.dispatchEvent('change');

  const knopf = page.getByRole('button', { name: /Auf alle 3/ });
  await expect(knopf).toBeVisible();
  await knopf.click();

  // Der Editor bleibt offen – „übertragen" und „übernehmen" sind zwei
  // Entscheidungen. Er wird hier geschlossen, ohne das eine Bild zu sichern.
  await expect(page.getByText(/übertragen\./)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Schließen' }).first().click();
  await page.getByRole('button', { name: 'Verwerfen' }).click();

  await expect
    .poll(async () => Math.min(...(await kachelHelligkeiten(page))), { timeout: 30_000 })
    .toBeGreaterThan(vorher[0] + 30);

  /*
   * Und alle drei gleich hell – das ist die Aussage über das Original.
   *
   * Bei einer Reihe, die auf der bearbeiteten Fassung rechnete, stünde das
   * erste Bild deutlich über den anderen beiden.
   */
  const nachher = await kachelHelligkeiten(page);
  const spanne = Math.max(...nachher) - Math.min(...nachher);
  expect(spanne, 'die drei Bilder sind unterschiedlich hell geworden').toBeLessThan(4);

  await page.context().close();
});
