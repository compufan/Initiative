import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
function png(url: string, datei: string) { writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')); }
test('Mischmaske und Verlauf', async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const aus: any = {};
    // ---- Motiv + Tiefe (gemischt: Kernfeld = 255 - Silhouette) ----
    {
      const W = 1200, H = 900;
      const sz = M.szeneHolen('A', W, H);
      const t = M.tiefeMotiv(sz, 'netz', 0.9, 0.5);
      const maskImg = M.maskeAufBild(t.feld, t.raster, W, H);
      const tiefeImg = M.maskeAufBild(t.nurTiefe, t.raster, W, H);
      const kernImg = M.maskeAufBild(t.reinheit, t.raster, W, H);
      const jetzt = M.rendern(sz.orig, W, H, [{ feld: t.feld, raster: t.raster, anpassung: { unschaerfe: 1 } }], 'gpu');
      const par = { bokeh: 1, K_stufen: 6, reinheit: 2, kernImg, faktor: 2, summiert: true };
      const g = M.G.bokehBild(sz.orig, W, H, maskImg, par, 0);
      const c = M.C.bokehBild(sz.orig, W, H, maskImg, par);
      let s = 0, mx = 0, n = 0;
      for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const d = Math.abs(g.daten[i * 4 + k] - c.daten[i * 4 + k]); s += d; n += 1; if (d > mx) mx = d; }
      const ab = M.messenAB(sz.orig, g.daten, maskImg, W, H, sz.rBg, sz.rMo, 'motiv'); delete ab.sdM;
      const abJ = M.messenAB(sz.orig, jetzt.daten, maskImg, W, H, sz.rBg, sz.rMo, 'motiv'); delete abJ.sdM;
      aus.motivTiefe = {
        gpuGegenCpu: { mittel: +(s / n).toFixed(3), max: mx },
        haloJetzt: M.haloSchaerfe(sz, jetzt.daten, tiefeImg), haloNeu: M.haloSchaerfe(sz, g.daten, tiefeImg), haloOrig: M.haloSchaerfe(sz, sz.orig, tiefeImg),
        k15Neu: ab.kleinerGleich15, k15Jetzt: abJ.kleinerGleich15,
        aussenNeu: ab.aussen.map((x: any) => x.mittelAbw), aussenJetzt: abJ.aussen.map((x: any) => x.mittelAbw),
        fremdNeu: ab.innen.map((x: any) => x.fremdAnteil), fremdJetzt: abJ.innen.map((x: any) => x.fremdAnteil),
      };
      const liste = [{ titel: 'Original', daten: sz.orig }, { titel: 'JETZT GPU', daten: jetzt.daten }, { titel: 'NEU GPU', daten: g.daten }, { titel: 'NEU CPU', daten: c.daten }];
      const g2 = M.G.bokehBild(sz.orig, W, H, maskImg, { ...par, summiert: false }, 0);
      aus.motivTiefeOhneSumme = { halo: M.haloSchaerfe(sz, g2.daten, tiefeImg) };
      aus.urlMT = M.montage(liste, W, H, 0, 0, W, H, 0.35, 0);
      aus.urlMT2 = M.montage(liste, W, H, 560, 200, 240, 180, 2, 0);
    }
    // ---- Verlauf (glatt, Tiefenkarte allein): Lichterreihe ----
    {
      const W = 1200, H = 900;
      const sz = M.szeneHolen('C', W, H);
      const alpha = M.alphaFuer(sz, 'hverlauf');
      const teil = M.netzTeil(alpha, W, H, false);
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      const jetzt = M.rendern(sz.orig, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'gpu');
      const res: any = {};
      const liste = [{ titel: 'Original', daten: sz.orig }, { titel: 'JETZT GPU', daten: jetzt.daten }];
      for (const [K, sum] of [[4, false], [6, false], [4, true], [6, true], [8, true]] as [number, boolean][]) {
        const par = { bokeh: 1, K_stufen: K, reinheit: 1, faktor: 2, summiert: sum };
        const g = M.G.bokehBild(sz.orig, W, H, maskImg, par, 3);
        const c = M.C.bokehBild(sz.orig, W, H, maskImg, par);
        let s = 0, mx = 0, n = 0;
        for (let i = 0; i < W * H; i += 1) for (let k = 0; k < 3; k += 1) { const d = Math.abs(g.daten[i * 4 + k] - c.daten[i * 4 + k]); s += d; n += 1; if (d > mx) mx = d; }
        res[`K${K}${sum ? 's' : ''}`] = { gpuMs: Math.round(g.ms), cpuMs: Math.round(c.ms), gpuGegenCpu: { mittel: +(s / n).toFixed(3), max: mx } };
        liste.push({ titel: `NEU GPU K=${K}${sum ? ' summiert' : ''}`, daten: g.daten });
      }
      aus.verlauf = res;
      aus.urlV = M.montageV(liste, W, H, 480, 400, 720, 100, 1);
    }
    return aus;
  });
  png(r.urlMT, `${BASIS}/bilder/misch-motivtiefe.png`);
  png(r.urlMT2, `${BASIS}/bilder/misch-motivtiefe-kante.png`);
  png(r.urlV, `${BASIS}/bilder/misch-verlauf.png`);
  const { urlMT, urlMT2, urlV, ...rest } = r;
  writeFileSync(`${BASIS}/bilder/misch.json`, JSON.stringify(rest, null, 1));
  console.log(JSON.stringify(rest, null, 1));
});
