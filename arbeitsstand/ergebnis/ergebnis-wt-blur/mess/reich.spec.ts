import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Reichweite', async ({ page }) => {
  await page.goto('/');
  for (const f of ['lib', 'fall']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  const r = await page.evaluate(async () => {
    const M = (window as any).M;
    await M.laden();
    const bk = await import('/src/modules/bild/bokeh.ts');
    const aus: any = {};
    const W = 800, H = 600;
    const probe = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) { probe[i * 4] = probe[i * 4 + 1] = probe[i * 4 + 2] = 20; probe[i * 4 + 3] = 255; }
    const cx = 400, cy = 300;
    for (let y = cy - 1; y <= cy + 1; y += 1) for (let x = cx - 1; x <= cx + 1; x += 1) for (let k = 0; k < 3; k += 1) probe[(y * W + x) * 4 + k] = 255;
    const reichweite = (d: Uint8ClampedArray, dx: number, dy: number) => { let r = 0; for (let s = 1; s < 100; s += 1) { const x = Math.round(cx + dx * s), y = Math.round(cy + dy * s); if (d[(y * W + x) * 4] > 22) r = s; } return r; };
    for (const R of [8, 16]) {
      const k = new Uint8ClampedArray(probe);
      bk.bokehRgba(k, W, H, R);
      aus[`cpu R=${R}`] = { x: reichweite(k, 1, 0), y: reichweite(k, 0, 1), diag60: reichweite(k, 0.5, 0.866) };
    }
    // GPU: Regler 1 bei 800 px -> R=16
    const teil = new Uint8Array(W * H).fill(255);
    const raster = { breite: 64, hoehe: 48, faktor: 64 / W };
    const feld = new Uint8Array(64 * 48).fill(255);
    const r1 = M.rendern(probe, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'gpu');
    aus['gpu R=16'] = { x: reichweite(r1.daten, 1, 0), y: reichweite(r1.daten, 0, 1), diag60: reichweite(r1.daten, 0.5, 0.866) };
    const r2 = M.rendern(probe, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'cpu');
    aus['cpu-weg R=16 (bildRechnen)'] = { x: reichweite(r2.daten, 1, 0), y: reichweite(r2.daten, 0, 1), diag60: reichweite(r2.daten, 0.5, 0.866) };
    return aus;
  });
  console.log(JSON.stringify(r, null, 1));
});
