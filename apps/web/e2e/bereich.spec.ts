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

test('das Bokeh verwischt nur hinter der Maske und blutet nicht heraus', async ({ page }) => {
  /*
   * Stufe K: Tiefenschärfe auf derselben Maske.
   *
   * Das Testbild trägt SENKRECHTE STREIFEN über die ganze Fläche – ein
   * einfarbiger Hintergrund könnte Unschärfe gar nicht zeigen. Gemessen wird
   * die Schwankung innerhalb einer Zeile: Streifen haben eine hohe,
   * verwischte Streifen eine niedrige.
   *
   * Zwei Eigenschaften, und die zweite ist die schwerere:
   *
   * 1. Wo die Maske greift, verschwinden die Streifen.
   * 2. Wo sie NICHT greift, bleibt alles Bildpunkt für Bildpunkt, wie es war.
   *    Das ist der Heiligenschein, den ein Porträtmodus bekommt, wenn er die
   *    Tupfen nicht mit der Maske gewichtet: Die Farbe des scharfen Motivs
   *    blutet in den weichen Hintergrund und legt einen Saum um die Person.
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

    const kante = 256;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    const bild = qctx.createImageData(kante, kante);
    for (let y = 0; y < kante; y += 1)
      for (let x = 0; x < kante; x += 1) {
        /*
         * Streifen mit Periode 6 – gut sichtbar für einen Radius von 5. Und
         * die beiden Hälften liegen bei GANZ verschiedenen Helligkeiten:
         * links dunkel (0/90), rechts hell (165/255) – gleicher Hub, ganz
         * verschiedene Mittelwerte.
         *
         * Das ist Bedingung, nicht Zierde. Sähen beide Hälften gleich aus,
         * könnte man nicht messen, ob Farbe von links nach rechts blutet –
         * und genau das ist der Heiligenschein, den die Gewichtung der Tupfen
         * verhindert. Meine erste Fassung dieses Tests hatte überall dieselben
         * Streifen und liess die Mutation durch.
         */
        const hell = Math.floor(x / 3) % 2 === 0;
        const links = x < kante / 2;
        const wert = links ? (hell ? 0 : 90) : hell ? 165 : 255;
        const at = (y * kante + x) * 4;
        bild.data[at] = wert;
        bild.data[at + 1] = wert;
        bild.data[at + 2] = wert;
        bild.data[at + 3] = 255;
      }
    qctx.putImageData(bild, 0, 0);

    // Die Maske deckt GENAU die rechte Hälfte.
    const rb = 128;
    const feld = new Uint8Array(rb * rb);
    for (let y = 0; y < rb; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = x >= rb / 2 ? 255 : 0;

    const szene = {
      bereiche: [
        {
          id: 'weich',
          maske: { raster: { breite: rb, hoehe: rb, faktor: rb / kante }, feld, stand: 1 },
          anpassung: { ...ton.FARB_NEUTRAL, unschaerfe: 1 },
        },
      ],
      schluessel: 'bokeh',
    };

    const lesen = (flaeche: CanvasImageSource) => {
      const z = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (!z) return null;
      z.canvas.width = kante;
      z.canvas.height = kante;
      z.drawImage(flaeche, 0, 0);
      return z.getImageData(0, 0, kante, kante).data;
    };

    const ohne = lesen(quelle);
    const mit = lesen(gpu.bildRechnen(quelle, kante, kante, ton.NEUTRAL, szene));
    if (!ohne || !mit) return { fehler: 'keine Leinwand' };

    /** Die mittlere Schwankung zwischen Nachbarn in einem Streifen. */
    const schwankung = (d: Uint8ClampedArray, x0: number, x1: number) => {
      let summe = 0;
      let n = 0;
      const y = Math.floor(kante / 2);
      for (let x = x0; x < x1 - 1; x += 1) {
        summe += Math.abs(d[(y * kante + x) * 4] - d[(y * kante + x + 1) * 4]);
        n += 1;
      }
      return n > 0 ? summe / n : -1;
    };

    // Wieviele Bildpunkte links der Maske haben sich ueberhaupt geaendert?
    let linksVeraendert = 0;
    for (let y = 0; y < kante; y += 1)
      for (let x = 0; x < kante / 2 - 8; x += 1) {
        const at = (y * kante + x) * 4;
        if (Math.abs(mit[at] - ohne[at]) > 2) linksVeraendert += 1;
      }

    /** Der Mittelwert eines senkrechten Bandes. */
    const mittel = (d: Uint8ClampedArray, x0: number, x1: number) => {
      let summe = 0;
      let n = 0;
      for (let y = 0; y < kante; y += 1)
        for (let x = x0; x < x1; x += 1) {
          summe += d[(y * kante + x) * 4];
          n += 1;
        }
      return n > 0 ? summe / n : -1;
    };

    return {
      weg: gpu.letzterWeg,
      // Das Band rechts DIREKT an der Grenze – dorthin blutet es, wenn es
      // blutet. Der Radius ist 5, also reicht die Scheibe 5 Punkte weit.
      randVorher: mittel(ohne, kante / 2, kante / 2 + 6),
      randNachher: mittel(mit, kante / 2, kante / 2 + 6),
      linksVorher: schwankung(ohne, 8, kante / 2 - 8),
      linksNachher: schwankung(mit, 8, kante / 2 - 8),
      rechtsVorher: schwankung(ohne, kante / 2 + 8, kante - 8),
      rechtsNachher: schwankung(mit, kante / 2 + 8, kante - 8),
      linksVeraendert,
    };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.weg).toBe('gpu');

  /*
   * Beide Hälften tragen vorher gleich harte Streifen. Bei Streifen der
   * Breite 3 und einem Hub von 90 ist der Abstand zweier Nachbarn zweimal
   * null und einmal 90, im Mittel also 30.
   */
  expect(ergebnis.linksVorher).toBeGreaterThan(25);
  expect(ergebnis.rechtsVorher).toBeGreaterThan(25);

  // 1. Rechts sind sie fort.
  expect(ergebnis.rechtsNachher).toBeLessThan(ergebnis.rechtsVorher! / 4);

  /*
   * Das Band direkt rechts der Grenze verwischt nur mit den Bildpunkten
   * SEINER EIGENEN Seite.
   *
   * Nachgemessen: Es wird dabei heller, von 210 auf 225. Das ist kein
   * Zufall, sondern das Aufblühen der Lichter (`GLANZ`) unter lauter hellen
   * Nachbarn – so sieht eine Zerstreuungsscheibe aus.
   *
   * Ohne die Gewichtung der Tupfen mischt sich die dunkle linke Hälfte ein
   * und verwässert genau das: gemessen 211,9, also praktisch unverändert.
   * Das ist der Heiligenschein – hier als Ausbleiben des Blühens sichtbar,
   * im echten Bild als Saum um das Motiv.
   *
   * Meine erste Erwartung war „bleibt gleich“, und sie war verkehrt herum.
   */
  expect(ergebnis.randNachher! - ergebnis.randVorher!).toBeGreaterThan(10);

  // 2. Links stehen sie unangetastet – und zwar Bildpunkt für Bildpunkt.
  expect(ergebnis.linksNachher).toBeCloseTo(ergebnis.linksVorher!, 0);
  expect(ergebnis.linksVeraendert, 'die Unschärfe blutet in die scharfe Hälfte').toBe(0);
});

test('die Zerstreuung ist eine Scheibe und keine Glocke', async ({ page }) => {
  /*
   * Woran man Bokeh erkennt: Ein Lichtpunkt wird zu einem KREIS mit
   * gleichmaessiger Helligkeit, nicht zu einem verwaschenen Fleck, der zur
   * Mitte hin heller wird. Das ist der Unterschied zwischen einer Linse und
   * einem Weichzeichner.
   *
   * Dafuer sorgt eine einzige Zeile: `r = sqrt(t)` bei der Verteilung der
   * Tupfen. Die Wurzel legt die Tupfen flaechengleich auf die Scheibe; ohne
   * sie haeufen sie sich in der Mitte, und aus der Scheibe wird eine Glocke.
   *
   * Gemessen wird deshalb das Verhaeltnis KERN zu SCHEIBE. Beide Fassungen
   * erzeugen naemlich einen aehnlich grossen und aehnlich hellen Fleck – der
   * Unterschied steckt ausschliesslich in seinem Querschnitt:
   *
   *            Mitte   r=4   r=8   r=10  r=12
   *   richtig    23     20    19     10    0     flach, dann Kante
   *   ohne sqrt 100     24    14      6    0     Spitze, dann Ausklang
   *
   * Ein frueherer Anlauf mass nur Scheibe gegen Rand und blieb deshalb gruen,
   * obwohl die Wurzel fehlte: an dieser Stelle unterscheiden sich die beiden
   * Fassungen kaum. Gemessen wird jetzt dort, wo der Unterschied sitzt.
   *
   * Gemittelt wird ueber ganze Ringe und nicht ueber einzelne Punkte, weil
   * jeder Bildpunkt seine eigene Zufallsdrehung bekommt.
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

    // Ein einzelner heller Punkt auf schwarzem Grund.
    const kante = 512;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    qctx.fillStyle = '#000000';
    qctx.fillRect(0, 0, kante, kante);
    qctx.fillStyle = '#ffffff';
    qctx.fillRect(kante / 2 - 1, kante / 2 - 1, 3, 3);

    // Die Maske deckt alles – der ganze Punkt soll zerstreut werden.
    const rb = 64;
    const feld = new Uint8Array(rb * rb).fill(255);
    const szene = {
      bereiche: [
        {
          id: 'alles',
          maske: { raster: { breite: rb, hoehe: rb, faktor: rb / kante }, feld, stand: 1 },
          anpassung: { ...ton.FARB_NEUTRAL, unschaerfe: 1 },
        },
      ],
      schluessel: 'scheibe',
    };

    const flaeche = gpu.bildRechnen(quelle, kante, kante, ton.NEUTRAL, szene);
    const z = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!z) return { fehler: 'keine Leinwand' };
    z.canvas.width = kante;
    z.canvas.height = kante;
    z.drawImage(flaeche as CanvasImageSource, 0, 0);
    const d = z.getImageData(0, 0, kante, kante).data;

    /** Mittlere Helligkeit aller Bildpunkte im Abstandsband [von, bis]. */
    const band = (von: number, bis: number) => {
      const m = kante / 2;
      let summe = 0;
      let n = 0;
      for (let y = Math.floor(m - bis) - 1; y <= Math.ceil(m + bis) + 1; y += 1) {
        for (let x = Math.floor(m - bis) - 1; x <= Math.ceil(m + bis) + 1; x += 1) {
          if (x < 0 || y < 0 || x >= kante || y >= kante) continue;
          const abstand = Math.hypot(x - m, y - m);
          if (abstand < von || abstand > bis) continue;
          summe += d[(y * kante + x) * 4];
          n += 1;
        }
      }
      return n > 0 ? summe / n : -1;
    };

    // Der Radius ist `unschaerfe · 0,02 · kante` = 10 Punkte.
    return {
      weg: gpu.letzterWeg,
      kern: band(0, 2.5),
      scheibe: band(6, 9),
      draussen: band(12, 15),
    };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.weg).toBe('gpu');
  // Es gibt ueberhaupt einen Fleck.
  expect(ergebnis.scheibe).toBeGreaterThan(5);
  // Die Mitte ragt nicht heraus: Scheibe, keine Glocke.
  // Gemessen: richtig 1,2 – ohne Wurzel 5,3.
  expect(ergebnis.kern).toBeLessThan(ergebnis.scheibe! * 2);
  // Und die Scheibe hat eine Kante.
  expect(ergebnis.draussen).toBeLessThan(ergebnis.scheibe! * 0.15);
});

test('die Maske bestimmt die Grösse der Zerstreuung, nicht ihre Durchsichtigkeit', async ({
  page,
}) => {
  /*
   * Der Unterschied zwischen einer Linse und einer Überblendung.
   *
   * Bei halbem Maskengewicht kann man zweierlei tun: eine halb so grosse
   * Zerstreuung zeichnen (was eine Linse tut), oder eine volle Zerstreuung
   * halb durchsichtig darüberlegen. Beim harten Rand einer Freistellmaske
   * sieht beides fast gleich aus – deshalb ist es lange niemandem
   * aufgefallen. Sobald die Maske aber ein Verlauf über die Tiefe einer Szene
   * ist, ist es der ganze Effekt: Nur die erste Fassung lässt die Unschärfe
   * mit der Entfernung WACHSEN.
   *
   * Gemessen wird an drei Lichtpunkten unter einem waagerechten
   * Maskenverlauf. Bei voller Unschärfe ist der Radius 0,02 · 512 = 10,2
   * Punkte; die drei Punkte liegen bei Gewicht 0,20 / 0,50 / 0,81, also bei
   * Radius 2,0 / 5,1 / 8,3. Ein Ring im Abstand 7 liegt damit ausserhalb der
   * ersten Scheibe und innerhalb der dritten.
   *
   * Mit einer Überblendung hätten alle drei denselben Radius 10,2 und der
   * Ring wäre überall hell, nur verschieden stark – das Verhältnis von erstem
   * zu drittem Punkt wäre dann ihr Gewichtsverhältnis, 0,20 : 0,81.
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

    const kante = 512;
    const orte = [100, 256, 412];
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    qctx.fillStyle = '#000000';
    qctx.fillRect(0, 0, kante, kante);
    qctx.fillStyle = '#ffffff';
    for (const x of orte) qctx.fillRect(x - 1, kante / 2 - 1, 3, 3);

    // Waagerechter Verlauf: links 0, rechts 255.
    const rb = 64;
    const feld = new Uint8Array(rb * rb);
    for (let y = 0; y < rb; y += 1)
      for (let x = 0; x < rb; x += 1) feld[y * rb + x] = Math.round((x / (rb - 1)) * 255);
    const szene = {
      bereiche: [
        {
          id: 'verlauf',
          maske: { raster: { breite: rb, hoehe: rb, faktor: rb / kante }, feld, stand: 1 },
          anpassung: { ...ton.FARB_NEUTRAL, unschaerfe: 1 },
        },
      ],
      schluessel: 'wachsend',
    };

    const flaeche = gpu.bildRechnen(quelle, kante, kante, ton.NEUTRAL, szene);
    const z = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!z) return { fehler: 'keine Leinwand' };
    z.canvas.width = kante;
    z.canvas.height = kante;
    z.drawImage(flaeche as CanvasImageSource, 0, 0);
    const d = z.getImageData(0, 0, kante, kante).data;

    /** Mittlere Helligkeit auf einem Ring um einen der Lichtpunkte. */
    const ring = (mx: number, radius: number) => {
      let summe = 0;
      let n = 0;
      for (let i = 0; i < 120; i += 1) {
        const w = (i / 120) * Math.PI * 2;
        const x = Math.round(mx + Math.cos(w) * radius);
        const y = Math.round(kante / 2 + Math.sin(w) * radius);
        if (x < 0 || y < 0 || x >= kante || y >= kante) continue;
        summe += d[(y * kante + x) * 4];
        n += 1;
      }
      return n > 0 ? summe / n : -1;
    };

    return {
      weg: gpu.letzterWeg,
      ring7: orte.map((x) => ring(x, 7)),
      kern: orte.map((x) => ring(x, 0)),
    };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.weg).toBe('gpu');
  const [schmal, mittel, breit] = ergebnis.ring7!;
  // Die dritte Scheibe reicht über den Ring hinaus, die erste nicht.
  expect(breit).toBeGreaterThan(2);
  expect(mittel).toBeGreaterThan(schmal);
  expect(breit).toBeGreaterThan(mittel);
  // Und zwar deutlich: Bei einer Überblendung wären es 0,20 : 0,81 = 0,24.
  expect(schmal).toBeLessThan(breit * 0.1);
});
