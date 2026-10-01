import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Zeiten', async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const aus: any = {};
    const GUETE = { hoch: 12, mittel: 8, niedrig: 4 } as any;
    const STUFEN = { hoch: [3, 8], mittel: [3, 6], niedrig: [2, 4] } as any;
    for (const [W, H] of [[1200, 900], [1920, 1080], [2560, 1920]]) {
      const sz = M.szeneHolen('A', W, H);
      const alpha = M.alphaFuer(sz, 'netz');
      const teil = M.netzTeil(alpha, W, H, true);
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      const z: any = {};
      const R = 0.02 * Math.max(W, H);
      z.R = +R.toFixed(1);
      if (W < 2000) z.heute = Math.round(M.zeit(sz.orig, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'gpu', 3));
      z.heuteOhneBlur = W < 2000 ? Math.round(M.zeit(sz.orig, W, H, [{ feld, raster, anpassung: { belichtung: 0.01 } }], 'gpu', 3)) : null;
      for (const g of Object.keys(GUETE)) {
        const f = M.G.faktorFuer(R, GUETE[g]);
        for (const [art, K] of [['sil', STUFEN[g][0]], ['tiefe', STUFEN[g][1]]] as any) {
          const par = { bokeh: 1, K_stufen: K, reinheit: art === 'sil' ? 0 : 1, faktor: f, summiert: true };
          const gp = M.G.bokehBild(sz.orig, W, H, maskImg, par, 3);
          const cp = M.C.bokehBild(sz.orig, W, H, maskImg, par);
          z[`${g}-${art}-K${K}-f${f}`] = { gpu: Math.round(gp.ms), cpu: Math.round(cp.ms) };
        }
        const fw = M.G.faktorFuer(0.012 * Math.max(W, H) * 3, GUETE[g]);
        const gw = M.G.weichBild(sz.orig, W, H, maskImg, { weich: 1, reinheit: 0, faktor: fw }, 3);
        const cw = M.C.weichBild(sz.orig, W, H, maskImg, { weich: 1, reinheit: 0, faktor: fw });
        z[`${g}-weich-f${fw}`] = { gpu: Math.round(gw.ms), cpu: Math.round(cw.ms) };
      }
      aus[`${W}x${H}`] = z;
    }
    return aus;
  });
  writeFileSync(`${BASIS}/bilder/zeiten.json`, JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
});
