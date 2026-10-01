import { test } from '@playwright/test';

test('probe 5: Ring debug', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const out: string[] = [];
    const W = 600;
    const sz = m.szeneHolen('A', W);
    const alpha = m.maskeAlpha(sz, 'netz');
    const szene = m.bereichSzene(W, sz.H, [m.tiefenTeil(W, sz.H, { motiv: sz.drin }), m.netzTeil(alpha, W, sz.H, false, 'weg')], { bokeh: 1 });
    const b = szene.bereiche[0];
    const f = b.maske.feld, k = b.maske.kern;
    let sf = 0, sk = 0;
    for (let i = 0; i < f.length; i++) { sf += f[i]; sk += k[i]; }
    out.push(`raster ${b.maske.raster.breite}x${b.maske.raster.hoehe} feld mittel ${(sf / f.length).toFixed(1)} kern mittel ${(sk / k.length).toFixed(1)}`);
    const r = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'hoch');
    let ger = 0;
    for (let i = 0; i < W * sz.H; i++) if (Math.abs(r.daten[i*4] - sz.orig[i*4]) > 2) ger++;
    out.push(`weg ${r.weg} geaendert ${ger} von ${W * sz.H}`);
    return out;
  });
  console.log(r.join('\n'));
});
