import { test } from '@playwright/test';
test('probe 10: Schaerfe + Unschaerfe', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const tonPfad = '/src/modules/bild/ton.ts';
    const ton: any = await import(/* @vite-ignore */ tonPfad);
    const W = 600;
    const sz = m.szeneHolen('A', W);
    const alpha = m.maskeAlpha(sz, 'netz');
    const out: string[] = [];
    for (const [name, par, global] of [
      ['Bokeh + Schärfe', { bokeh: 1 }, { ...ton.NEUTRAL, schaerfe: 0.8 }],
      ['Weich + Schärfe + Belichtung', { unschaerfe: 1 }, { ...ton.NEUTRAL, schaerfe: 0.6, belichtung: 0.4, kontrast: 0.2 }],
      ['nur Schärfe, Bereich neutral', {}, { ...ton.NEUTRAL, schaerfe: 0.8 }],
    ] as const) {
      const teil = m.netzTeil(alpha, W, sz.H, true);
      const szene = m.bereichSzene(W, sz.H, [teil], par);
      const g = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'hoch', global);
      const c = m.rendern(sz.orig, W, sz.H, szene, 'cpu', 'hoch', global);
      out.push(`${name}: ${g.weg}/${c.weg} ${JSON.stringify(m.unterschied(g.daten, c.daten))}`);
    }
    return out;
  });
  console.log(r.join('\n'));
});
