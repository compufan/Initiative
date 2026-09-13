import { expect, test } from '@playwright/test';

/**
 * Farbmanagement: Überlebt eine Farbe die ganze Kette, die es in sRGB gar
 * nicht gibt?
 *
 * # Warum das im Browser geprüft werden muss
 *
 * Weil es keine einzelne Funktion gibt, die man aufrufen könnte. Der Farbraum
 * ist eine Eigenschaft von Leinwänden, Texturen und Ausgabepuffern – ein
 * Dutzend Stellen, von denen EINE reicht, um alles zu beschneiden. Und das
 * Beschneiden ist still: Es gibt keinen Fehler, keine Warnung, nur eine
 * Farbe, die etwas flauer ist als vorher.
 *
 * # Die Messfarbe
 *
 * Ein kräftiges Orange, in Display-P3 als 0,95/0,35/0,15 angesetzt. In P3
 * steht es als 242/89/38, in sRGB als 255/73/0 – der rote Kanal läuft an den
 * Anschlag, der blaue fällt auf null. Genau daran ist ein Beschnitt zu
 * erkennen: nicht an „etwas anders“, sondern an einem Kanal, der auf 0 oder
 * 255 klebt.
 */

const MESSFARBE = 'color(display-p3 0.95 0.35 0.15)';

test('eine Farbe ausserhalb von sRGB überlebt Bearbeitung und Ausgabe', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async (farbe) => {
    const ladeRaum = '/src/modules/bild/farbraum.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeZeichnen = '/src/modules/bild/zeichnen.ts';
    const ladeDoc = '/src/modules/bild/doc.ts';
    const raum = (await import(
      /* @vite-ignore */ ladeRaum
    )) as typeof import('../src/modules/bild/farbraum.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const zeichnen = (await import(
      /* @vite-ignore */ ladeZeichnen
    )) as typeof import('../src/modules/bild/zeichnen.js');
    const doc = (await import(
      /* @vite-ignore */ ladeDoc
    )) as typeof import('../src/modules/bild/doc.js');

    const arbeitsraum = raum.arbeitsraum();
    if (arbeitsraum !== 'display-p3') return { arbeitsraum };

    /** Die Farbe eines Bildes, in P3 und in sRGB gelesen. */
    const lies = (quelle: CanvasImageSource) => {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const p3 = c.getContext('2d', {
        colorSpace: 'display-p3',
        willReadFrequently: true,
      } as CanvasRenderingContext2DSettings);
      if (!p3) return null;
      p3.drawImage(quelle, 0, 0, 16, 16);
      const alsP3 = p3.getImageData(0, 0, 16, 16, {
        colorSpace: 'display-p3',
      } as ImageDataSettings).data;
      const alsSrgb = p3.getImageData(0, 0, 16, 16, {
        colorSpace: 'srgb',
      } as ImageDataSettings).data;
      return {
        p3: [alsP3[0], alsP3[1], alsP3[2]],
        srgb: [alsSrgb[0], alsSrgb[1], alsSrgb[2]],
      };
    };

    // Ein Quellbild in der Messfarbe – so, wie ein Foto aus einem Telefon
    // ankommt.
    const quelle = document.createElement('canvas');
    quelle.width = 64;
    quelle.height = 64;
    const qctx = quelle.getContext('2d', {
      colorSpace: 'display-p3',
    } as CanvasRenderingContext2DSettings);
    if (!qctx) return { arbeitsraum, fehler: 'keine Leinwand' };
    qctx.fillStyle = farbe;
    qctx.fillRect(0, 0, 64, 64);
    const anfang = lies(quelle);

    // Durch die Farbkette – mit einer Einstellung, die nichts an der Farbe
    // dreht, aber die ganze Maschinerie anwirft.
    const getont = gpu.getoentesBild(quelle, 64, 64, { ...ton.NEUTRAL, belichtung: 0.0001 });
    const nachKette = lies(getont as CanvasImageSource);
    const weg = gpu.letzterWeg;

    /*
     * Und derselbe Weg OHNE Grafikeinheit.
     *
     * Der Rückfallweg hat seine eigene Leinwand und seine eigene
     * Farbtabelle. Bliebe die eine in sRGB, sähe dasselbe Foto auf demselben
     * Gerät verschieden aus, je nachdem, ob gerade eine Grafikeinheit
     * verfügbar ist – und genau das fiele niemandem auf.
     */
    gpu.gpuAbschalten(true);
    const ohneGpu = gpu.getoentesBild(quelle, 64, 64, { ...ton.NEUTRAL, belichtung: 0.0002 });
    const nachProzessor = lies(ohneGpu as CanvasImageSource);
    const wegOhne = gpu.letzterWeg;
    gpu.gpuAbschalten(false);

    // Und durch die Ausgabe: zeichnen, kodieren, wieder einlesen.
    const ausgabe = zeichnen.zeichneAusgabe(quelle, 64, 64, doc.neuesDoc(64, 64));
    const blob = await new Promise<Blob | null>((auf) =>
      ausgabe.toBlob((wert) => auf(wert), 'image/webp', 1),
    );
    if (!blob) return { arbeitsraum, fehler: 'keine Datei' };
    const wieder = await createImageBitmap(blob);
    const nachDatei = lies(wieder);

    return { arbeitsraum, weg, wegOhne, anfang, nachKette, nachProzessor, nachDatei };
  }, MESSFARBE);

  /*
   * Ohne P3 im Browser ist hier nichts zu prüfen – und der Test sagt das
   * laut, statt still durchzugehen. Ein stiller Erfolg auf einem Gerät ohne
   * P3 wäre die schlechteste aller Antworten: Er meldete „in Ordnung“ über
   * etwas, das gar nicht gelaufen ist.
   */
  expect(
    ergebnis.arbeitsraum,
    'dieser Browser kann kein Display-P3 – die Prüfung sagt nichts aus',
  ).toBe('display-p3');
  expect(ergebnis.fehler).toBeUndefined();

  /*
   * Erst der Beweis, dass die Messfarbe überhaupt etwas misst: In sRGB
   * gelesen klebt sie an den Anschlägen, in P3 nicht. Ohne diese Zeilen
   * könnte der Test mit einer Farbe laufen, die in beiden Räumen dasselbe
   * ist – und würde immer bestehen.
   */
  expect(ergebnis.anfang?.srgb[0], 'die Messfarbe liegt in sRGB nicht am Anschlag').toBe(255);
  expect(ergebnis.anfang?.srgb[2]).toBe(0);
  expect(ergebnis.anfang?.p3[0]).toBeLessThan(250);
  expect(ergebnis.anfang?.p3[2]).toBeGreaterThan(20);

  // Durch die Farbkette: dieselbe Farbe, auf ein paar Stufen genau.
  expect(ergebnis.weg, 'es hat nicht die Grafikeinheit gerechnet').toBe('gpu');
  for (let k = 0; k < 3; k += 1) {
    expect(
      Math.abs((ergebnis.nachKette?.p3[k] ?? -99) - (ergebnis.anfang?.p3[k] ?? 0)),
      `Kanal ${k} nach der Farbkette`,
    ).toBeLessThanOrEqual(3);
  }

  // Und auf dem Rückfallweg genauso.
  expect(ergebnis.wegOhne, 'der Rückfallweg wurde nicht genommen').toBe('leinwand');
  for (let k = 0; k < 3; k += 1) {
    expect(
      Math.abs((ergebnis.nachProzessor?.p3[k] ?? -99) - (ergebnis.anfang?.p3[k] ?? 0)),
      `Kanal ${k} auf dem Rückfallweg`,
    ).toBeLessThanOrEqual(3);
  }

  // Und durch Zeichnen, Kodieren und Wiedereinlesen.
  for (let k = 0; k < 3; k += 1) {
    expect(
      Math.abs((ergebnis.nachDatei?.p3[k] ?? -99) - (ergebnis.anfang?.p3[k] ?? 0)),
      `Kanal ${k} nach der Datei`,
    ).toBeLessThanOrEqual(3);
  }
});
