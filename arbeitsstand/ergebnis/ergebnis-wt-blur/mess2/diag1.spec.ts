import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Diagnose', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/');
  await page.waitForTimeout(3000);
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
    const out: any = {};
    let stand = 9000;
    const lauf = (weg: string, par: any, guete: string, global?: any) => {
      stand += 1;
      const quelle = M.leinwandAus(sz.orig, W, H);
      const szene = { bereiche: [{ id: 'b0', maske: { raster, feld, stand }, reinheit: 0, anpassung: { ...M.ton.FARB_NEUTRAL, unschaerfe: 0, bokeh: 0, ...par } }], schluessel: `d${stand}` };
      M.gpu.gpuAbschalten(weg === 'cpu');
      const fl = M.gpu.bildRechnen(quelle, W, H, global ?? M.ton.NEUTRAL, szene, { guete });
      const d = M.lesen(fl, W, H);
      M.gpu.gpuAbschalten(false);
      return d;
    };
    const vergl = (a: any, b: any) => {
      const h = [0, 0, 0, 0, 0]; let n = 0;
      for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const x = Math.min(4, Math.abs(a[i * 4 + k] - b[i * 4 + k])); h[x] += 1; n += 1; }
      return h.map((v) => +(v / n).toFixed(4));
    };
    // 1. Farbregler-Bereich (kein Unscharf) GPU/CPU
    out.neutral = vergl(lauf('gpu', { bokeh: 0.01 }, 'mittel'), lauf('cpu', { bokeh: 0.01 }, 'mittel'));
    { const a = lauf('gpu', { bokeh: 0.01 }, 'mittel'); let d = 0; for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) if (a[i * 4 + k] !== sz.orig[i * 4 + k]) d += 1; out.gpuNeutralGeaendert = d; const c = lauf('cpu', { bokeh: 0.01 }, 'mittel'); let e = 0; for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) if (c[i * 4 + k] !== sz.orig[i * 4 + k]) e += 1; out.cpuNeutralGeaendert = e; }
    out.weich = vergl(lauf('gpu', { unschaerfe: 1 }, 'mittel'), lauf('cpu', { unschaerfe: 1 }, 'mittel'));
    out.bokeh = vergl(lauf('gpu', { bokeh: 1 }, 'mittel'), lauf('cpu', { bokeh: 1 }, 'mittel'));
    out.bokehHoch = vergl(lauf('gpu', { bokeh: 1 }, 'hoch'), lauf('cpu', { bokeh: 1 }, 'hoch'));
    return out;
  });
  console.log(JSON.stringify(r));
});
