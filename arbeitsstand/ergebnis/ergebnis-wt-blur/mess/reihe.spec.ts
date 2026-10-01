import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const VARIANTEN = JSON.parse(process.env.VARIANTEN ?? '[{"name":"T05","par":{"bokeh":1}}]');
const W = Number(process.env.W ?? 600);

function png(url: string, datei: string) {
  writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

test('Reihe', async ({ page }) => {
  test.setTimeout(1_800_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  await page.addScriptTag({ path: `${BASIS}/mess/lib.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/fall.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/proto.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/gpu.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/cpu.js` });
  await page.evaluate(async () => {
    await (window as any).M.laden();
  });
  const r = await page.evaluate(
    (args) => {
      const M = (window as any).M;
      const { W, VARIANTEN } = args;
      const sz = M.szeneHolen('C', W);
      const { H } = sz;
      const alpha = M.alphaFuer(sz, 'hverlauf');
      const teil = M.netzTeil(alpha, W, H, false);
      const { raster, feld } = M.rasterFeld([teil], W, H);
      const maskImg = M.maskeAufBild(feld, raster, W, H);
      const R = 0.02 * Math.max(W, H);
      const messen = (res: Uint8ClampedArray) => {
        const liste: any[] = [];
        for (const p of sz.punkte) {
          if (Math.abs(p.y - 450 * (W / 1200)) > 1) continue;
          const m = maskImg[Math.round(p.y) * W + Math.round(p.x)] / 255;
          const w = Math.min(1, Math.max(0, (m - 0.06) / 0.86));
          const rexp = R * w;
          const prof: number[] = [];
          const n = Math.ceil(R * 1.6 * 4);
          const s = new Array(n).fill(0), c = new Array(n).fill(0);
          for (let y = Math.floor(p.y - R * 1.7); y <= Math.ceil(p.y + R * 1.7); y += 1)
            for (let x = Math.floor(p.x - R * 1.7); x <= Math.ceil(p.x + R * 1.7); x += 1) {
              if (x < 0 || y < 0 || x >= W || y >= H) continue;
              const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
              const b = Math.floor(d * 4);
              if (b >= n) continue;
              const i = y * W + x;
              s[b] += (res[i * 4] + res[i * 4 + 1] + res[i * 4 + 2]) / 3;
              c[b] += 1;
            }
          for (let i = 0; i < n; i += 1) prof.push(c[i] ? s[i] / c[i] : 0);
          const zentrum = prof.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
          let ebene = 0, ne = 0;
          for (let i = 0; i < n; i += 1) {
            const d = (i + 0.5) / 4;
            if (d >= 0.3 * rexp && d <= 0.7 * rexp) { ebene += prof[i]; ne += 1; }
          }
          ebene = ne ? ebene / ne : NaN;
          let r25 = 0;
          const ref = Math.max(...prof.slice(2));
          for (let i = 0; i < n; i += 1) if (prof[i] >= 0.25 * ref) r25 = (i + 0.5) / 4;
          let sl = 0, nl = 0, sr = 0, nr = 0;
          const rb = Math.max(2, rexp);
          for (let y = Math.floor(p.y - rb * 0.5); y <= Math.ceil(p.y + rb * 0.5); y += 1)
            for (let dx = Math.ceil(rb * 0.2); dx <= Math.floor(rb * 0.7); dx += 1) {
              const il = y * W + Math.round(p.x - dx), ir = y * W + Math.round(p.x + dx);
              sl += (res[il * 4] + res[il * 4 + 1] + res[il * 4 + 2]) / 3; nl += 1;
              sr += (res[ir * 4] + res[ir * 4 + 1] + res[ir * 4 + 2]) / 3; nr += 1;
            }
          let q1 = 0, q2 = 0, qn = 0;
          for (let y = Math.floor(p.y - rb); y <= Math.ceil(p.y + rb); y += 1)
            for (let x = Math.floor(p.x - rb); x <= Math.ceil(p.x + rb); x += 1) {
              if (Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) > 0.75 * rb) continue;
              const i = y * W + x; const v = (res[i * 4] + res[i * 4 + 1] + res[i * 4 + 2]) / 3; q1 += v; q2 += v * v; qn += 1;
            }
          const mw = q1 / qn; const cv = +(Math.sqrt(Math.max(0, q2 / qn - mw * mw)) / (mw || 1)).toFixed(3);
          const seite = nl && sr ? +((sl / nl) / (sr / nr)).toFixed(2) : null;
          liste.push({ cv, seiteLR: seite, m: +m.toFixed(2), rErwartet: +rexp.toFixed(1), r25: +r25.toFixed(1), zentrum: +zentrum.toFixed(0), ebene: +ebene.toFixed(0), verh: +(zentrum / ebene).toFixed(2) });
        }
        return liste;
      };
      const aus: any = {};
      const bilder: any = {};
      const jetzt = M.rendern(sz.orig, W, H, [{ feld, raster, anpassung: { unschaerfe: 1 } }], 'gpu');
      aus.jetzt = messen(jetzt.daten);
      const u = W / 1200;
      const crop = (res: Uint8ClampedArray, titel: string) => ({ titel, daten: res });
      const liste = [crop(sz.orig, 'Original'), crop(jetzt.daten, 'JETZT')];
      for (const v of VARIANTEN) {
        const res = v.gpu ? M.G.bokehBild(sz.orig, W, H, maskImg, v.par, 0).daten : v.cpu ? M.C.bokehBild(sz.orig, W, H, maskImg, v.par).daten : M.P.rendern(sz.orig, W, H, maskImg, v.par);
        aus[v.name] = messen(res);
        liste.push(crop(res, v.name));
      }
      const url = M.montageV(liste, W, H, Math.round(W * 0.40), Math.round(450 * u - 30), Math.round(W * 0.60), 60, 3);
      return { aus, url };
    },
    { W, VARIANTEN },
  );
  png(r.url, `${BASIS}/bilder/reihe-${process.env.PRE ?? 'x'}.png`);
  writeFileSync(`${BASIS}/bilder/reihe-${process.env.PRE ?? 'x'}.json`, JSON.stringify(r.aus, null, 1));
  for (const [k, v] of Object.entries(r.aus)) {
    console.log(k);
    for (const z of v as any[]) console.log('  ', JSON.stringify(z));
  }
});
