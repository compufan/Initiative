import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Diagnose2', async ({ page }) => {
  test.setTimeout(900_000);
  page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE', m.text().slice(0, 300)); });
  await page.goto('/');
  await page.waitForTimeout(2500);
  for (const f of ['lib', 'fall']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const W = 600;
    const sz = M.szeneHolen('A', W);
    const { H } = sz;
    const alpha = M.alphaFuer(sz, 'netz');
    const teil = M.netzTeil(alpha, W, H, true);
    const { raster, feld } = M.rasterFeld([teil], W, H);
    let stand = 100;
    const lauf = (weg: string, par: any) => {
      stand += 1;
      const quelle = M.leinwandAus(sz.orig, W, H);
      const szene = { bereiche: [{ id: 'b0', maske: { raster, feld, stand }, reinheit: 0, anpassung: { ...M.ton.FARB_NEUTRAL, unschaerfe: 0, bokeh: 0, ...par } }], schluessel: `d${stand}` };
      M.gpu.gpuAbschalten(weg === 'cpu');
      (window as any).__dbg = true;
      const fl = M.gpu.bildRechnen(quelle, W, H, M.ton.NEUTRAL, szene, { guete: 'mittel' });
      const d = M.lesen(fl, W, H);
      M.gpu.gpuAbschalten(false);
      return d;
    };
    const out: any = {};
    lauf('gpu', { unschaerfe: 1 });
    const g = lauf('gpu', { bokeh: 0.8, unschaerfe: 0.5 });
    const X = (window as any).__dbgX as Float32Array;
    // Alpha und rgb in X
    let aN = 0, aSum = 0; let rgbMax = 0, nan = 0;
    for (let i = 0; i < W * H; i += 1) { const a = X[i * 4 + 3]; if (a > 0) aN += 1; aSum += a; for (let k = 0; k < 3; k += 1) { const v = X[i * 4 + k]; if (!Number.isFinite(v)) nan += 1; rgbMax = Math.max(rgbMax, v); } }
    out.X = { aN, aMittel: aSum / (W * H), rgbMax, nan, n: W * H };
    // Probe bei (10,10) und Mitte
    const px = (x: number, y: number) => Array.from(X.slice(((H - 1 - y) * W + x) * 4, ((H - 1 - y) * W + x) * 4 + 4)).map((v) => +v.toFixed(4));
    out.probe = { x10y10: px(10, 10), x100y100: px(100, 100), orig10: [sz.orig[(10 * W + 10) * 4], sz.orig[(10 * W + 10) * 4 + 1]] };
    out.probe2 = { x10y10_rueck: Array.from(X.slice((10 * W + 10) * 4, (10 * W + 10) * 4 + 4)).map((v) => +v.toFixed(4)) };
    // Maske bei 10,10 und 100,100
    out.maske = { m10: feld[Math.min(raster.hoehe - 1, 10) * raster.breite + 10], m100: feld[100 * raster.breite + 100] };
    const U = (window as any).__dbgU as Uint8Array;
    let ua = 0; for (let i = 0; i < W * H; i += 1) if (U[i * 4 + 3] > 0) ua += 1;
    out.U = { aN: ua, u10: Array.from(U.slice(((H - 1 - 10) * W + 10) * 4, ((H - 1 - 10) * W + 10) * 4 + 4)) };
    // Motivmitte (Bild y=250*W/1200 ... ) : Mitte unten
    const my = Math.round(H * 0.7), mx = Math.round(W * 0.5);
    out.U.mitte = Array.from(U.slice(((H - 1 - my) * W + mx) * 4, ((H - 1 - my) * W + mx) * 4 + 4));
    out.Xmitte = Array.from(X.slice((my * W + mx) * 4, (my * W + mx) * 4 + 4)).map((v) => +v.toFixed(4));
    out.maskeMitte = feld[Math.round(my * raster.hoehe / H) * raster.breite + Math.round(mx * raster.breite / W)];
    out.gpu10 = [g[(10 * W + 10) * 4], g[(10 * W + 10) * 4 + 1], g[(10 * W + 10) * 4 + 2]];
    return out;
  });
  console.log(JSON.stringify(r));
});
