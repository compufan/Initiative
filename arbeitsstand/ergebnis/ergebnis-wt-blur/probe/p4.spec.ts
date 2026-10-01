import { test } from '@playwright/test';

test('probe 4: Ring, Reihe, Paritaet', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const out: string[] = [];
    // K5 Ring um das Motiv bei Tiefe
    {
      const W = 1200;
      const sz = m.szeneHolen('A', W);
      const alpha = m.maskeAlpha(sz, 'netz');
      const szene = m.bereichSzene(W, sz.H, [m.tiefenTeil(W, sz.H, { motiv: sz.drin }), m.netzTeil(alpha, W, sz.H, false, 'weg')], { bokeh: 1 });
      out.push('reinheit ' + szene.bereiche[0].reinheit + ' kern ' + !!szene.bereiche[0].maske.kern);
      const orig = m.schaerfeBand(sz, sz.orig, 4, 8);
      const r = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'hoch');
      const nah = m.schaerfeBand(sz, r.daten, 4, 8);
      const fern = m.schaerfeBand(sz, r.daten, 32, 64);
      out.push(`ring: orig ${orig.toFixed(2)} nah ${nah.toFixed(2)} fern ${fern.toFixed(2)} verh ${(nah / fern).toFixed(2)} ms ${r.ms.toFixed(0)}`);
    }
    // K7 Reihe
    for (const guete of ['hoch', 'mittel'] as const) {
      const W = 1200;
      const sz = m.szeneHolen('C', W);
      const H = sz.H;
      const feld = m.maskeAlpha(sz, 'hverlauf');
      const szene = m.handSzene(feld, W, H, { bokeh: 1 }, 1);
      const r = m.rendern(sz.orig, W, H, szene, 'gpu', guete);
      const K = guete === 'hoch' ? 8 : 6;
      const reihe = m.reiheMessen(sz, r.daten, feld, 24, K);
      out.push(guete + ' ms ' + r.ms.toFixed(0));
      for (const l of reihe.slice(0, 9)) out.push(`   m ${l.m.toFixed(2)} erw ${l.erwartet.toFixed(1)} r25 ${l.r25.toFixed(1)} streu ${l.streuung.toFixed(3)}`);
    }
    return out;
  });
  console.log(r.join('\n'));
});
