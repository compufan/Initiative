import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const FAELLE = JSON.parse(process.env.FAELLE ?? '[]');
const PRE = process.env.PRE ?? 'P';

function png(url: string, datei: string) {
  writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

test('Vorschlag', async ({ page }) => {
  test.setTimeout(1_800_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  await page.addScriptTag({ path: `${BASIS}/mess/lib.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/fall.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/proto.js` });
  await page.evaluate(async () => {
    await (window as any).M.laden();
  });
  for (const fall of FAELLE) {
    const name = `${PRE}-${fall.name}`;
    const r = await page.evaluate((f) => {
      const M = (window as any).M;
      const opt = f.opt;
      const p = M.P.fall(opt, f.par);
      let jetzt: any = null;
      if (f.vergleich) {
        // Der heutige Renderer mit gleichem Radius: Regler = bokeh (oder weich) auf 1
        const u = Math.max(f.par.bokeh || 0, f.par.weich || 0);
        jetzt = M.fall({ ...opt, u, wege: ['gpu'], anpassung: undefined });
      }
      const erg: any = {};
      erg.jetzt = jetzt ? jetzt.ergebnisse.gpu : null;
      erg.proto = p.ergebnisse.proto;
      const liste: any[] = [{ titel: 'Original', daten: p.sz.orig }];
      if (erg.jetzt) liste.push({ titel: 'JETZT (GPU)', daten: erg.jetzt });
      liste.push({ titel: 'VORSCHLAG', daten: erg.proto });
      const { W, H } = p.sz;
      const u = W / 1200;
      const o = f.ausschnitt || {};
      const x0 = Math.round(o.x0 ?? 640 * u), y0 = Math.round(o.y0 ?? 215 * u);
      const w = Math.round(o.w ?? 160 * u), h = Math.round(o.h ?? 120 * u);
      const ausschnitt = M.montage(liste, W, H, x0, y0, w, h, o.zoom || 3, o.diff === undefined ? 4 : o.diff);
      const mask = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i += 1) {
        mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = p.maskImg[i];
        mask[i * 4 + 3] = 255;
      }
      const gesamt = M.montage([...liste, { titel: 'Maske', daten: mask }], W, H, 0, 0, W, H, 1, 0);
      const { ergebnisse, sz, maskImg, feld, raster, ...rest } = p;
      let jetztRest: any = null;
      if (jetzt) {
        jetztRest = { massnahmen: jetzt.massnahmen, kante: jetzt.kante, lichter: jetzt.lichter, gpuMs: jetzt.gpuMs };
      }
      return { rest, jetztRest, ausschnitt, gesamt };
    }, fall);
    png(r.ausschnitt, `${BASIS}/bilder/${name}-ausschnitt.png`);
    png(r.gesamt, `${BASIS}/bilder/${name}-gesamt.png`);
    writeFileSync(`${BASIS}/bilder/${name}.json`, JSON.stringify({ ...r.rest, jetzt: r.jetztRest }, null, 1));
    console.log(name, 'ms', r.rest.ms);
  }
});
