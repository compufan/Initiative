import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';

test('Diagnose', async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  await page.addScriptTag({ path: `${BASIS}/mess/lib.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/fall.js` });
  const r = await page.evaluate(async () => {
    const M = (window as any).M;
    await M.laden();
    const W = 600, H = 450;
    const sz = M.szeneHolen('A', W);
    const raster = M.maske.rasterFuer(W, H);
    const uniform = (wert: number) => new Uint8Array(raster.breite * raster.hoehe).fill(wert);
    const aus: any = {};
    const vergleich = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let s = 0, mx = 0, n = 0, ueber1 = 0;
      for (let i = 0; i < W * H; i += 1)
        for (let k = 0; k < 3; k += 1) {
          const d = Math.abs(a[i * 4 + k] - b[i * 4 + k]);
          s += d; n += 1; if (d > mx) mx = d; if (d > 1) ueber1 += 1;
        }
      return { mittel: +(s / n).toFixed(3), max: mx, anteilUeber1: +(ueber1 / n).toFixed(4) };
    };
    // Exp 1: Identitaet und Staub
    for (const weg of ['gpu', 'cpu']) {
      for (const wert of [0, 3, 6, 10, 20, 128, 255]) {
        const r = M.rendern(sz.orig, W, H, [{ feld: uniform(wert), raster, anpassung: { unschaerfe: 1 } }], weg);
        aus[`konstMaske ${weg} ${wert}`] = vergleich(sz.orig, r.daten);
      }
      // ohne Bereich mit Belichtung 0 aber leerer Weg: Identitaet des Wegs selbst (Maske 0)
    }
    // Exp 2: gebrochener Radius im Prozessorweg
    const bk = await import('/src/modules/bild/bokeh.ts');
    const probe = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
      probe[i * 4] = probe[i * 4 + 1] = probe[i * 4 + 2] = 20; probe[i * 4 + 3] = 255;
    }
    for (let y = 200; y < 203; y += 1) for (let x = 300; x < 303; x += 1) for (let k = 0; k < 3; k += 1) probe[(y * W + x) * 4 + k] = 255;
    const lauf = (radius: number) => {
      const k = new Uint8ClampedArray(probe);
      bk.bokehRgba(k, W, H, radius);
      let summe = 0, nonzero = 0, maxv = 0, nullen = 0;
      for (let i = 0; i < W * H; i += 1) { const v = k[i * 4]; summe += v; if (v > 25) nonzero += 1; if (v > maxv) maxv = v; if (v === 0) nullen += 1; }
      return { mittelwert: +(summe / (W * H)).toFixed(2), helleFlaeche: nonzero, max: maxv, nullen, mitte: k[(201 * W + 301) * 4], links20: k[(201 * W + 280) * 4], ecke: k[0] };
    };
    aus.bokehRgba5 = lauf(5);
    aus.bokehRgba5_33 = lauf(16 / 3);
    aus.bokehRgba6 = lauf(6);
    aus.bokehRgba16 = lauf(16);
    return aus;
  });
  writeFileSync(`${BASIS}/bilder/diag1.json`, JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
});
