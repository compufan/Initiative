import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('MRT', async ({ page }) => {
  test.setTimeout(3_600_000);
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const W = 1200, H = 900;
    const sz = M.szeneHolen('A', W, H);
    const alpha = M.alphaFuer(sz, 'netz');
    const teil = M.netzTeil(alpha, W, H, true);
    const { raster, feld } = M.rasterFeld([teil], W, H);
    const maskImg = M.maskeAufBild(feld, raster, W, H);
    const aus: any = { maxDraw: (M.G.init(), M.G.gl.getParameter(M.G.gl.MAX_DRAW_BUFFERS)) };
    for (const [K, f, rein] of [[3, 2, 0], [3, 4, 0], [6, 2, 1], [6, 4, 1], [8, 2, 1]] as any) {
      const par = { bokeh: 1, K_stufen: K, reinheit: rein, faktor: f, summiert: true };
      const a = M.G.bokehBild(sz.orig, W, H, maskImg, par, 3);
      const b = M.G.bokehBild(sz.orig, W, H, maskImg, { ...par, mrt: true }, 3);
      let mx = 0, s = 0;
      for (let i = 0; i < W * H * 4; i += 1) { const d = Math.abs(a.daten[i] - b.daten[i]); s += d; if (d > mx) mx = d; }
      aus[`K${K}-f${f}`] = { ohneMrt: Math.round(a.ms), mitMrt: Math.round(b.ms), maxAbw: mx, mittelAbw: +(s / (W * H * 4)).toFixed(4) };
    }
    return aus;
  });
  console.log(JSON.stringify(r, null, 1));
});
