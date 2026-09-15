import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { LIMITS } from '@initiative/shared';

/**
 * Die eingebettete Vorschau: gross genug zum Ansehen, klein genug zum
 * Mitschicken.
 *
 * # Warum das im Browser geprüft wird
 *
 * `prepareImage` braucht eine Leinwand, `createImageBitmap` und
 * `canvas.toDataURL`. Unter `environment: 'node'` gibt es davon nichts, und
 * es nachzubauen hiesse, die Nachbildung zu prüfen statt den Code.
 *
 * # Was hier zusammengehalten wird
 *
 * Zwei Zahlen, die in verschiedene Richtungen ziehen. Zu klein, und die
 * Vorschau ist ein Brei – an drei Stellen sogar dauerhaft, weil dort nie ein
 * scharfes Bild nachgeladen wird (Video im Chat, Dateiliste, Auswahl vor dem
 * Senden). Zu gross, und sie fährt in jeder Nachrichtenliste mit: Sie ist
 * eine data-URL und liegt je Anhang in einer Textspalte.
 */

function pngAus(breite: number, hoehe: number): Buffer {
  const roh = Buffer.alloc((breite * 3 + 1) * hoehe);
  let at = 0;
  for (let y = 0; y < hoehe; y += 1) {
    roh[at] = 0;
    at += 1;
    for (let x = 0; x < breite; x += 1) {
      // Ein unruhiges Bild – ein glattes liesse sich unrealistisch gut packen
      // und die gemessene Grösse wäre geschönt.
      roh[at] = (x * 7 + y * 13) % 256;
      roh[at + 1] = (x * 29 + y * 3) % 256;
      roh[at + 2] = (x * 5 + y * 31) % 256;
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

test('die eingebettete Vorschau ist scharf genug und bleibt weit unter der Grenze', async ({
  page,
}) => {
  await page.goto('/');

  const bild = pngAus(1600, 1200).toString('base64');
  const ergebnis = await page.evaluate(async (base64) => {
    const ladeUpload = '/src/lib/upload.ts';
    const upload = (await import(
      /* @vite-ignore */ ladeUpload
    )) as typeof import('../src/lib/upload.js');

    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const datei = new File([bytes], 'probe.png', { type: 'image/png' });
    const fertig = await upload.prepareImage(datei, 1920, false);

    // Die Kantenlänge des Platzhalters selbst – dafür muss er einmal geladen
    // werden, denn die Zahl steht nirgends im Text.
    const vorschau = new Image();
    await new Promise((auf, ab) => {
      vorschau.onload = auf;
      vorschau.onerror = ab;
      vorschau.src = fertig.previewDataUrl ?? '';
    });

    return {
      zeichen: (fertig.previewDataUrl ?? '').length,
      kante: Math.max(vorschau.naturalWidth, vorschau.naturalHeight),
      breite: fertig.width,
      hoehe: fertig.height,
    };
  }, bild);

  /*
   * Gross genug: Der Rahmen im Chat ist `min(74vw, 320px)`. Bei 160 Punkten
   * Kante wird daraus eine Vergrösserung von 1,8 statt der 6,1, mit denen es
   * anfing. Unter 120 wäre die Beschwerde wieder da.
   */
  expect(ergebnis.kante, 'die Vorschau ist zu klein zum Ansehen').toBeGreaterThanOrEqual(120);

  /*
   * Und klein genug. Die Grenze gilt auf beiden Seiten – die API weist eine
   * zu lange data-URL ab (`media.rs`), und dann hinge der Anhang ohne
   * Vorschau im Chat.
   */
  expect(ergebnis.zeichen).toBeLessThan(LIMITS.previewDataUrlMax);
  /*
   * Mit deutlichem Abstand, nicht knapp: Ein Foto mit viel Rauschen packt
   * schlechter als dieses hier. Ein Viertel der Grenze lässt dafür Luft.
   */
  expect(
    ergebnis.zeichen,
    'die Vorschau frisst zu viel von der Nachrichtenliste',
  ).toBeLessThan(LIMITS.previewDataUrlMax / 4);
});
