import { expect, test } from '@playwright/test';

/**
 * Weichzeichnen ist nicht Bokeh.
 *
 * Der Unterschied, den man auf einem Foto sofort sieht, ist EINER: Ein
 * Lichtpunkt im Unscharfen bleibt ein Licht. Ein Mittel über Anzeigewerte
 * macht daraus einen grauen Schleier, ein Mittel über LINEARES Licht einen
 * hellen Fleck. Dieser Test misst genau das – und zwar auf beiden Wegen,
 * denn der Fehler war lange, dass die beiden Wege verschiedene Antworten
 * gaben.
 *
 * Warum als Browser-Test und nicht in vitest: Der eine Weg ist ein
 * Schattierer. Ohne echte Grafikeinheit gibt es ihn nicht zu prüfen, und
 * `bokeh.test.ts` prüft nur die Prozessorseite.
 */
test('ein Lichtpunkt bleibt im Unscharfen ein Licht – auf beiden Wegen', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ladeTon = '/src/modules/bild/ton.ts';
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');

    // Ein einzelner Lichtpunkt (255) auf dunklem Grund (10). Genau die Lage,
    // in der sich Mittelwert und Licht am weitesten auseinanderziehen.
    const kante = 400;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    const bild = qctx.createImageData(kante, kante);
    for (let i = 0; i < kante * kante; i += 1) {
      bild.data[i * 4] = 10;
      bild.data[i * 4 + 1] = 10;
      bild.data[i * 4 + 2] = 10;
      bild.data[i * 4 + 3] = 255;
    }
    const mitte = (kante / 2) * kante + kante / 2;
    for (const k of [0, 1, 2]) bild.data[mitte * 4 + k] = 255;
    qctx.putImageData(bild, 0, 0);

    // Ein Bereich über das ganze Bild, volle Unschärfe: Jeder Bildpunkt
    // zerstreut gleich weit, die Maske spielt hier keine Rolle.
    const feld = new Uint8Array(64 * 64).fill(255);
    const bereich = {
      id: 'ganz',
      maske: { raster: { breite: 64, hoehe: 64 }, feld, stand: 1 },
      anpassung: { ...ton.NEUTRAL, unschaerfe: 1, kanal: 0 },
    };

    const hellstes = (weg: 'gpu' | 'cpu') => {
      gpu.gpuAbschalten(weg === 'cpu');
      const flaeche = gpu.bildRechnen(quelle, kante, kante, ton.NEUTRAL, {
        bereiche: [bereich],
        schluessel: weg,
      } as never);
      const zctx = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      });
      if (!zctx) return { weg: 'keiner', max: -1 };
      zctx.canvas.width = kante;
      zctx.canvas.height = kante;
      zctx.drawImage(flaeche as CanvasImageSource, 0, 0);
      const raus = zctx.getImageData(0, 0, kante, kante).data;
      let max = 0;
      for (let i = 0; i < kante * kante; i += 1) max = Math.max(max, raus[i * 4]);
      return { weg: gpu.letzterWeg, max };
    };

    const g = hellstes('gpu');
    const c = hellstes('cpu');
    gpu.gpuAbschalten(false);
    return { g, c };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.g?.weg, 'es hat nicht die Grafikeinheit gerechnet').toBe('gpu');
  expect(ergebnis.c?.weg, 'der Rückfallweg wurde nicht genommen').toBe('leinwand');

  /*
   * Die Schwelle steht bei 80, und sie trennt zwei Welten:
   *
   *   Mittel über Anzeigewerte, Kasten          11
   *   Mittel über Anzeigewerte, Scheibe + Glanz 24
   *   lineares Licht, Scheibe (Grafikeinheit)  152
   *   lineares Licht, Sechseck (Prozessor)     105
   *
   * Die beiden oberen Zeilen sind die Fassungen, die es vorher gab. Jede
   * Rückkehr dorthin reisst diese Grenze um mehr als das Dreifache.
   */
  expect(ergebnis.g?.max, 'Grafikeinheit: aus dem Licht wurde ein Schleier').toBeGreaterThan(80);
  expect(ergebnis.c?.max, 'Prozessor: aus dem Licht wurde ein Schleier').toBeGreaterThan(80);
});
