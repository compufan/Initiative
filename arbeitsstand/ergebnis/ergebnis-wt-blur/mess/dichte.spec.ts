import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Dichte', async ({ page }) => {
  test.setTimeout(3_600_000);
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const W = 1200, H = 900;
    const out: any = {};
    for (const art of ['A', 'B']) {
      const sz = M.szeneHolen(art, W, H);
      const alpha = M.alphaFuer(sz, 'netz');
      const teil = M.netzTeil(alpha, W, H, true);
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      for (const [K, f] of [[3, 2], [3, 4]] as any) {
        const base = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: K, reinheit: 0, faktor: f, summiert: true, tapDichte: 1 }, 3);
        for (const d of [0.5, 0.35]) {
          const x = M.G.bokehBild(sz.orig, W, H, maskImg, { bokeh: 1, K_stufen: K, reinheit: 0, faktor: f, summiert: true, tapDichte: d }, 3);
          let mx = 0, s = 0, u8 = 0;
          for (let i = 0; i < W * H * 4; i += 1) { const dd = Math.abs(base.daten[i] - x.daten[i]); s += dd; if (dd > mx) mx = dd; if (dd > 8) u8 += 1; }
          let lichter = null;
          if (art === 'B') { const l = M.lichterMessen(sz, x.daten, 24 * 0.87); lichter = { innen: Math.round(l.innen), aussenZuInnen: +l.aussenZuInnen.toFixed(3), streu: +l.streuungInnen.toFixed(3) }; }
          out[`${art}-K${K}-f${f}-dichte${d}`] = { ms: Math.round(x.ms), msBasis: Math.round(base.ms), mittelAbw: +(s / (W * H * 4)).toFixed(3), maxAbw: mx, anteilUeber8: +(u8 / (W * H * 4)).toFixed(5), lichter };
        }
      }
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
});
