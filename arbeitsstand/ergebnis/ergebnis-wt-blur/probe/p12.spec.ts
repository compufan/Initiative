import { test } from '@playwright/test';
test('probe 12: Zeiten', async ({ page }) => {
  test.setTimeout(600000);
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const gpuPfad = '/src/modules/bild/tonGpu.ts';
    const gpu: any = await import(/* @vite-ignore */ gpuPfad);
    const tonPfad = '/src/modules/bild/ton.ts';
    const ton: any = await import(/* @vite-ignore */ tonPfad);
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const out: string[] = [];
    for (const W of [1200]) {
      const sz = m.szeneHolen('A', W);
      const alpha = m.maskeAlpha(sz, 'netz');
      const teil = m.netzTeil(alpha, W, sz.H, true);
      const quelle = m.leinwandAus(sz.orig, W, sz.H);
      for (const [name, par] of [['Bokeh 100', { bokeh: 1 }], ['Weichzeichnen 100', { unschaerfe: 1 }], ['beide', { bokeh: 1, unschaerfe: 1 }]] as const) {
        for (const guete of ['hoch', 'mittel', 'niedrig'] as const) {
          const szene = m.bereichSzene(W, sz.H, [teil], par);
          const kalt: number[] = [];
          for (let i = 0; i < 3; i++) {
            // neue Quelle -> volle Rechnung
            const q = m.leinwandAus(sz.orig, W, sz.H);
            const t0 = performance.now();
            const f = gpu.bildRechnen(q, W, sz.H, ton.NEUTRAL, szene, { fluechtig: true, guete });
            m.lesen(f, W, sz.H);
            kalt.push(performance.now() - t0);
          }
          // Zug an Belichtung: gleiche Quelle, Zettel
          const warm: number[] = [];
          gpu.bildRechnen(quelle, W, sz.H, ton.NEUTRAL, szene, { fluechtig: true, guete });
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const f = gpu.bildRechnen(quelle, W, sz.H, { ...ton.NEUTRAL, belichtung: 0.1 * (i + 1) }, szene, { fluechtig: true, guete });
            m.lesen(f, W, sz.H);
            warm.push(performance.now() - t0);
          }
          out.push(`GPU ${W}x${sz.H} ${name} ${guete}: kalt ${med(kalt).toFixed(0)} ms, Zug an Belichtung ${med(warm).toFixed(0)} ms`);
        }
      }
    }
    // CPU
    {
      const W = 1200;
      const sz = m.szeneHolen('A', W);
      const alpha = m.maskeAlpha(sz, 'netz');
      const teil = m.netzTeil(alpha, W, sz.H, true);
      for (const guete of ['hoch', 'mittel', 'niedrig'] as const) {
        const szene = m.bereichSzene(W, sz.H, [teil], { bokeh: 1 });
        const t: number[] = [];
        for (let i = 0; i < 2; i++) { const r = m.rendern(sz.orig, W, sz.H, szene, 'cpu', guete); t.push(r.ms); }
        out.push(`CPU ${W}x${sz.H} Bokeh 100 ${guete}: ${med(t).toFixed(0)} ms`);
      }
      const szene = m.bereichSzene(W, sz.H, [teil], { unschaerfe: 1 });
      const r = m.rendern(sz.orig, W, sz.H, szene, 'cpu', 'mittel');
      out.push(`CPU ${W}x${sz.H} Weichzeichnen 100: ${r.ms.toFixed(0)} ms`);
    }
    return out;
  });
  console.log(r.join('\n'));
});
