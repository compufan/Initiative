import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const W = Number(process.env.W ?? 600);
test('Kalibrierung', async ({ page }) => {
  test.setTimeout(3_000_000);
  page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE', m.text().slice(0, 300)); });
  await page.goto('/');
  await page.waitForTimeout(2500);
  const faelle: any[] = [];
  for (const maske of ['netz', 'video', 'netzbreit', 'hart'])
    for (const ziel of ['grund', 'motiv'])
      for (const par of [{ bokeh: 1 }, { unschaerfe: 1 }, { bokeh: 0.8, unschaerfe: 0.5 }])
        faelle.push({ art: 'A', W, maske, ziel, par });
  faelle.push({ art: 'B', W, maske: 'netz', ziel: 'grund', par: { bokeh: 1 } });
  faelle.push({ art: 'B', W, maske: 'netz', ziel: 'grund', par: { bokeh: 1 }, guete: 'mittel' });
  faelle.push({ art: 'B', W, maske: 'netz', ziel: 'grund', par: { bokeh: 1 }, guete: 'niedrig' });
  const alle: any[] = [];
  for (const f of faelle) {
    const r = await page.evaluate(async (f) => {
      const m = (await import(/* @vite-ignore */ '/e2e/hilfen/unscharfMessen.ts')) as any;
      return m.fall(f);
    }, f);
    alle.push({ f, r });
    const g = r.weg.gpu, c = r.weg.cpu;
    const fm = (x: number[]) => x.map((v) => +v.toFixed(2)).join('/');
    console.log(`${f.art} ${f.maske.padEnd(9)} ${f.ziel.padEnd(5)} ${JSON.stringify(f.par).padEnd(30)} ${f.guete ?? 'hoch'} | G a15 ${g.ab.geaendert15} reich ${g.ab.reichweite} fern ${g.ab.fern.toFixed(2)} fremd ${fm(g.ab.fremd)} kante ${g.kante.breite.toFixed(1)} kontr ${g.kante.kontrast.toFixed(2)} vers ${g.kante.versatz.toFixed(1)} | P a15 ${c.ab.geaendert15} reich ${c.ab.reichweite} fremd ${fm(c.ab.fremd)} kante ${c.kante.breite.toFixed(1)} | gleich ${r.gleich.max}/${r.gleich.mittel.toFixed(4)} ms ${g.ms.toFixed(0)}/${c.ms.toFixed(0)}` + (g.lichter ? ` | L G inn ${g.lichter.innen.toFixed(0)} spitze ${g.lichter.spitze.toFixed(0)} rand ${g.lichter.randZuInnen.toFixed(2)} aus ${g.lichter.aussenZuInnen.toFixed(2)} str ${g.lichter.streuung.toFixed(3)} / P aus ${c.lichter.aussenZuInnen.toFixed(2)}` : '') + ` || orig kante ${r.original.breite.toFixed(1)} kontr ${r.original.kontrast.toFixed(2)} maske ${r.maskeKante.breite.toFixed(1)}`);
  }
  writeFileSync(`${BASIS}/kalib-${W}.json`, JSON.stringify(alle));
});
