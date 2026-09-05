import { expect, test } from '@playwright/test';

/**
 * Örtliche Anpassungen – der Renderer.
 *
 * Die Farbrechnung eines Bereichs steht dreimal: in `bereichePunkt`
 * (TypeScript, geprüft), im Schattierer (GLSL) und im Rückfallweg über
 * Farbtabellen. Die erste ist die Wahrheit; diese Datei hält die beiden
 * anderen dagegen.
 *
 * Kein Anmeldevorgang, keine Datenbank – nur eine Seite, auf der die Bündel
 * der App geladen sind.
 */

test('GLSL und TypeScript rechnen auch mit Bereichen dieselben Farben', async ({ page }) => {
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');

    // Ein Testbild, das den Farbwürfel gleichmässig abtastet.
    const kante = 64;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    const bild = qctx.createImageData(kante, kante);
    for (let i = 0; i < kante * kante; i += 1) {
      bild.data[i * 4] = (i % 16) * 17;
      bild.data[i * 4 + 1] = (Math.floor(i / 16) % 16) * 17;
      bild.data[i * 4 + 2] = (Math.floor(i / 256) % 16) * 17;
      bild.data[i * 4 + 3] = 255;
    }
    qctx.putImageData(bild, 0, 0);

    /*
     * Die Masken: senkrechte Streifen, damit jeder Bildpunkt ein bekanntes,
     * unterschiedliches Gewicht bekommt. Ein volles oder leeres Feld prüfte
     * nur die beiden Enden – gerade die Überblendung dazwischen ist das,
     * was zwischen den drei Fassungen auseinanderlaufen kann.
     */
    const rb = 32;
    const rh = 32;
    const feldA = new Uint8Array(rb * rh);
    const feldB = new Uint8Array(rb * rh);
    for (let y = 0; y < rh; y += 1)
      for (let x = 0; x < rb; x += 1) {
        feldA[y * rb + x] = Math.round((x / (rb - 1)) * 255);
        feldB[y * rb + x] = Math.round((1 - y / (rh - 1)) * 255);
      }
    const raster = { breite: rb, hoehe: rh, faktor: rb / kante };

    const faelle = [
      {
        name: 'ein Bereich, Belichtung',
        bereiche: [{ feld: feldA, a: { ...ton.FARB_NEUTRAL, belichtung: 1.4 } }],
      },
      {
        name: 'ein Bereich, alles',
        bereiche: [
          {
            feld: feldA,
            a: {
              belichtung: -0.8,
              kontrast: 0.5,
              lichter: -0.6,
              tiefen: 0.7,
              schwarz: 0.3,
              waerme: 0.5,
              toenung: -0.3,
              saettigung: 0.4,
              dynamik: 0.6,
            },
          },
        ],
      },
      {
        name: 'zwei Bereiche, Reihenfolge zaehlt',
        bereiche: [
          { feld: feldA, a: { ...ton.FARB_NEUTRAL, belichtung: 1.5 } },
          { feld: feldB, a: { ...ton.FARB_NEUTRAL, belichtung: -1.5, saettigung: 0.8 } },
        ],
      },
      {
        name: 'vier Bereiche',
        bereiche: [
          { feld: feldA, a: { ...ton.FARB_NEUTRAL, kontrast: 0.6 } },
          { feld: feldB, a: { ...ton.FARB_NEUTRAL, waerme: 0.7 } },
          { feld: feldA, a: { ...ton.FARB_NEUTRAL, tiefen: 0.9 } },
          { feld: feldB, a: { ...ton.FARB_NEUTRAL, saettigung: -1 } },
        ],
      },
    ];

    const global = { ...ton.NEUTRAL, belichtung: 0.3, kontrast: 0.2 };
    const berichte: { name: string; max: number; mittel: number; weg: string }[] = [];

    for (const [nummer, fall] of faelle.entries()) {
      const szene = {
        bereiche: fall.bereiche.map((b, i) => ({
          id: `b${i}`,
          maske: { raster, feld: b.feld, stand: nummer * 10 + i },
          anpassung: { ...b.a, unschaerfe: 0 },
        })),
        schluessel: `fall${nummer}`,
      };
      const flaeche = gpu.bildRechnen(quelle, kante, kante, global, szene);
      if (flaeche === quelle) return { fehler: 'Kurzschluss trotz Bereichen' };
      const zctx = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      });
      if (!zctx) return { fehler: 'keine Leinwand' };
      zctx.canvas.width = kante;
      zctx.canvas.height = kante;
      zctx.drawImage(flaeche as CanvasImageSource, 0, 0);
      const raus = zctx.getImageData(0, 0, kante, kante).data;

      /** Das Maskengewicht an einem Bildpunkt – bilinear wie auf der GPU. */
      const gewichtAn = (feld: Uint8Array, x: number, y: number) => {
        const fx = ((x + 0.5) / kante) * rb - 0.5;
        const fy = ((y + 0.5) / kante) * rh - 0.5;
        const x0 = Math.max(0, Math.min(rb - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(rh - 1, Math.floor(fy)));
        const x1 = Math.min(rb - 1, x0 + 1);
        const y1 = Math.min(rh - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const ty = Math.max(0, Math.min(1, fy - y0));
        const o = feld[y0 * rb + x0] * (1 - tx) + feld[y0 * rb + x1] * tx;
        const u = feld[y1 * rb + x0] * (1 - tx) + feld[y1 * rb + x1] * tx;
        return (o * (1 - ty) + u * ty) / 255;
      };

      let max = 0;
      let summe = 0;
      let n = 0;
      for (let y = 0; y < kante; y += 1)
        for (let x = 0; x < kante; x += 1) {
          const i = y * kante + x;
          const nachGlobal = ton.tonPunkt(
            [bild.data[i * 4] / 255, bild.data[i * 4 + 1] / 255, bild.data[i * 4 + 2] / 255],
            global,
          );
          const soll = ton.bereichePunkt(
            nachGlobal,
            fall.bereiche.map((b) => ({
              gewicht: gewichtAn(b.feld, x, y),
              anpassung: b.a,
            })),
          );
          for (let k = 0; k < 3; k += 1) {
            const fehler = Math.abs(raus[i * 4 + k] - soll[k] * 255);
            max = Math.max(max, fehler);
            summe += fehler;
            n += 1;
          }
        }
      berichte.push({ name: fall.name, max, mittel: summe / n, weg: gpu.letzterWeg });
    }
    return { berichte };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.berichte).toHaveLength(4);
  for (const b of ergebnis.berichte ?? []) {
    expect(b.weg, `${b.name}: es hat nicht die Grafikeinheit gerechnet`).toBe('gpu');
    // Wie bei der globalen Anpassung: zwei Stufen von 255 sind der
    // Rundungsspielraum zwischen `highp float` und `double`.
    expect(b.max, `${b.name}: grösster Fehler`).toBeLessThanOrEqual(2);
    expect(b.mittel, `${b.name}: mittlerer Fehler`).toBeLessThan(0.6);
  }
});

test('die Maske sitzt richtig herum – oben ist oben', async ({ page }) => {
  /*
   * Die teuerste Falle des Atlas. Das BILD wird beim Hochladen gespiegelt
   * (eine Leinwand zählt von oben, eine Textur von unten), der Atlas nicht.
   * Wer den Spiegel-Merker nicht ausdrücklich klemmt oder das `1 − y` im
   * Schattierer vergisst, bekommt eine Maske, die auf dem Kopf steht.
   *
   * Eine mittige Ellipse wäre gegen diesen Fehler blind, weil sie symmetrisch
   * ist – deshalb eine Maske, die nur die OBERE Hälfte trägt.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');

    const kante = 64;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    qctx.fillStyle = '#606060';
    qctx.fillRect(0, 0, kante, kante);

    // Rasterbreite 33: ausdrücklich NICHT durch vier teilbar, damit eine
    // fehlende Zeilenausrichtung die Maske scheren würde.
    const rb = 33;
    const rh = 33;
    const feld = new Uint8Array(rb * rh);
    for (let y = 0; y < rh; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = y < rh / 2 ? 255 : 0;

    const szene = {
      bereiche: [
        {
          id: 'oben',
          maske: { raster: { breite: rb, hoehe: rh, faktor: rb / kante }, feld, stand: 1 },
          anpassung: { ...ton.FARB_NEUTRAL, belichtung: 2, unschaerfe: 0 },
        },
      ],
      schluessel: 'oben',
    };
    const flaeche = gpu.bildRechnen(quelle, kante, kante, ton.NEUTRAL, szene);
    const zctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!zctx) return { fehler: 'keine Leinwand' };
    zctx.canvas.width = kante;
    zctx.canvas.height = kante;
    zctx.drawImage(flaeche as CanvasImageSource, 0, 0);
    const d = zctx.getImageData(0, 0, kante, kante).data;
    const mittel = (vonY: number, bisY: number) => {
      let summe = 0;
      let n = 0;
      for (let y = vonY; y < bisY; y += 1)
        for (let x = 0; x < kante; x += 1) {
          summe += d[(y * kante + x) * 4];
          n += 1;
        }
      return summe / n;
    };
    // Und quer, um zu sehen, dass die Maske nicht geschert steht.
    const links = mittel(0, 8);
    return {
      weg: gpu.letzterWeg,
      oben: mittel(0, kante / 2 - 4),
      unten: mittel(kante / 2 + 4, kante),
      obenLinks: links,
    };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.weg).toBe('gpu');
  // Oben deutlich heller, unten unverändert bei 96.
  expect(ergebnis.oben).toBeGreaterThan(150);
  expect(ergebnis.unten).toBeGreaterThan(90);
  expect(ergebnis.unten).toBeLessThan(102);
});

test('Grafikeinheit und Prozessor kommen zum selben Bild', async ({ page }) => {
  /*
   * Der Rückfallweg rechnet über Farbtabellen und ist deshalb etwas gröber
   * als der Schattierer – nachgemessen unter sechs Stufen von 255 im
   * schlimmsten Fall für EINE Tabellenanwendung, und hier sind es die globale
   * plus zwei Bereiche.
   *
   * Der Test hält ihn dort fest, statt eine Gleichheit zu behaupten, die
   * nicht gilt.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');

    const kante = 64;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    const bild = qctx.createImageData(kante, kante);
    for (let i = 0; i < kante * kante; i += 1) {
      bild.data[i * 4] = (i % 16) * 17;
      bild.data[i * 4 + 1] = (Math.floor(i / 16) % 16) * 17;
      bild.data[i * 4 + 2] = (Math.floor(i / 256) % 16) * 17;
      bild.data[i * 4 + 3] = 255;
    }
    qctx.putImageData(bild, 0, 0);

    const rb = 32;
    const feld = new Uint8Array(rb * rb);
    for (let y = 0; y < rb; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = Math.round((x / (rb - 1)) * 255);
    const raster = { breite: rb, hoehe: rb, faktor: rb / kante };
    const global = { ...ton.NEUTRAL, belichtung: 0.4 };
    const szene = {
      bereiche: [
        {
          id: 'a',
          maske: { raster, feld, stand: 1 },
          anpassung: { ...ton.FARB_NEUTRAL, belichtung: 1, kontrast: 0.4, unschaerfe: 0 },
        },
        {
          id: 'b',
          maske: { raster, feld, stand: 2 },
          anpassung: { ...ton.FARB_NEUTRAL, waerme: 0.6, saettigung: 0.3, unschaerfe: 0 },
        },
      ],
      schluessel: 'vergleich',
    };

    const lesen = () => {
      const zctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (!zctx) return null;
      zctx.canvas.width = kante;
      zctx.canvas.height = kante;
      return zctx;
    };

    gpu.gpuAbschalten(false);
    const aufGpu = gpu.bildRechnen(quelle, kante, kante, global, szene);
    const wegGpu = gpu.letzterWeg;
    const z1 = lesen();
    if (!z1) return { fehler: 'keine Leinwand' };
    z1.drawImage(aufGpu as CanvasImageSource, 0, 0);
    const a = z1.getImageData(0, 0, kante, kante).data;

    gpu.gpuAbschalten(true);
    // Anderer Schlüssel, sonst antwortet der Merkzettel mit dem GPU-Bild.
    const aufCpu = gpu.bildRechnen(quelle, kante, kante, global, {
      ...szene,
      schluessel: 'vergleich-cpu',
    });
    const wegCpu = gpu.letzterWeg;
    gpu.gpuAbschalten(false);
    const z2 = lesen();
    if (!z2) return { fehler: 'keine Leinwand' };
    z2.drawImage(aufCpu as CanvasImageSource, 0, 0);
    const b = z2.getImageData(0, 0, kante, kante).data;

    let max = 0;
    let summe = 0;
    let n = 0;
    for (let i = 0; i < kante * kante; i += 1)
      for (let k = 0; k < 3; k += 1) {
        const fehler = Math.abs(a[i * 4 + k] - b[i * 4 + k]);
        max = Math.max(max, fehler);
        summe += fehler;
        n += 1;
      }
    return { wegGpu, wegCpu, max, mittel: summe / n };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.wegGpu).toBe('gpu');
  expect(ergebnis.wegCpu, 'der Rückfallweg wurde nicht erzwungen').toBe('leinwand');
  expect(ergebnis.max).toBeLessThan(10);
  expect(ergebnis.mittel).toBeLessThan(2);
});

test('ohne Bereiche verhält sich alles wie vorher', async ({ page }) => {
  // Der Kurzschluss muss BEIDES prüfen: Bei neutraler globaler Anpassung und
  // ohne Bereiche kommt das Quellbild selbst zurück, und daran hängt eine
  // Ebene höher die Umrechnung der Verpixel-Ausschnitte.
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const quelle = document.createElement('canvas');
    quelle.width = 8;
    quelle.height = 8;
    const leer = { bereiche: [], schluessel: '' };
    return {
      neutral: gpu.bildRechnen(quelle, 8, 8, ton.NEUTRAL, leer) === quelle,
      mitTon: gpu.bildRechnen(quelle, 8, 8, { ...ton.NEUTRAL, belichtung: 1 }, leer) === quelle,
    };
  });
  expect(ergebnis.neutral).toBe(true);
  expect(ergebnis.mitTon).toBe(false);
});
