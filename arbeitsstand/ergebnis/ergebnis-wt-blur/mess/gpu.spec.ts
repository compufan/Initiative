import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const MODUS = process.env.MODUS ?? 'gleich';

function png(url: string, datei: string) {
  writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

test('GPU-Entwurf', async ({ page }) => {
  test.setTimeout(1_800_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => {
    await (window as any).M.laden();
  });
  if (MODUS === 'gleich') {
    const r = await page.evaluate(() => {
      const M = (window as any).M;
      const W = 600;
      const aus: any = {};
      const liste: any[] = [];
      for (const [maske, ziel] of [['netz', 'grund'], ['netz', 'motiv'], ['hart', 'grund']] as const) {
        const sz = M.szeneHolen('A', W);
        const { H } = sz;
        const alpha = M.alphaFuer(sz, maske);
        const teil = M.netzTeil(alpha, W, H, ziel === 'grund');
        const { raster, feld } = M.rasterFeld([teil], W, H);
        const maskImg = M.maskeAufBild(feld, raster, W, H);
        const ref = M.P.rendern(sz.orig, W, H, maskImg, { bokeh: 1, reichweite: true, ebenen: 3, ebenenModus: 'naechste', K: 100, L0: 0.6, L1: 0.98 });
        const gpu = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: 3, reinheit: 0, K: 100 }, 0);
        const cpu = M.C.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: 3, reinheit: 0, K: 100 });
        {
          let s2 = 0, mx2 = 0, n2 = 0, u4 = 0;
          for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const d = Math.abs(cpu.daten[i * 4 + k] - gpu.daten[i * 4 + k]); s2 += d; n2 += 1; if (d > mx2) mx2 = d; if (d > 4) u4 += 1; }
          aus[`${maske}-${ziel}-CPUgegenGPU`] = { mittel: +(s2 / n2).toFixed(3), max: mx2, anteilUeber4: +(u4 / n2).toFixed(4), cpuMs: Math.round(cpu.ms) };
        }
        let s = 0, mx = 0, n = 0, ueber4 = 0;
        for (let i = 0; i < W * H; i += 1)
          for (let k = 0; k < 3; k += 1) {
            const d = Math.abs(ref[i * 4 + k] - gpu.daten[i * 4 + k]);
            s += d; n += 1; if (d > mx) mx = d; if (d > 4) ueber4 += 1;
          }
        aus[`${maske}-${ziel}`] = { mittel: +(s / n).toFixed(3), max: mx, anteilUeber4: +(ueber4 / n).toFixed(4) };
        if (maske === 'netz' && ziel === 'grund') liste.push({ titel: 'Original', daten: sz.orig }, { titel: 'Referenz', daten: ref }, { titel: 'GPU-Entwurf', daten: gpu.daten });
        // Bit-Gleichheit ausserhalb
        let geaendert = 0, anz = 0;
        for (let i = 0; i < W * H; i += 1) if (maskImg[i] <= 15) { anz += 1; for (let k = 0; k < 3; k += 1) if (gpu.daten[i * 4 + k] !== sz.orig[i * 4 + k]) { geaendert += 1; break; } }
        aus[`${maske}-${ziel}`].ausserhalbGeaendert = `${geaendert}/${anz}`;
      }
      const sz = M.szeneHolen('A', W);
      const url = M.montage(liste, W, sz.H, 0, 0, W, sz.H, 0.5, 0);
      const u = W / 1200;
      const url2 = M.montage(liste, W, sz.H, Math.round(560 * u), Math.round(200 * u), Math.round(200 * u), Math.round(150 * u), 2, 4);
      return { aus, url, url2 };
    });
    console.log(JSON.stringify(r.aus, null, 1));
    png(r.url, `${BASIS}/bilder/gpu-gleich.png`);
    png(r.url2, `${BASIS}/bilder/gpu-gleich-kante.png`);
  } else {
    const r = await page.evaluate(() => {
      const M = (window as any).M;
      const aus: any = {};
      for (const [W, Hh] of [[1200, 900], [1920, 1080]]) {
        const sz = M.szeneHolen('A', W, Hh);
        const { H } = sz;
        const alpha = M.alphaFuer(sz, 'netz');
        const teil = M.netzTeil(alpha, W, H, true);
        const { raster, feld } = M.rasterFeld([teil], W, H);
        const maskImg = M.maskeAufBild(feld, raster, W, H);
        const z: any = {};
        // heute: ein Durchgang mit 48 Tupfen
        z.heute = M.zeit(sz.orig, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'gpu', 3);
        z.heuteOhneRegler = M.zeit(sz.orig, W, H, [{ feld, raster, anpassung: { belichtung: 0.01 } }], 'gpu', 3);
        for (const K of [1, 3, 6]) z[`bokehK${K}`] = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: K, reinheit: 0 }, 3).ms;
        z.bokehK3_halb = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 0.5, K_stufen: 3, reinheit: 0 }, 3).ms;
        if (W === 1200 || W === 1920) { z.cpuK3 = M.C.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: 3, reinheit: 0 }).ms; z.cpuK6 = M.C.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: 6, reinheit: 0 }).ms; }
        z.weich = M.G.weichBild(sz.orig, W, H, maskImg, { weich: 1, reinheit: 0 }, 3).ms;
        z.weichKlein = M.G.weichBild(sz.orig, W, H, maskImg, { weich: 0.3, reinheit: 0 }, 3).ms;
        aus[`${W}x${Hh}`] = Object.fromEntries(Object.entries(z).map(([k, v]: any) => [k, +v.toFixed(0)]));
      }
      return aus;
    });
    console.log(JSON.stringify(r, null, 1));
    writeFileSync(`${BASIS}/bilder/gpu-zeiten.json`, JSON.stringify(r, null, 1));
  }
});
