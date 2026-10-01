import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const W = Number(process.env.W ?? 600);
function png(url: string, datei: string) { writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')); }

test('Paritaet und Bilder', async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(`${BASIS}/bilder2`, { recursive: true });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('PAGE', m.type(), m.text().slice(0, 400)); });
  await page.goto('/'); await page.waitForTimeout(2500);
  for (const f of ['lib', 'fall']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const faelle = [
    { name: 'bokeh-netz-grund', art: 'A', maske: 'netz', ziel: 'grund', par: { bokeh: 1 } },
    { name: 'weich-netz-grund', art: 'A', maske: 'netz', ziel: 'grund', par: { unschaerfe: 1 } },
    { name: 'beide-netz-motiv', art: 'A', maske: 'netz', ziel: 'motiv', par: { bokeh: 0.8, unschaerfe: 0.5 } },
    { name: 'bokeh-hart-motiv', art: 'A', maske: 'hart', ziel: 'motiv', par: { bokeh: 0.8 } },
    { name: 'licht-netz', art: 'B', maske: 'netz', ziel: 'grund', par: { bokeh: 1 } },
    { name: 'licht-verlauf', art: 'C', maske: 'hverlauf', ziel: 'motiv', par: { bokeh: 1 }, rein: 1 },
    { name: 'licht-verlauf-weich', art: 'C', maske: 'hverlauf', ziel: 'motiv', par: { bokeh: 0.7, unschaerfe: 0.3 }, rein: 1 },
  ];
  const nur = process.env.NUR;
  for (const f of faelle.filter((x) => !nur || nur.split(',').includes(x.name))) {
    const r = await page.evaluate(({ f, W }) => {
      const M = (window as any).M;
      const sz = M.szeneHolen(f.art, W);
      const { H } = sz;
      const alpha = M.alphaFuer(sz, f.maske);
      const teil = M.netzTeil(alpha, W, H, f.ziel === 'grund');
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      const out: any = {};
      (window as any).__stand = (window as any).__stand ?? 5000;
      let stand = 0;
      const lauf = (weg: string, guete: string) => {
        stand = (window as any).__stand += 1;
        const quelle = M.leinwandAus(sz.orig, W, H);
        const szene = {
          bereiche: [{ id: 'b0', maske: { raster, feld, stand }, reinheit: f.rein ?? 0, anpassung: { ...M.ton.FARB_NEUTRAL, unschaerfe: 0, bokeh: 0, ...f.par } }],
          schluessel: `n${stand}`,
        };
        M.gpu.gpuAbschalten(weg === 'cpu');
        const t0 = performance.now();
        const fl = M.gpu.bildRechnen(quelle, W, H, M.ton.NEUTRAL, szene, { guete });
        const ms = performance.now() - t0;
        const wegGel = M.gpu.letzterWeg;
        const d = M.lesen(fl, W, H);
        M.gpu.gpuAbschalten(false);
        return { d, ms, weg: wegGel };
      };
      const g = lauf('gpu', 'mittel');
      const c = lauf('cpu', 'mittel');
      let s = 0, mx = 0, n = 0;
      for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const x = Math.abs(g.d[i * 4 + k] - c.d[i * 4 + k]); s += x; n += 1; if (x > mx) mx = x; }
      // ausserhalb
      let aen = 0, an = 0;
      for (let i = 0; i < W * H; i += 1) if (maskImg[i] <= 15) { an += 1; for (let k = 0; k < 3; k += 1) if (g.d[i * 4 + k] !== sz.orig[i * 4 + k]) { aen += 1; break; } }
      const liste = [{ titel: 'Original', daten: sz.orig }, { titel: 'GPU', daten: g.d }, { titel: 'CPU', daten: c.d }];
      const gesamt = M.montage(liste, W, H, 0, 0, W, H, 0.5, 0);
      const u = W / 1200;
      const ausschnitt = M.montage(liste, W, H, Math.round(560 * u), Math.round(190 * u), Math.round(200 * u), Math.round(150 * u), 2, 4);
      return { wege: [g.weg, c.weg], ms: [g.ms, c.ms], max: mx, mittel: s / n, aussenGeaendert: aen, aussenAnzahl: an, gesamt, ausschnitt };
    }, { f, W });
    console.log(f.name, JSON.stringify({ ...r, gesamt: undefined, ausschnitt: undefined }));
    png(r.gesamt, `${BASIS}/bilder2/${f.name}-gesamt.png`);
    png(r.ausschnitt, `${BASIS}/bilder2/${f.name}-ausschnitt.png`);
  }
});
