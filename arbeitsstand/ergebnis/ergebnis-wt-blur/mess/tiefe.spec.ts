import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const VARIANTEN = JSON.parse(process.env.VARIANTEN ?? '[]');
const W = Number(process.env.W ?? 600);
const MASKE = process.env.MASKE ?? 'netz';

function png(url: string, datei: string) {
  writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

test('Motiv + Tiefe', async ({ page }) => {
  test.setTimeout(1_800_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => {
    await (window as any).M.laden();
  });
  const r = await page.evaluate(
    (a) => {
      const M = (window as any).M;
      const sz = M.szeneHolen('A', a.W);
      const { W, H } = sz;
      const t = M.tiefeMotiv(sz, a.MASKE, 0.9, 0.5);
      const maskImg = M.maskeAufBild(t.feld, t.raster, W, H);
      const tiefeImg = M.maskeAufBild(t.nurTiefe, t.raster, W, H);
      const reinImg = M.maskeAufBild(t.reinheit, t.raster, W, H);
      const aus: any = {};
      const liste: any[] = [{ titel: 'Original', daten: sz.orig }];
      const jetzt = M.rendern(sz.orig, W, H, [{ feld: t.feld, raster: t.raster, anpassung: { unschaerfe: 1 } }], 'gpu');
      aus.jetzt = { halo: M.haloSchaerfe(sz, jetzt.daten, tiefeImg) };
      liste.push({ titel: 'JETZT', daten: jetzt.daten });
      aus.original = { halo: M.haloSchaerfe(sz, sz.orig, tiefeImg) };
      for (const v of a.VARIANTEN) {
        const par = { ...v.par };
        if (v.rein) par.reinheitFeld = reinImg;
        const res = M.P.rendern(sz.orig, W, H, maskImg, par);
        const fremd = 'motiv';
        const ab = M.messenAB(sz.orig, res, maskImg, W, H, sz.rBg, sz.rMo, fremd);
        delete ab.sdM;
        const prof = M.kantenProfile(sz, { orig: sz.orig, proto: res }, maskImg, sz.rBg, sz.rMo);
        aus[v.name] = { halo: M.haloSchaerfe(sz, res, tiefeImg), aussen: ab.aussen.map((x: any) => x.mittelAbw), k15: ab.kleinerGleich15, kante: M.profilKennzahlen(prof.proto, prof.ts) };
        liste.push({ titel: v.name, daten: res });
      }
      const mask = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i += 1) { mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = maskImg[i]; mask[i * 4 + 3] = 255; }
      liste.push({ titel: 'Maske', daten: mask });
      const url = M.montage(liste, W, H, 0, 0, W, H, 0.6, 0);
      const u = W / 1200;
      const url2 = M.montage(liste.slice(0, liste.length - 1), W, H, Math.round(560 * u), Math.round(200 * u), Math.round(200 * u), Math.round(150 * u), 2, 0);
      return { aus, url, url2 };
    },
    { W, VARIANTEN, MASKE },
  );
  const pre = process.env.PRE ?? 'x';
  png(r.url, `${BASIS}/bilder/tiefe-${pre}.png`);
  png(r.url2, `${BASIS}/bilder/tiefe-${pre}-kante.png`);
  writeFileSync(`${BASIS}/bilder/tiefe-${pre}.json`, JSON.stringify(r.aus, null, 1));
  for (const [k, v] of Object.entries(r.aus)) console.log(k, JSON.stringify((v as any).halo), (v as any).k15 ? JSON.stringify((v as any).k15) : '', (v as any).kante ? `breite ${(v as any).kante.breite1090.toFixed(1)} rand4 ${(v as any).kante.rand4.toFixed(2)} t50 ${(v as any).kante.lage50.toFixed(1)}` : '');
});
