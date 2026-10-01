import { test } from '@playwright/test';

test('probe 1: Fall netz grund bokeh', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const out: any = {};
    for (const [name, par, maske, ziel] of [
      ['bokeh grund netz', { bokeh: 1 }, 'netz', 'grund'],
      ['weich grund netz', { unschaerfe: 1 }, 'netz', 'grund'],
      ['beide motiv video', { unschaerfe: 0.5, bokeh: 1 }, 'video', 'motiv'],
    ] as const) {
      const f = m.fall({ art: 'A', W: 600, maske, ziel, par });
      out[name] = {
        gleich: f.gleich,
        gpu: { g: f.weg.gpu.gerechnet, ms: Math.round(f.weg.gpu.ms), ab: f.weg.gpu.ab, kante: f.weg.gpu.kante },
        cpu: { g: f.weg.cpu.gerechnet, ms: Math.round(f.weg.cpu.ms), ab: f.weg.cpu.ab, kante: f.weg.cpu.kante },
        orig: f.original, maskeKante: f.maskeKante,
      };
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
});
