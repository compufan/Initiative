import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
function png(url: string, datei: string) { writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')); }
test('Arbeitsfaktor', async ({ page }) => {
  test.setTimeout(1_800_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  const r = await page.evaluate(async () => {
    const M = (window as any).M;
    await M.laden();
    const W = 1200, H = 900;
    const sz = M.szeneHolen('B', W, H);
    const alpha = M.alphaFuer(sz, 'hart');
    const teil = M.netzTeil(alpha, W, H, true);
    const { raster, feld } = M.rasterFeld([teil], W, H);
    const maskImg = M.maskeAufBild(feld, raster, W, H);
    const aus: any = {};
    const liste: any[] = [{ titel: 'Original', daten: sz.orig }];
    for (const f of [1, 2, 4, 8]) {
      const g = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: 3, reinheit: 0, faktor: f }, 3);
      const l = M.lichterMessen(sz, g.daten, 24 * 0.87);
      delete l.radial;
      aus[`f${f}`] = { ms: Math.round(g.ms), innen: Math.round(l.innen), randZuInnen: +l.randZuInnen.toFixed(2), aussenZuInnen: +l.aussenZuInnen.toFixed(3), streu: +l.streuungInnen.toFixed(3) };
      liste.push({ titel: `f=${f}`, daten: g.daten });
    }
    const u = 1;
    const url = M.montageV(liste, W, H, 60, 100, 420, 120, 2);
    return { aus, url };
  });
  png(r.url, `${BASIS}/bilder/faktor.png`);
  console.log(JSON.stringify(r.aus, null, 1));
  writeFileSync(`${BASIS}/bilder/faktor.json`, JSON.stringify(r.aus, null, 1));
});
