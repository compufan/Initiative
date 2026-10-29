import { expect, test, type Page } from '@playwright/test';

/**
 * Örtliche Anpassungen – der Renderer.
 *
 * Die Farbrechnung eines Bereichs steht dreimal: in `bereichePunkt`
 * (TypeScript, geprüft), im Schattierer (GLSL) und im Rückfallweg über
 * Farbtabellen. Die erste ist die Wahrheit; diese Datei hält die beiden
 * anderen dagegen.
 *
 * Dazu kommen die zwei Unschärfen („Weichzeichnen“ und „Bokeh“, siehe weiter
 * unten): Sie rechnen in einer eigenen Vorstufe (`unscharf.ts` für den
 * Prozessor, `unscharfGpu.ts` für die Grafikeinheit, dieselben Durchgänge), und
 * diese Datei hält ihre Abnahmezahlen fest.
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
    /*
     * Quelle UND Ablesen im Arbeitsraum – nicht in sRGB.
     *
     * Seit die Kette in Display-P3 rechnet, sind „die Zahlen im Bild" und
     * „die Zahlen, die der Schattierer sieht" nicht mehr dasselbe, solange
     * eine sRGB-Leinwand dazwischenliegt. Geprüft wird hier die FORMEL: Also
     * bekommt `tonPunkt` genau die Zahlen, mit denen auch gerechnet wurde.
     */
    const ladeRaum = '/src/modules/bild/farbraum.ts';
    const raum = (await import(
      /* @vite-ignore */ ladeRaum
    )) as typeof import('../src/modules/bild/farbraum.js');
    const qctx = raum.flaeche2d(quelle);
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
              // Der Kanalmischer gehört ausdrücklich mit in den Fall „alles“:
              // Der Paritätstest baut seine übrigen Fälle aus NEUTRAL plus
              // EINEM Regler, und neue Felder blieben dort stumm auf null –
              // Grafikeinheit und Prozessor könnten auseinanderlaufen, ohne
              // dass hier etwas rot wird.
              swRot: 0.6,
              swGruen: -0.3,
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
      {
        name: 'Schwarz-Weiss mit Rotfilter',
        bereiche: [
          { feld: feldA, a: { ...ton.FARB_NEUTRAL, saettigung: -1, swRot: 0.85 } },
          { feld: feldB, a: { ...ton.FARB_NEUTRAL, saettigung: -1, swGruen: 0.7 } },
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
          anpassung: { ...b.a, unschaerfe: 0, bokeh: 0 },
        })),
        schluessel: `fall${nummer}`,
      };
      const flaeche = gpu.bildRechnen(quelle, kante, kante, global, szene);
      if (flaeche === quelle) return { fehler: 'Kurzschluss trotz Bereichen' };
      const zctx = raum.flaeche2d(document.createElement('canvas'), {
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
  expect(ergebnis.berichte).toHaveLength(5);
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
          anpassung: { ...ton.FARB_NEUTRAL, belichtung: 2, unschaerfe: 0, bokeh: 0 },
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
    /*
     * Quelle UND Ablesen im Arbeitsraum – nicht in sRGB.
     *
     * Seit die Kette in Display-P3 rechnet, sind „die Zahlen im Bild" und
     * „die Zahlen, die der Schattierer sieht" nicht mehr dasselbe, solange
     * eine sRGB-Leinwand dazwischenliegt. Geprüft wird hier die FORMEL: Also
     * bekommt `tonPunkt` genau die Zahlen, mit denen auch gerechnet wurde.
     */
    const ladeRaum = '/src/modules/bild/farbraum.ts';
    const raum = (await import(
      /* @vite-ignore */ ladeRaum
    )) as typeof import('../src/modules/bild/farbraum.js');
    const qctx = raum.flaeche2d(quelle);
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
          anpassung: { ...ton.FARB_NEUTRAL, belichtung: 1, kontrast: 0.4, unschaerfe: 0, bokeh: 0 },
        },
        {
          id: 'b',
          maske: { raster, feld, stand: 2 },
          anpassung: { ...ton.FARB_NEUTRAL, waerme: 0.6, saettigung: 0.3, unschaerfe: 0, bokeh: 0 },
        },
      ],
      schluessel: 'vergleich',
    };

    const lesen = () => {
      const zctx = raum.flaeche2d(document.createElement('canvas'), { willReadFrequently: true });
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

/*
 * ---------- Weichzeichnen und Bokeh ----------
 *
 * Zwei Regler je Bereich, eine Rechnung (`unscharf.ts` auf dem Prozessor,
 * `unscharfGpu.ts` auf der Grafikeinheit). Vorher zeigte eine Netzmaske beim
 * Weichzeichnen 92 % der Bildpunkte ausserhalb leicht verändert, holte 40 %
 * Fremdfarbe in den Saum und machte aus einem Lichtpunkt eine körnige Scheibe.
 * Die Tests hier halten die Abnahmezahlen des Entwurfs fest – an Szenen und
 * Massen aus `hilfen/unscharfMessen.ts`, gerechnet vom echten Renderer.
 *
 * Abstände in Bildpunkten bei 1200 Punkten Kantenlänge; das Messgerät rechnet
 * auf die Grösse der Szene um.
 */

/** Das Messgerät der Unschärfe: im Browser über den Entwicklungsserver geladen, wie `buehne.ts`. */
const MESSGERAET = '/e2e/hilfen/unscharfMessen.ts';
type Messgeraet = typeof import('./hilfen/unscharfMessen.js');

/** Ein Fall der Netzmasken-Reihe, wie ihn der Test aus dem Browser zurückbekommt. */
interface NetzFall {
  name: string;
  maskenBreite: number;
  ab: import('./hilfen/unscharfMessen.js').MassAB;
  kante: import('./hilfen/unscharfMessen.js').Kante;
  original: import('./hilfen/unscharfMessen.js').Kante;
  weg: string;
}

interface Messungen {
  netz: NetzFall[];
  lichter: Record<string, import('./hilfen/unscharfMessen.js').Lichter | null>;
}

/**
 * Die Messreihe der Netzmasken, einmal je Prozess.
 *
 * Fünf Tests lesen verschiedene Zahlen daraus – jeder für sich zu rechnen
 * kostete das Fünffache für nichts. Der erste, der sie braucht, rechnet sie auf
 * SEINER Seite; die anderen bekommen dasselbe Ergebnis. Gerechnet wird bei 1200
 * × 900 auf der Grafikeinheit (das ist, was die Schwellen des Entwurfs
 * beschreiben); der Prozessorweg rechnet dasselbe Bild – das hält der
 * Paritätstest weiter unten fest.
 */
let messungenZettel: Promise<Messungen> | null = null;
function netzMessungen(page: Page): Promise<Messungen> {
  messungenZettel ??= (async () => {
    await page.goto('/');
    return page.evaluate(async (pfad) => {
      const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
      const faelle: [
        string,
        Partial<import('../src/modules/bild/doc.js').Bereichston>,
        string,
        string,
      ][] = [
        ['Bokeh, Grund, Netz', { bokeh: 1 }, 'netz', 'grund'],
        ['Bokeh, Motiv, Netz', { bokeh: 1 }, 'netz', 'motiv'],
        ['Bokeh, Grund, Video', { bokeh: 1 }, 'video', 'grund'],
        ['Bokeh, Grund, breiter Saum', { bokeh: 1 }, 'netzbreit', 'grund'],
        ['Weichzeichnen, Grund, Netz', { unschaerfe: 1 }, 'netz', 'grund'],
        ['Weichzeichnen, Motiv, Netz', { unschaerfe: 1 }, 'netz', 'motiv'],
        ['Weichzeichnen, Grund, Video', { unschaerfe: 1 }, 'video', 'grund'],
        ['Weichzeichnen, Grund, breiter Saum', { unschaerfe: 1 }, 'netzbreit', 'grund'],
        ['beide, Grund, Netz', { unschaerfe: 1, bokeh: 1 }, 'netz', 'grund'],
        ['beide, Motiv, Netz', { unschaerfe: 0.6, bokeh: 0.6 }, 'netz', 'motiv'],
      ];
      const netz: NetzFall[] = [];
      for (const [name, par, maske, ziel] of faelle) {
        const f = m.fall({
          art: 'A',
          W: 1200,
          maske: maske as import('./hilfen/unscharfMessen.js').MaskenArt,
          ziel: ziel as 'motiv' | 'grund',
          par,
          wege: ['gpu'],
        });
        netz.push({
          name,
          maskenBreite: f.maskeKante.breite,
          ab: f.weg.gpu.ab,
          kante: f.weg.gpu.kante,
          original: f.original,
          weg: f.weg.gpu.gerechnet,
        });
      }
      const lichter: Messungen['lichter'] = {};
      for (const guete of ['hoch', 'mittel', 'niedrig'] as const) {
        const f = m.fall({
          art: 'B',
          W: 1200,
          maske: 'netz',
          ziel: 'grund',
          par: { bokeh: 1 },
          wege: ['gpu'],
          guete,
        });
        lichter[guete] = f.weg.gpu.lichter;
      }
      return { netz, lichter };
    }, MESSGERAET);
  })();
  return messungenZettel;
}

test('Weichzeichnen und Bokeh bleiben in der Maske und holen nichts von draussen herein', async ({
  page,
}) => {
  /*
   * Das Testbild trägt SENKRECHTE STREIFEN über die ganze Fläche – ein
   * einfarbiger Hintergrund könnte Unschärfe gar nicht zeigen. Gemessen wird
   * die Schwankung innerhalb einer Zeile: Streifen haben eine hohe,
   * verwischte Streifen eine niedrige.
   *
   * Zwei Eigenschaften, und die zweite ist die schwerere:
   *
   * 1. Wo die Maske greift, verschwinden die Streifen.
   * 2. Wo sie NICHT greift, bleibt jedes Byte, wie es war – und was im
   *    Bereich liegt, mischt sich nicht mit dem, was daneben liegt. Das ist
   *    der Heiligenschein, den ein Porträtmodus bekommt, wenn er die Farbe des
   *    scharfen Motivs in den weichen Hintergrund blutet.
   *
   * Die beiden Hälften liegen bei GANZ verschiedenen Helligkeiten: links dunkel
   * (0/90), rechts hell (165/255) – gleicher Hub, ganz verschiedene
   * Mittelwerte. Das ist Bedingung, nicht Zierde: Sähen beide Hälften gleich
   * aus, könnte man nicht messen, ob Farbe von links nach rechts blutet.
   *
   * Die Maske ist eine Silhouette (`reinheit` 0), wie die eines Netzes: Nur
   * dort zählt ein Bildpunkt als Quelle, wo die Maske sicher greift.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const kante = 256;
    const daten = new Uint8ClampedArray(kante * kante * 4);
    for (let y = 0; y < kante; y += 1)
      for (let x = 0; x < kante; x += 1) {
        const hell = Math.floor(x / 3) % 2 === 0;
        const wert = x < kante / 2 ? (hell ? 0 : 90) : hell ? 165 : 255;
        daten.set([wert, wert, wert, 255], (y * kante + x) * 4);
      }

    // Die Maske deckt GENAU die rechte Hälfte, auf einem gröberen Raster.
    const rb = 128;
    const feld = new Uint8Array(rb * rb);
    for (let y = 0; y < rb; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = x >= rb / 2 ? 255 : 0;

    /** Die mittlere Schwankung zwischen Nachbarn in einer Zeile. */
    const schwankung = (d: Uint8ClampedArray, x0: number, x1: number) => {
      let summe = 0;
      let n = 0;
      const y = Math.floor(kante / 2);
      for (let x = x0; x < x1 - 1; x += 1) {
        summe += Math.abs(d[(y * kante + x) * 4] - d[(y * kante + x + 1) * 4]);
        n += 1;
      }
      return summe / n;
    };
    /** Der Mittelwert eines senkrechten Bandes. */
    const mittel = (d: Uint8ClampedArray, x0: number, x1: number) => {
      let summe = 0;
      let n = 0;
      for (let y = 0; y < kante; y += 1)
        for (let x = x0; x < x1; x += 1) {
          summe += d[(y * kante + x) * 4];
          n += 1;
        }
      return summe / n;
    };

    const varianten = {
      Bokeh: { bokeh: 1 },
      Weichzeichnen: { unschaerfe: 1 },
      beide: { bokeh: 1, unschaerfe: 1 },
    };
    const aus: Record<
      string,
      {
        weg: string;
        links: number;
        rechtsVorher: number;
        rechtsNachher: number;
        randVorher: number;
        randNachher: number;
        linksVeraendert: number;
      }
    > = {};
    for (const [name, par] of Object.entries(varianten)) {
      for (const weg of ['gpu', 'cpu'] as const) {
        const szene = m.handSzene(feld, kante, kante, par, { reinheit: 0, rb, rh: rb });
        const r = m.rendern(daten, kante, kante, szene, weg);
        // Links, bis zum letzten Bildpunkt vor der Grenze: kein Byte darf sich ändern.
        let linksVeraendert = 0;
        for (let y = 0; y < kante; y += 1)
          for (let x = 0; x < kante / 2; x += 1)
            for (let k = 0; k < 3; k += 1) {
              const at = (y * kante + x) * 4 + k;
              if (r.daten[at] !== daten[at]) linksVeraendert += 1;
            }
        aus[`${name} (${weg})`] = {
          weg: r.weg,
          links: schwankung(r.daten, 8, kante / 2 - 8),
          rechtsVorher: schwankung(daten, kante / 2 + 8, kante - 8),
          rechtsNachher: schwankung(r.daten, kante / 2 + 8, kante - 8),
          // Das Band DIREKT rechts der Grenze – dorthin blutet es, wenn es blutet.
          randVorher: mittel(daten, kante / 2, kante / 2 + 6),
          randNachher: mittel(r.daten, kante / 2, kante / 2 + 6),
          linksVeraendert,
        };
      }
    }
    return { aus, linksVorher: schwankung(daten, 8, kante / 2 - 8) };
  }, MESSGERAET);

  // Beide Hälften tragen vorher gleich harte Streifen: Bei Streifen der Breite
  // 3 und einem Hub von 90 ist der Abstand zweier Nachbarn zweimal null und
  // einmal 90, im Mittel also 30.
  expect(ergebnis.linksVorher).toBeGreaterThan(25);
  expect(Object.keys(ergebnis.aus)).toHaveLength(6);
  for (const [name, e] of Object.entries(ergebnis.aus)) {
    expect(e.weg, `${name}: falscher Weg`).toBe(name.endsWith('(gpu)') ? 'gpu' : 'leinwand');
    expect(e.rechtsVorher).toBeGreaterThan(25);
    // 1. Rechts sind die Streifen fort.
    expect(e.rechtsNachher, `${name}: die Streifen im Bereich sind noch da`).toBeLessThan(
      e.rechtsVorher / 4,
    );
    /*
     * Das Band direkt rechts der Grenze verwischt nur mit den Bildpunkten
     * SEINER EIGENEN Seite. Mischte sich die dunkle linke Hälfte ein
     * (Mittel 45), fiele es von 210 auf etwa 150; hier wird es nicht dunkler –
     * bei Bokeh sogar heller, denn die hellen Streifen wiegen schwerer.
     */
    expect(e.randNachher, `${name}: Farbe von links ist hereingeblutet`).toBeGreaterThan(
      e.randVorher - 2,
    );
    // 2. Links stehen sie unangetastet – Byte für Byte, bis an die Grenze.
    expect(e.links).toBeCloseTo(ergebnis.linksVorher, 5);
    expect(e.linksVeraendert, `${name}: die Unschärfe blutet in die scharfe Hälfte`).toBe(0);
  }
});

test('die Unschärfe sitzt richtig herum – oben ist oben', async ({ page }) => {
  /*
   * Dieselbe Falle wie beim Atlas der Farbbereiche, nur dass hier zwei Räume
   * im Spiel sind: Das Original liegt im Texturraum (beim Hochladen
   * gespiegelt), die Arbeitstexturen und das Zwischenbild im Bildraum. Wer
   * eine der Drehungen zwischen ihnen vergisst, bekommt Unschärfe an der
   * falschen Hälfte – ausgerechnet bei einer Maske, die nur OBEN trägt.
   *
   * Waagerechte Streifen, damit eine verdrehte Zeilenfolge sichtbar wird, und
   * ein Raster, das nicht durch vier teilbar ist.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const kante = 192;
    const daten = new Uint8ClampedArray(kante * kante * 4);
    for (let y = 0; y < kante; y += 1)
      for (let x = 0; x < kante; x += 1) {
        const wert = Math.floor(y / 3) % 2 === 0 ? 30 : 220;
        daten.set([wert, wert, wert, 255], (y * kante + x) * 4);
      }
    const rb = 33;
    const feld = new Uint8Array(rb * rb);
    for (let y = 0; y < rb; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = y < rb / 2 ? 255 : 0;

    const schwankung = (d: Uint8ClampedArray, y0: number, y1: number) => {
      let summe = 0;
      let n = 0;
      const x = kante / 2;
      for (let y = y0; y < y1 - 1; y += 1) {
        summe += Math.abs(d[(y * kante + x) * 4] - d[((y + 1) * kante + x) * 4]);
        n += 1;
      }
      return summe / n;
    };

    const aus: Record<string, { oben: number; vorher: number; untenVeraendert: number }> = {};
    for (const [name, par] of Object.entries({
      Bokeh: { bokeh: 1 },
      Weichzeichnen: { unschaerfe: 1 },
    })) {
      for (const weg of ['gpu', 'cpu'] as const) {
        const szene = m.handSzene(feld, kante, kante, par, { reinheit: 0, rb, rh: rb });
        const r = m.rendern(daten, kante, kante, szene, weg);
        let untenVeraendert = 0;
        for (let y = 120; y < kante; y += 1)
          for (let x = 0; x < kante; x += 1)
            for (let k = 0; k < 3; k += 1) {
              const at = (y * kante + x) * 4 + k;
              if (r.daten[at] !== daten[at]) untenVeraendert += 1;
            }
        aus[`${name} (${weg})`] = {
          oben: schwankung(r.daten, 10, 80),
          vorher: schwankung(daten, 10, 80),
          untenVeraendert,
        };
      }
    }
    return aus;
  }, MESSGERAET);

  expect(Object.keys(ergebnis)).toHaveLength(4);
  for (const [name, e] of Object.entries(ergebnis)) {
    expect(e.vorher).toBeGreaterThan(25);
    expect(e.oben, `${name}: oben sind die Streifen noch da`).toBeLessThan(e.vorher / 3);
    expect(e.untenVeraendert, `${name}: unten hat sich etwas verändert`).toBe(0);
  }
});

test('ausserhalb einer Netzmaske bleibt jedes Byte, und die Wirkung endet an der Kante', async ({
  page,
}) => {
  /*
   * Die erste Beschwerde: „Weichzeichnen geht noch über die Kanten der Maske
   * hinaus.“ Gemessen am Freistellnetz (Staub 0 … 12 ausserhalb, Saum von 11
   * bis 29 Punkten, auch als verfolgte Videomaske): Vorher änderten sich 67 bis
   * 96 % aller Bildpunkte mit Maske ≤ 15, und die Wirkung reichte über 64
   * Punkte hinaus.
   *
   * Zwei Dinge werden gehalten, beide an jedem Fall der Reihe:
   *
   * - Kein einziger Bildpunkt mit Maske ≤ 15/255 ändert sich (K1). Nicht
   *   „kaum“ – kein Byte.
   * - Die Wirkung reicht nur wenig über die Kante hinaus (K2): bei einem Saum
   *   bis 12 Punkte höchstens 6; bei einem breiten Saum (wie ihn „U²-Net“
   *   liefert) beim Bokeh höchstens 8, beim Weichzeichnen 16. Das ist die
   *   Breite des Saums selbst plus ein Gauss, kein Hof.
   */
  const { netz } = await netzMessungen(page);
  expect(netz).toHaveLength(10);
  for (const f of netz) {
    expect(f.weg, `${f.name}: es hat nicht die Grafikeinheit gerechnet`).toBe('gpu');
    expect(f.ab.anzahl15, `${f.name}: die Messung hat Bildpunkte`).toBeGreaterThan(40_000);
    expect(f.ab.geaendert15, `${f.name}: Bildpunkte mit Maske ≤ 15 verändert`).toBe(0);
    expect(f.ab.geaendert0, `${f.name}: Bildpunkte mit Maske 0 verändert`).toBe(0);
    const schmal = f.maskenBreite <= 12.5;
    const grenze = schmal ? 6 : f.name.startsWith('Bokeh') ? 8 : 16;
    expect(f.ab.reichweite, `${f.name}: Reichweite ausserhalb`).toBeLessThanOrEqual(grenze);
    expect(f.ab.fern, `${f.name}: mittlere Abweichung ab 8 Punkten Abstand`).toBeLessThan(0.1);
  }
});

test('im Saum kommt keine Farbe von draussen herein', async ({ page }) => {
  /*
   * Der Saum einer Netzmaske ist eine Mischfarbe aus Motiv und Grund. Wer ihn
   * mitmittelt, holt den Hof herein: Vorher kam 26 bis 53 % Farbe des
   * Gegenstücks direkt an der Kante an, auf der Grafikeinheit wie auf dem
   * Prozessor.
   *
   * Gemessen wird der Anteil der Farbe des GEGENSTÜCKS (aus der Chromazität
   * entmischt, abzüglich dessen, was tief im Bereich ohnehin dasteht) bei 0–2,
   * 2–4 und 4–8 Punkten Abstand zur Kante – im Grundfall (Porträtmodus: der
   * Grund wird unscharf, das Motiv bleibt) wie im Motivfall (das Motiv wird
   * unscharf, rotes Karo und grüner Grund).
   */
  const { netz } = await netzMessungen(page);
  for (const f of netz) {
    const [kante, nah, fern] = f.ab.fremd;
    expect(kante, `${f.name}: Fremdfarbe bei 0–2 Punkten`).toBeLessThanOrEqual(0.2);
    expect(nah, `${f.name}: Fremdfarbe bei 2–4 Punkten`).toBeLessThanOrEqual(0.05);
    expect(fern, `${f.name}: Fremdfarbe bei 4–8 Punkten`).toBeLessThanOrEqual(0.03);
  }
});

test('die Kante bleibt schmal und scharf', async ({ page }) => {
  /*
   * Eine Kante, die durch die Unschärfe breiter wird, ist ein Halo. Gemessen
   * an einem Profil quer zur Kopfkante, über 51 Randpunkte gemittelt:
   *
   * - Breite von 10 auf 90 % (K4): höchstens 4,5 Punkte bei einer Maske bis 12
   *   Punkten Saum; höchstens 0,3 × die Maskenbreite bei einem breiten Saum.
   *   Vorher 14 gegen 11, beim breiten Saum 18 gegen 29.
   * - Kontrast bei ±4 Punkten (K5): 0,90 bei schmalem, 0,70 bei breitem Saum;
   *   die Steilheit nicht unter der Hälfte des Originals; die 50-%-Kreuzung
   *   nicht um mehr als 1,5 Punkte verschoben (das Motiv wird nicht grösser).
   */
  const { netz } = await netzMessungen(page);
  for (const f of netz) {
    const schmal = f.maskenBreite <= 12.5;
    expect(f.kante.breite, `${f.name}: Kantenbreite`).toBeLessThanOrEqual(
      schmal ? 4.5 : 0.3 * f.maskenBreite,
    );
    expect(f.kante.kontrast, `${f.name}: Kontrast bei ±4 Punkten`).toBeGreaterThanOrEqual(
      schmal ? 0.9 : 0.7,
    );
    expect(f.kante.steilheit, `${f.name}: Steilheit`).toBeGreaterThanOrEqual(
      0.5 * f.original.steilheit,
    );
    expect(Math.abs(f.kante.versatz), `${f.name}: Kante verschoben`).toBeLessThanOrEqual(1.5);
  }
});

test('Lichter werden zu Scheiben – flach, mit Kante, ohne Körnung', async ({ page }) => {
  /*
   * Woran man Bokeh erkennt: Ein Lichtpunkt wird zu einem Kreis mit
   * gleichmässiger Helligkeit, nicht zu einem verwaschenen Fleck. Vorher
   * rechnete der Schattierer 48 Zufallstupfen je Bildpunkt: Bei einem 2,6
   * Punkte kleinen Licht traf im Mittel nur ein Tupfen, die Scheibe war ein
   * körniger Fleck (Streuung 0,61), und ohne Grafikeinheit kam etwas ganz
   * anderes heraus.
   *
   * Gemessen an acht Lichtpunkten auf dunklem Grund (Radius 24, Netzmaske):
   *
   * - das Innere der Scheibe bleibt hell (≥ 140 von 255; vorher 90) – ein
   *   Licht bleibt ein Licht, kein grauer Schleier;
   * - Rand zu Innen ≥ 0,9: eine Scheibe hat eine Kante;
   * - Mitte zu Rand < 2: keine Glocke;
   * - Aussen zu Innen höchstens 0,25 – in den kleineren Güten (grösserer
   *   Arbeitsmassstab, weicherer Rand) 0,35 und 0,55;
   * - Streuung im Inneren ≤ 0,15: kein Korn.
   */
  const { lichter } = await netzMessungen(page);
  const aussen = { hoch: 0.25, mittel: 0.35, niedrig: 0.55 } as const;
  for (const guete of ['hoch', 'mittel', 'niedrig'] as const) {
    const l = lichter[guete];
    expect(l, `${guete}: keine Lichter gemessen`).not.toBeNull();
    if (!l) continue;
    expect(l.spitze, `${guete}: Spitze`).toBeGreaterThanOrEqual(140);
    expect(l.innen, `${guete}: Inneres`).toBeGreaterThanOrEqual(140);
    expect(l.randZuInnen, `${guete}: Rand zu Innen`).toBeGreaterThanOrEqual(0.9);
    expect(l.mitteZuRand, `${guete}: Mitte zu Rand`).toBeLessThan(2);
    expect(l.aussenZuInnen, `${guete}: Aussen zu Innen`).toBeLessThanOrEqual(aussen[guete]);
    expect(l.streuung, `${guete}: Streuung im Inneren`).toBeLessThanOrEqual(0.15);
  }
});

test('der Radius der Scheibe folgt der Maske – Grösse, nicht Durchsichtigkeit', async ({
  page,
}) => {
  /*
   * Der Unterschied zwischen einer Linse und einer Überblendung.
   *
   * Bei halbem Maskengewicht kann man zweierlei tun: eine halb so grosse
   * Zerstreuung zeichnen (was eine Linse tut), oder eine volle halb
   * durchsichtig darüberlegen. Bei einer Freistellmaske sieht beides fast
   * gleich aus; sobald die Maske aber ein Verlauf über die Tiefe einer Szene
   * ist, ist es der ganze Effekt: Nur die erste Fassung lässt die Unschärfe
   * mit der Entfernung WACHSEN.
   *
   * Drei Reihen Lichter unter einem waagerechten Verlauf (links 0, rechts
   * 255), Radius 24. Gehalten wird (K7):
   *
   * - der Radius der Scheibe wächst mit der Maske, nie zurück;
   * - er weicht höchstens um ein Viertel von R vom Bandradius `R · k / K` ab,
   *   den die Rechnung der Quelle zuteilt;
   * - die Scheibe ist im Inneren glatt (Streuung ≤ 0,05 ab 8 Punkten Radius) –
   *   keine Halbscheiben an den Stufengrenzen, keine Doppelscheiben.
   *
   * In „mittel“ (weniger Stufen, gröberes Abtasten) ist die Toleranz weiter.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const W = 1200;
    const sz = m.szeneHolen('C', W);
    const feld = m.maskeAlpha(sz, 'hverlauf');
    const aus: Record<string, import('./hilfen/unscharfMessen.js').ReiheLicht[]> = {};
    for (const [guete, stufen] of [
      ['hoch', 8],
      ['mittel', 6],
    ] as const) {
      const szene = m.handSzene(feld, W, sz.H, { bokeh: 1 });
      const r = m.rendern(sz.orig, W, sz.H, szene, 'gpu', guete);
      aus[guete] = m.reiheMessen(sz, r.daten, feld, 24, stufen);
    }
    return aus;
  }, MESSGERAET);

  for (const [guete, reihe] of Object.entries(ergebnis)) {
    expect(reihe, `${guete}: Lichter`).toHaveLength(27);
    const toleranz = guete === 'hoch' ? 1 : 1.5;
    const streuMax = guete === 'hoch' ? 0.05 : 0.12;
    for (const l of reihe) {
      expect(
        Math.abs(l.r25 - l.erwartet),
        `${guete}: Radius bei Maske ${l.m.toFixed(2)}`,
      ).toBeLessThanOrEqual(0.25 * 24 * toleranz);
      if (l.erwartet >= 8) {
        expect(l.streuung, `${guete}: Streuung bei Maske ${l.m.toFixed(2)}`).toBeLessThanOrEqual(
          streuMax,
        );
      }
    }
    // Je Reihe von links nach rechts: der Radius wächst, auch mit etwas Spielraum nie zurück.
    for (let r = 0; r < 3; r += 1) {
      const zeile = reihe.slice(r * 9, r * 9 + 9);
      for (let i = 1; i < zeile.length; i += 1) {
        expect(zeile[i].r25, `${guete}: Reihe ${r}, Licht ${i}`).toBeGreaterThanOrEqual(
          zeile[i - 1].r25 - 0.5,
        );
      }
    }
    // Und ganz links ist keine Scheibe, ganz rechts die grösste.
    expect(reihe[8].r25).toBeGreaterThan(reihe[0].r25 + 15);
  }
});

test('Motiv und Tiefe lassen keinen scharfen Ring um das Motiv', async ({ page }) => {
  /*
   * „Motiv + Tiefe“: Der Grund ist über die Tiefe unscharf, das Motiv (Netz,
   * `weg`) scharf. Die Maske fällt zum Motiv hin über den Saum von 255 auf 0,
   * und die Linse folgt der Maske – vorher blieb deshalb neben dem Motiv ein
   * scharfer Ring: Die Schärfe des Grundes 4 bis 8 Punkte daneben war das
   * Zehnfache der Schärfe weiter weg (19,6 gegen 1,9).
   *
   * Jetzt zählt jede Quelle in ihrer eigenen Stufe, und der Kern der Maske
   * (Silhouette, ohne die glatte Tiefe) bestimmt, was Quelle sein darf: Nahe
   * beim Motiv ist der Grund so unscharf wie weit davon. Gehalten wird, dass
   * der Ring höchstens 2,5-fach so scharf ist (K5).
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const W = 1200;
    const sz = m.szeneHolen('A', W);
    const alpha = m.maskeAlpha(sz, 'netz');
    const szene = m.bereichSzene(
      W,
      sz.H,
      [m.tiefenTeil(W, sz.H, { motiv: sz.drin }), m.netzTeil(alpha, W, sz.H, false, 'weg')],
      { bokeh: 1 },
    );
    const r = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'hoch');
    return {
      reinheit: szene.bereiche[0].reinheit,
      kern: !!szene.bereiche[0].maske.kern,
      weg: r.weg,
      vorher: m.schaerfeBand(sz, sz.orig, 4, 8),
      nah: m.schaerfeBand(sz, r.daten, 4, 8),
      fern: m.schaerfeBand(sz, r.daten, 32, 64),
    };
  }, MESSGERAET);

  // Die Maske ist wirklich gemischt – sonst prüfte der Test den falschen Fall.
  expect(ergebnis.reinheit).toBe(2);
  expect(ergebnis.kern).toBe(true);
  expect(ergebnis.weg).toBe('gpu');
  // Der Grund ist tatsächlich unscharf geworden, nah wie fern.
  expect(ergebnis.nah).toBeLessThan(ergebnis.vorher * 0.3);
  expect(ergebnis.fern).toBeLessThan(ergebnis.vorher * 0.3);
  // Und der Ring ist keiner.
  expect(ergebnis.nah).toBeLessThanOrEqual(2.5 * ergebnis.fern);
});

test('ein scharfer Punkt streut nicht in unscharfe Nachbarn hinein', async ({ page }) => {
  /*
   * Wir SAMMELN ein, was eine Linse VERSTREUT. Das geht nur dann richtig,
   * wenn ein eingesammelter Bildpunkt auch wirklich bis hierher streut: Ein
   * Punkt im Abstand 8 mit einer eigenen Scheibe vom Radius 2,6 erreicht uns
   * nicht und darf nicht mitzählen.
   *
   * Jede Quelle gehört genau einer Stufe (Radius `R · k / K`), und die Summe
   * über alle Stufen ist das Ergebnis – darum gilt das von selbst. Bei einer
   * Freistellmaske fällt es nie auf: Das Motiv ist innen überall gleich scharf.
   * Mit einer Tiefenkarte gibt es ein Gefälle, und dann leiht sich ein
   * unscharfer Teil des Motivs Farbe von einem scharfen Teil desselben Motivs.
   *
   * Aufbau: ein heller Punkt auf Schwarz, links im Bild, wo die Maske 0,3
   * sagt (Radius 2,6). Gemessen wird 8 Punkte weiter rechts, wo die Maske 1
   * sagt (Radius 10,2). Die dortige Scheibe REICHT bis zum Punkt – aber die
   * Scheibe des Punktes reicht nicht zurück.
   *
   * Der Gegenprobe wegen steht derselbe Aufbau ein zweites Mal da, nur mit
   * Maske 1 auch beim Punkt: Dann MUSS er ankommen. Ohne diese zweite Hälfte
   * würde der Test auch dann grün, wenn die Prüfung einfach alles verwirft.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const kante = 512;
    const punktX = 248;
    const messX = 256;
    const daten = new Uint8ClampedArray(kante * kante * 4);
    for (let i = 0; i < kante * kante; i += 1) daten.set([0, 0, 0, 255], i * 4);
    for (let y = kante / 2 - 1; y <= kante / 2 + 1; y += 1)
      for (let x = punktX - 1; x <= punktX + 1; x += 1)
        daten.set([255, 255, 255, 255], (y * kante + x) * 4);

    /** Rechnet das Bild mit einer Maske, die links `links` und rechts 1 ist. */
    const lauf = (links: number, weg: 'gpu' | 'cpu') => {
      // Ein Feld je Bildpunkt: Beim üblichen groben Raster wäre die Stufe acht
      // Punkte breit verschmiert – und genau diese acht sind hier die Messstrecke.
      const feld = new Uint8Array(kante * kante);
      for (let y = 0; y < kante; y += 1)
        for (let x = 0; x < kante; x += 1)
          feld[y * kante + x] = x < messX ? Math.round(links * 255) : 255;
      const szene = m.handSzene(feld, kante, kante, { bokeh: 1 });
      const r = m.rendern(daten, kante, kante, szene, weg);
      let summe = 0;
      for (let y = kante / 2 - 3; y <= kante / 2 + 3; y += 1)
        summe += r.daten[(y * kante + messX + 1) * 4];
      return summe / 7;
    };
    return {
      gpu: { schwach: lauf(0.3, 'gpu'), voll: lauf(1, 'gpu') },
      cpu: { schwach: lauf(0.3, 'cpu'), voll: lauf(1, 'cpu') },
    };
  }, MESSGERAET);

  for (const [weg, e] of Object.entries(ergebnis)) {
    expect(e.voll, `${weg}: ein streuender Punkt muss ankommen`).toBeGreaterThan(6);
    expect(e.schwach, `${weg}: ein kaum streuender Punkt darf nicht ankommen`).toBeLessThan(
      e.voll * 0.25,
    );
  }
});

test('Grafikeinheit und Prozessor zeichnen dieselbe Unschärfe', async ({ page }) => {
  /*
   * Der Fehler, der es nicht wieder geben soll: Vorher rechnete der Weg ohne
   * Grafikeinheit etwas anderes als der Schattierer – doppelter Radius,
   * unbedeckte Bildpunkte (Streifen), bei gebrochenem Radius ein schwarzes
   * Bild, ein gelber Hof statt eines Hauchs. Aus demselben Bild wurde auf dem
   * einen Gerät eine Scheibe und auf dem anderen ein Fleck mit Streifen.
   *
   * Jetzt rechnen beide dieselben Durchgänge mit denselben Konstanten. Der
   * Unterschied ist nur noch Rundung: je Kanal höchstens 2 Stufen, im Mittel
   * höchstens 0,05 (gemessen: 1 und 0,005). Beide Wege rechnen auf DERSELBEN
   * Güte – der Prozessor darf im Betrieb eine tiefer wählen, dann wären die
   * Kanten weicher, und das wäre kein Vergleich mehr.
   *
   * Dazu kommt für beide Wege, was nicht Rundung ist: ausserhalb der Maske
   * ändert sich kein Byte (K1).
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const ladeTon = '/src/modules/bild/ton.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    type Mass = { max: number; mittel: number };
    const berichte: {
      name: string;
      gpu: string;
      cpu: string;
      gleich: Mass;
      geaendert15: number[];
      /** Schärfe des Grundes weit vom Motiv: vorher, nach GPU, nach Prozessor. */
      scharf?: number[];
    }[] = [];
    const W = 600;

    // 1. Netzmasken, Szene A und B: Silhouetten mit Saum und Staub.
    const netzFaelle: [
      string,
      'A' | 'B',
      import('./hilfen/unscharfMessen.js').MaskenArt,
      'motiv' | 'grund',
      Partial<import('../src/modules/bild/doc.js').Bereichston>,
      ('hoch' | 'mittel' | 'niedrig')?,
    ][] = [
      ['Bokeh, harte Kante', 'A', 'hart', 'grund', { bokeh: 1 }],
      ['Bokeh, Netz, Motiv', 'A', 'netz', 'motiv', { bokeh: 1 }],
      ['Bokeh, Video, Grund', 'A', 'video', 'grund', { bokeh: 1 }],
      ['Weichzeichnen, Netz, Grund', 'A', 'netz', 'grund', { unschaerfe: 1 }],
      ['beide, Netz, Grund', 'A', 'netz', 'grund', { unschaerfe: 0.7, bokeh: 1 }],
      ['Lichter, Bokeh, Netz', 'B', 'netz', 'grund', { bokeh: 1 }],
      ['Bokeh, Netz, mittel', 'A', 'netz', 'grund', { bokeh: 1 }, 'mittel'],
      ['Bokeh, Netz, niedrig', 'A', 'netz', 'grund', { bokeh: 1 }, 'niedrig'],
    ];
    for (const [name, art, maske, ziel, par, guete] of netzFaelle) {
      const f = m.fall({ art, W, maske, ziel, par, guete });
      berichte.push({
        name,
        gpu: f.weg.gpu.gerechnet,
        cpu: f.weg.cpu.gerechnet,
        gleich: f.gleich as Mass,
        geaendert15: [f.weg.gpu.ab.geaendert15, f.weg.cpu.ab.geaendert15],
      });
    }

    // 2. Verlauf (glatt, Reinheit 1): Lichterreihen unter steigender Maske.
    {
      const sz = m.szeneHolen('C', W);
      const feld = m.maskeAlpha(sz, 'hverlauf');
      for (const [name, par] of [
        ['Bokeh, Verlauf', { bokeh: 1 }],
        ['Weichzeichnen, Verlauf', { unschaerfe: 1 }],
      ] as const) {
        const szene = m.handSzene(feld, W, sz.H, par);
        const g = m.rendern(sz.orig, W, sz.H, szene, 'gpu');
        const c = m.rendern(sz.orig, W, sz.H, szene, 'cpu');
        berichte.push({
          name,
          gpu: g.weg,
          cpu: c.weg,
          gleich: m.unterschied(g.daten, c.daten),
          geaendert15: [],
        });
      }
    }

    // 3. Gemischt (Reinheit 2): Motiv + Tiefe – Kernfeld, Stufen, Rückfall.
    {
      const sz = m.szeneHolen('A', W);
      const alpha = m.maskeAlpha(sz, 'netz');
      for (const [name, par] of [
        ['Motiv + Tiefe, Bokeh', { bokeh: 0.8 }],
        ['Motiv + Tiefe, beide', { bokeh: 0.8, unschaerfe: 0.5 }],
      ] as const) {
        const szene = m.bereichSzene(
          W,
          sz.H,
          [m.tiefenTeil(W, sz.H, { motiv: sz.drin }), m.netzTeil(alpha, W, sz.H, false, 'weg')],
          par,
        );
        const g = m.rendern(sz.orig, W, sz.H, szene, 'gpu');
        const c = m.rendern(sz.orig, W, sz.H, szene, 'cpu');
        berichte.push({
          name,
          gpu: g.weg,
          cpu: c.weg,
          gleich: m.unterschied(g.daten, c.daten),
          geaendert15: [],
        });
      }
    }

    // 4. Mit Schärfe zugleich: Sie schärft nur obendrauf und holt das
    // Verwischte nicht zurück – auf beiden Wegen dasselbe.
    {
      const sz = m.szeneHolen('A', W);
      const teil = m.netzTeil(m.maskeAlpha(sz, 'netz'), W, sz.H, true);
      const szene = m.bereichSzene(W, sz.H, [teil], { bokeh: 1 });
      const global = { ...ton.NEUTRAL, schaerfe: 0.8 };
      const g = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'hoch', global);
      const c = m.rendern(sz.orig, W, sz.H, szene, 'cpu', 'hoch', global);
      berichte.push({
        name: 'Bokeh und Schärfe',
        gpu: g.weg,
        cpu: c.weg,
        gleich: m.unterschied(g.daten, c.daten),
        geaendert15: [],
        scharf: [
          m.schaerfeBand(sz, sz.orig, 32, 64),
          m.schaerfeBand(sz, g.daten, 32, 64),
          m.schaerfeBand(sz, c.daten, 32, 64),
        ],
      });
    }
    return berichte;
  }, MESSGERAET);

  expect(ergebnis).toHaveLength(13);
  for (const b of ergebnis) {
    expect(b.gpu, `${b.name}: es hat nicht die Grafikeinheit gerechnet`).toBe('gpu');
    expect(b.cpu, `${b.name}: der Rückfallweg wurde nicht erzwungen`).toBe('leinwand');
    expect(b.gleich.max, `${b.name}: grösster Unterschied`).toBeLessThanOrEqual(2);
    expect(b.gleich.mittel, `${b.name}: mittlerer Unterschied`).toBeLessThan(0.05);
    for (const n of b.geaendert15) expect(n, `${b.name}: Bildpunkte ausserhalb`).toBe(0);
    if (b.scharf) {
      // Der Grund bleibt verwischt, auch wenn geschärft wird.
      const [vorher, gpu, cpu] = b.scharf;
      expect(gpu, `${b.name}: Schärfe holt die Grafikeinheit-Unschärfe zurück`).toBeLessThan(
        vorher * 0.3,
      );
      expect(cpu, `${b.name}: Schärfe holt die Prozessor-Unschärfe zurück`).toBeLessThan(
        vorher * 0.3,
      );
    }
  }
});

test('Vorstufe auf beiden Wegen: winzige Bilder, Radius über das Bild hinaus, kein NaN', async ({
  page,
}) => {
  /*
   * Durch den Renderer ist der Radius immer ein Bruchteil der Bildkante, ein
   * Radius grösser als das Bild kommt dort nie vor. Die Ränder des
   * Arbeitsmassstabs (Blöcke, die über das Bild hinausragen, Strecken, die
   * ausserhalb lesen) sind aber genau die Stellen, an denen Grafikeinheit und
   * Prozessor auseinanderlaufen könnten – und ein NaN im Gleitkomma wird zu
   * einem schwarzen Bildpunkt. Darum rechnet dieser Test die Vorstufe selbst,
   * mit einem eigenen Radius, auf Bildern von 1 × 1 bis 64 × 48 Punkten.
   *
   * Gehalten wird (K14):
   *
   * - ein gleichmässiges Feld bleibt gleichmässig, an allen Rändern, auch bei
   *   einem Radius von 40 Punkten auf 7 × 5 (±1; gemessen 0);
   * - die beiden Wege weichen bei Bildern unter 64 Punkten um höchstens 10
   *   Stufen ab (gemessen 1).
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const faelle: { name: string; gleichmaessig: number; gleich: number; ohneGpu: boolean }[] = [];
    for (const [W, H] of [
      [1, 1],
      [3, 2],
      [7, 5],
      [33, 17],
      [64, 48],
    ]) {
      const n = W * H;
      const einfarbig = new Uint8ClampedArray(n * 4);
      const gemischt = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i += 1) {
        einfarbig.set([120, 60, 200, 255], i * 4);
        gemischt.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255], i * 4);
      }
      const maske = new Uint8Array(n).fill(255);
      for (const [bokehPx, weichPx] of [
        [0.8, 0],
        [13, 0],
        [40, 0],
        [0, 13],
        [13, 4],
      ]) {
        for (const reinheit of [0, 1] as const) {
          for (const guete of ['hoch', 'niedrig'] as const) {
            const ebene = { bokehPx, weichPx, reinheit };
            const a = m.stufeDirekt(einfarbig, W, H, maske, ebene, guete);
            const b = m.stufeDirekt(gemischt, W, H, maske, ebene, guete);
            let abweichung = 0;
            for (const bild of [a.cpu, a.gpu]) {
              if (!bild) continue;
              for (let i = 0; i < n * 4; i += 1)
                abweichung = Math.max(abweichung, Math.abs(bild[i] - einfarbig[i]));
            }
            faelle.push({
              name: `${W}×${H}, Bokeh ${bokehPx}, Weich ${weichPx}, Reinheit ${reinheit}, ${guete}`,
              gleichmaessig: abweichung,
              gleich: b.gpu ? m.unterschied(b.gpu, b.cpu).max : 0,
              ohneGpu: b.gpu === null,
            });
          }
        }
      }
    }
    return faelle;
  }, MESSGERAET);

  expect(ergebnis).toHaveLength(100);
  expect(
    ergebnis.every((f) => f.ohneGpu),
    'ohne Float-Ziele gibt es die Vorstufe nicht – der Test prüfte nur den Prozessor',
  ).toBe(false);
  for (const f of ergebnis) {
    expect(
      f.gleichmaessig,
      `${f.name}: ein gleichmässiges Feld blieb nicht gleichmässig`,
    ).toBeLessThanOrEqual(1);
    expect(f.gleich, `${f.name}: Grafikeinheit gegen Prozessor`).toBeLessThanOrEqual(10);
  }
});

test('ein Zug an einem anderen Regler rechnet die Unschärfe nicht neu', async ({ page }) => {
  /*
   * Die Unschärfe ist teuer und braucht Nachbarschaften, also rechnet sie in
   * einer eigenen Vorstufe und liefert ein Zwischenbild. Der Hauptschattierer
   * liest es nur. Das Zwischenbild trägt einen Zettel: Quelle, Masken, beide
   * Radien, Güte, Grösse. Ein Zug an „Belichtung“ ändert keinen davon – die
   * Unschärfe kostet dann nichts. Vorher lief der Bokeh-Teil bei jedem
   * Reglerzug im Hauptschattierer.
   *
   * Gezählt wird mit `stufenGerechnet` (ein Zähler, nie eine Zeitmessung – die
   * wäre auf einem ausgelasteten Rechner launisch):
   *
   * - Belichtung, Kontrast, Wärme: der Zähler bleibt stehen, das Bild
   *   ändert sich trotzdem;
   * - Bokeh, Weichzeichnen, Güte: der Zähler steigt um genau eins.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ladeTon = '/src/modules/bild/ton.ts';
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');

    const W = 600;
    const sz = m.szeneHolen('A', W);
    const quelle = m.leinwandAus(sz.orig, W, sz.H);
    const teil = m.netzTeil(m.maskeAlpha(sz, 'netz'), W, sz.H, true);
    const szene = m.bereichSzene(W, sz.H, [teil], { bokeh: 1, unschaerfe: 0.3 });
    /** Dieselbe Szene, nur mit anderen Reglern – gleiche Maske, gleiche Kennung. */
    const mit = (par: Partial<import('../src/modules/bild/doc.js').Bereichston>) => ({
      ...szene,
      bereiche: szene.bereiche.map((b) => ({ ...b, anpassung: { ...b.anpassung, ...par } })),
    });

    const lesen = (
      global: import('../src/modules/bild/ton.js').Anpassung,
      s = szene,
      guete: 'hoch' | 'mittel' = 'mittel',
    ) => {
      gpu.gpuAbschalten(false);
      const vor = gpu.zaehler.stufenGerechnet;
      const flaeche = gpu.bildRechnen(quelle, W, sz.H, global, s, { fluechtig: true, guete });
      const d = m.lesen(flaeche, W, sz.H);
      let summe = 0;
      for (let i = 0; i < W * sz.H; i += 1) summe += d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
      return {
        gerechnet: gpu.zaehler.stufenGerechnet - vor,
        helligkeit: summe / (W * sz.H * 3),
        weg: gpu.letzterWeg,
      };
    };

    const erste = lesen(ton.NEUTRAL);
    return {
      erste,
      belichtung: lesen({ ...ton.NEUTRAL, belichtung: 0.8 }),
      kontrast: lesen({ ...ton.NEUTRAL, belichtung: 0.8, kontrast: 0.4 }),
      waerme: lesen({ ...ton.NEUTRAL, waerme: 0.5 }),
      wieder: lesen(ton.NEUTRAL),
      bokeh: lesen(ton.NEUTRAL, mit({ bokeh: 0.5 })),
      weich: lesen(ton.NEUTRAL, mit({ bokeh: 0.5, unschaerfe: 0.9 })),
      guete: lesen(ton.NEUTRAL, mit({ bokeh: 0.5, unschaerfe: 0.9 }), 'hoch'),
      gleich: lesen(ton.NEUTRAL, mit({ bokeh: 0.5, unschaerfe: 0.9 }), 'hoch'),
    };
  }, MESSGERAET);

  expect(ergebnis.erste.weg).toBe('gpu');
  expect(ergebnis.erste.gerechnet, 'beim ersten Mal wird gerechnet').toBe(1);
  // Ein Zug an der Farbe rechnet die Unschärfe nicht neu – das Bild ändert sich trotzdem.
  expect(ergebnis.belichtung.gerechnet).toBe(0);
  expect(ergebnis.kontrast.gerechnet).toBe(0);
  expect(ergebnis.waerme.gerechnet).toBe(0);
  expect(ergebnis.belichtung.helligkeit).toBeGreaterThan(ergebnis.erste.helligkeit + 10);
  expect(ergebnis.wieder.gerechnet).toBe(0);
  expect(ergebnis.wieder.helligkeit).toBeCloseTo(ergebnis.erste.helligkeit, 5);
  // Ein Zug an einem der beiden Regler oder an der Güte rechnet genau einmal.
  expect(ergebnis.bokeh.gerechnet).toBe(1);
  expect(ergebnis.weich.gerechnet).toBe(1);
  expect(ergebnis.guete.gerechnet).toBe(1);
  expect(ergebnis.gleich.gerechnet, 'dieselbe Einstellung noch einmal: aus dem Zettel').toBe(0);
});

test('Sonderfälle: Radius 0, NaN, unendlich und negativ lassen das Bild, wie es war', async ({
  page,
}) => {
  /*
   * Eine Datei kann NaN, unendlich, −1 oder 7 liefern – und weder die
   * Grafikeinheit noch der Prozessor sollen je etwas anderes als eine Zahl von
   * 0 bis 1 sehen. Das wird an EINER Stelle geklemmt (`unscharfEbenen`); hier
   * wird gehalten, dass es dabei bleibt: Das Bild kommt Byte für Byte so
   * heraus, wie es hereinkam, und die Vorstufe läuft gar nicht erst (kein
   * Schattierer-Lauf, `stufenGerechnet` steht still).
   *
   * Ein Radius unter 0,75 Punkten gehört dazu: Die Scheibe wäre schmaler als
   * ein Bildpunkt.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const W = 300;
    const sz = m.szeneHolen('A', W);
    const feld = m.maskeAlpha(sz, 'netz');
    const faelle: [string, { bokeh: number; unschaerfe: number }][] = [
      ['null', { bokeh: 0, unschaerfe: 0 }],
      ['NaN', { bokeh: Number.NaN, unschaerfe: Number.NaN }],
      ['unendlich', { bokeh: Number.POSITIVE_INFINITY, unschaerfe: Number.NEGATIVE_INFINITY }],
      ['negativ', { bokeh: -1, unschaerfe: -0.5 }],
      ['unter einem Bildpunkt', { bokeh: 0.001, unschaerfe: 0.001 }],
    ];
    const aus: { name: string; weg: string; veraendert: number; gerechnet: number }[] = [];
    for (const [name, par] of faelle) {
      for (const weg of ['gpu', 'cpu'] as const) {
        const szene = m.handSzene(feld, W, sz.H, par, { reinheit: 0 });
        const vor = gpu.zaehler.stufenGerechnet;
        const r = m.rendern(sz.orig, W, sz.H, szene, weg);
        let veraendert = 0;
        for (let i = 0; i < W * sz.H * 4; i += 1) if (r.daten[i] !== sz.orig[i]) veraendert += 1;
        aus.push({
          name: `${name} (${weg})`,
          weg: r.weg,
          veraendert,
          gerechnet: gpu.zaehler.stufenGerechnet - vor,
        });
      }
    }
    return aus;
  }, MESSGERAET);

  expect(ergebnis).toHaveLength(10);
  for (const f of ergebnis) {
    expect(f.veraendert, `${f.name}: Bytes verändert`).toBe(0);
    expect(f.gerechnet, `${f.name}: die Vorstufe lief`).toBe(0);
  }
});

test('Ressourcen: Texturen wachsen im Film nicht, ohne Float-Ziele rechnet der Prozessor die Vorstufe', async ({
  page,
}) => {
  /*
   * Ein Film rechnet jedes Bild neu und legt dafür jedes Mal eine neue Quelle
   * an. Ohne einen Vorrat legte jedes Bild fünf neue Texturen an – auf einem
   * Telefon geht dabei der Grafikspeicher aus. Gehalten wird (K15):
   *
   * - nach 50 Bildern leben genau so viele Texturen wie nach 5, und die
   *   Vorstufe wurde 50 Mal gerechnet (es ist kein Zettel, der hier hilft);
   * - fehlen float-renderbare Ziele (`EXT_color_buffer_float`), rechnet der
   *   Prozessor die Vorstufe und lädt sie als 8 Bit hoch – das Ergebnis ist
   *   das der Grafikeinheit, höchstens 2 Stufen daneben;
   * - ein verlorener Kontext bringt keinen Absturz: Das Bild kommt vom
   *   Prozessor, Vorrat und Zettel sind zurückgesetzt, und beim nächsten Bild
   *   läuft wieder alles auf der Grafikeinheit.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async (pfad) => {
    // Den Kontext des Renderers festhalten, bevor er angelegt wird – nur so
    // lässt er sich später verlieren lassen.
    const kontexte: WebGL2RenderingContext[] = [];
    const echt = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      art: string,
      ...rest: unknown[]
    ) {
      const c = (echt as (...a: unknown[]) => unknown).call(this, art, ...rest);
      if (art === 'webgl2' && c) kontexte.push(c as WebGL2RenderingContext);
      return c;
    } as typeof echt;

    const m = (await import(/* @vite-ignore */ pfad)) as Messgeraet;
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ladeUnscharf = '/src/modules/bild/unscharfGpu.ts';
    const ladeTon = '/src/modules/bild/ton.ts';
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const unscharfGpu = (await import(
      /* @vite-ignore */ ladeUnscharf
    )) as typeof import('../src/modules/bild/unscharfGpu.js');
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');

    const W = 240;
    const sz = m.szeneHolen('A', W);
    const szene = m.bereichSzene(W, sz.H, [m.netzTeil(m.maskeAlpha(sz, 'netz'), W, sz.H, true)], {
      bokeh: 1,
      unschaerfe: 0.5,
    });

    // 1. Ein Film: jedes Bild eine neue Quelle, flüchtig, in der kleinsten Güte.
    const bild = () => {
      const quelle = m.leinwandAus(sz.orig, W, sz.H);
      gpu.bildRechnen(quelle, W, sz.H, ton.NEUTRAL, szene, { fluechtig: true, guete: 'niedrig' });
    };
    const vor = gpu.zaehler.stufenGerechnet;
    for (let i = 0; i < 5; i += 1) bild();
    const nach5 = gpu.zaehler.texturenLebend;
    for (let i = 0; i < 45; i += 1) bild();
    const nach50 = gpu.zaehler.texturenLebend;
    const gerechnet = gpu.zaehler.stufenGerechnet - vor;

    // 2. Ohne Float-Ziele: der Prozessor rechnet die Vorstufe.
    const bildEinzeln = (weg: 'gpu' | 'cpu') => m.rendern(sz.orig, W, sz.H, szene, weg, 'mittel');
    const normal = bildEinzeln('gpu');
    unscharfGpu.floatZieleSperren(true);
    const vorHybrid = gpu.zaehler.stufenGerechnet;
    const hybrid = bildEinzeln('gpu');
    const hybridGerechnet = gpu.zaehler.stufenGerechnet - vorHybrid;
    unscharfGpu.floatZieleSperren(false);

    // 3. Ein verlorener Kontext. Es gibt zwei (der andere gehört der Prüfung des
    // Farbraums); beide gehen, der Renderer ist einer davon.
    const lebendVorVerlust = gpu.zaehler.texturenLebend;
    for (const kontext of kontexte) kontext.getExtension('WEBGL_lose_context')?.loseContext();
    const nachVerlust = bildEinzeln('gpu');
    const lebendNachVerlust = gpu.zaehler.texturenLebend;
    const wieder = bildEinzeln('gpu');
    HTMLCanvasElement.prototype.getContext = echt;

    return {
      kontexte: kontexte.length,
      nach5,
      nach50,
      gerechnet,
      hybridWeg: hybrid.weg,
      hybridGerechnet,
      hybridGegenNormal: m.unterschied(hybrid.daten, normal.daten),
      nachVerlustWeg: nachVerlust.weg,
      nachVerlustGegenNormal: m.unterschied(nachVerlust.daten, normal.daten),
      lebendVorVerlust,
      lebendNachVerlust,
      wiederWeg: wieder.weg,
      wiederGegenNormal: m.unterschied(wieder.daten, normal.daten),
    };
  }, MESSGERAET);

  expect(ergebnis.kontexte).toBeGreaterThan(0);
  expect(ergebnis.nach5, 'die Vorstufe hält Texturen').toBeGreaterThan(0);
  expect(ergebnis.nach50, 'nach 50 Bildern leben mehr Texturen als nach 5').toBe(ergebnis.nach5);
  expect(ergebnis.gerechnet, 'jedes Filmbild rechnet die Vorstufe').toBe(50);

  expect(ergebnis.hybridWeg, 'den Hauptdurchlauf macht weiter die Grafikeinheit').toBe('gpu');
  expect(ergebnis.hybridGerechnet).toBe(1);
  expect(ergebnis.hybridGegenNormal.max).toBeLessThanOrEqual(2);
  expect(ergebnis.hybridGegenNormal.mittel).toBeLessThan(0.05);

  expect(ergebnis.nachVerlustWeg, 'nach dem Verlust rechnet der Prozessor').toBe('leinwand');
  expect(ergebnis.nachVerlustGegenNormal.max).toBeLessThanOrEqual(2);
  expect(ergebnis.lebendVorVerlust).toBeGreaterThan(0);
  expect(ergebnis.lebendNachVerlust, 'Vorrat und Zettel sind zurückgesetzt').toBe(0);
  expect(ergebnis.wiederWeg, 'beim nächsten Bild läuft die Grafikeinheit wieder').toBe('gpu');
  expect(ergebnis.wiederGegenNormal.max).toBeLessThanOrEqual(2);
});
