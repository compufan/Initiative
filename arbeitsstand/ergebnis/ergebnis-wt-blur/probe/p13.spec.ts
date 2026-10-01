import { test } from '@playwright/test';

test('probe 13: Matrix final', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const out: any[] = [];
    const faelle: [string, any, string, string][] = [
      ['bokeh grund netz', { bokeh: 1 }, 'netz', 'grund'],
      ['bokeh motiv netz', { bokeh: 1 }, 'netz', 'motiv'],
      ['bokeh grund video', { bokeh: 1 }, 'video', 'grund'],
      ['bokeh grund netzbreit', { bokeh: 1 }, 'netzbreit', 'grund'],
      ['weich grund netz', { unschaerfe: 1 }, 'netz', 'grund'],
      ['weich motiv netz', { unschaerfe: 1 }, 'netz', 'motiv'],
      ['weich grund video', { unschaerfe: 1 }, 'video', 'grund'],
      ['weich grund netzbreit', { unschaerfe: 1 }, 'netzbreit', 'grund'],
      ['beide grund netz', { unschaerfe: 1, bokeh: 1 }, 'netz', 'grund'],
      ['beide motiv netz', { unschaerfe: 0.6, bokeh: 0.6 }, 'netz', 'motiv'],
    ];
    for (const [name, par, maske, ziel] of faelle) {
      const f = m.fall({ art: 'A', W: 1200, maske, ziel, par, wege: ['gpu'] });
      const z = (w: string) => {
        const e = f.weg[w];
        return `${w}: ger15=${e.ab.geaendert15}/${e.ab.anzahl15} ger0=${e.ab.geaendert0} reich=${e.ab.reichweite} fern=${e.ab.fern.toFixed(2)} fremd=${e.ab.fremd.map((x: number) => x.toFixed(3)).join('/')} kb=${e.kante.breite.toFixed(2)} kk=${e.kante.kontrast.toFixed(3)} vs=${e.kante.versatz.toFixed(2)} st=${(e.kante.steilheit / f.original.steilheit).toFixed(2)} ms=${Math.round(e.ms)}`;
      };
      out.push(`${name} | maske ${f.maskeKante.breite.toFixed(1)} orig ${f.original.breite.toFixed(2)} | gleich ${JSON.stringify(f.gleich)}\n   ${z('gpu')}\n   ${'-'}`);
    }
    // Lichter
    for (const guete of ['hoch', 'mittel', 'niedrig'] as const) {
      const f = m.fall({ art: 'B', W: 1200, maske: 'netz', ziel: 'grund', par: { bokeh: 1 }, guete, wege: ['gpu'] });
      for (const w of ['gpu']) out.push(`licht ${guete} ${w}: ${JSON.stringify(f.weg[w].lichter)} gleich ${JSON.stringify(f.gleich)}`);
    }
    return out;
  });
  console.log(r.join('\n'));
});
