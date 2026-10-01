import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const FAELLE = JSON.parse(process.env.FAELLE ?? '[]');
const PRE = process.env.PRE ?? 'F';
function png(url: string, datei: string) { writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')); }

test('Endmessung', async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  for (const fall of FAELLE) {
    const r = await page.evaluate((f) => {
      const M = (window as any).M;
      const { opt, par } = f;
      const sz = M.szeneHolen(opt.art, opt.W, opt.H);
      const { W, H } = sz;
      let alpha = M.alphaFuer(sz, opt.maske);
      if (f.straffung) {
        const [a0, b0] = f.straffung;
        const lut = new Uint8Array(256);
        for (let v = 0; v < 256; v += 1) { const t = Math.min(1, Math.max(0, (v / 255 - a0) / (b0 - a0))); lut[v] = Math.round(255 * t * t * (3 - 2 * t)); }
        alpha = alpha.map((v: number) => lut[v]);
      }
      const teil = M.netzTeil(alpha, W, H, opt.ziel === 'grund');
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      const erg: any = {};
      const ms: any = {};
      // JETZT: ein Regler (Zerstreuung) auf 1
      const u = f.jetztU ?? Math.max(par.bokeh || 0, par.weich || 0);
      for (const weg of ['gpu', 'cpu']) {
        const r = M.rendern(sz.orig, W, H, [{ feld, raster, anpassung: { unschaerfe: u } }], weg);
        erg[`jetzt-${weg}`] = r.daten;
        ms[`jetzt-${weg}`] = Math.round(r.ms);
      }
      // NEU
      const p = { K_stufen: f.stufen ?? 3, reinheit: 0, K: 100, ...par };
      let g, c;
      if (par.bokeh && par.weich) { g = M.G.beideBild(sz.orig, W, H, maskImg, p, 0); c = M.C.beide(sz.orig, W, H, maskImg, p); }
      else if (par.bokeh) { g = M.G.bokehBild(sz.orig, W, H, maskImg, p, 0); c = M.C.bokehBild(sz.orig, W, H, maskImg, p); }
      else { g = M.G.weichBild(sz.orig, W, H, maskImg, p, 0); c = M.C.weichBild(sz.orig, W, H, maskImg, p); }
      erg['neu-gpu'] = g.daten; erg['neu-cpu'] = c.daten;
      ms['neu-cpu'] = Math.round(c.ms);
      // Gleichheit GPU/CPU (neu)
      let s = 0, mx = 0, n = 0, u4 = 0;
      for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const d = Math.abs(g.daten[i * 4 + k] - c.daten[i * 4 + k]); s += d; n += 1; if (d > mx) mx = d; if (d > 4) u4 += 1; }
      const R = (par.bokeh || 0) * 0.02 * Math.max(W, H);
      const werte = M.werten(sz, maskImg, opt, erg, (par.bokeh ? 0.87 * R : 1) || 1);
      const liste = [{ titel: 'Original', daten: sz.orig }, { titel: 'JETZT GPU', daten: erg['jetzt-gpu'] }, { titel: 'JETZT CPU', daten: erg['jetzt-cpu'] }, { titel: 'NEU GPU', daten: erg['neu-gpu'] }, { titel: 'NEU CPU', daten: erg['neu-cpu'] }];
      const us = W / 1200;
      const o = f.ausschnitt || {};
      const x0 = Math.round(o.x0 ?? 640 * us), y0 = Math.round(o.y0 ?? 215 * us), w = Math.round(o.w ?? 160 * us), h = Math.round(o.h ?? 120 * us);
      const ausschnitt = M.montage(liste, W, H, x0, y0, w, h, o.zoom || 2, 0);
      const mask = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i += 1) { mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = maskImg[i]; mask[i * 4 + 3] = 255; }
      const gesamt = M.montage([...liste, { titel: 'Maske', daten: mask }], W, H, 0, 0, W, H, 0.3, 0);
      return { werte, ms, gleich: { mittel: +(s / n).toFixed(3), max: mx, anteilUeber4: +(u4 / n).toFixed(4) }, ausschnitt, gesamt };
    }, fall);
    const name = `${PRE}-${fall.name}`;
    png(r.ausschnitt, `${BASIS}/bilder/${name}-ausschnitt.png`);
    png(r.gesamt, `${BASIS}/bilder/${name}-gesamt.png`);
    writeFileSync(`${BASIS}/bilder/${name}.json`, JSON.stringify({ ...r.werte, ms: r.ms, gleichNeuGpuCpu: r.gleich, fall }, null, 1));
    console.log(name, JSON.stringify(r.ms), JSON.stringify(r.gleich));
  }
});
