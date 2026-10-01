import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
const FAELLE = JSON.parse(process.env.FAELLE ?? '[]');

function png(url: string, datei: string) {
  writeFileSync(datei, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

test('Messung', async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(`${BASIS}/bilder`, { recursive: true });
  await page.goto('/');
  await page.addScriptTag({ path: `${BASIS}/mess/lib.js` });
  await page.addScriptTag({ path: `${BASIS}/mess/fall.js` });
  await page.evaluate(async () => {
    await (window as any).M.laden();
  });
  for (const fall of FAELLE) {
    const name = `${fall.art}-${fall.maske}-${fall.ziel}-u${fall.u ?? 1}-${fall.W}`;
    const r = await page.evaluate((opt) => {
      const M = (window as any).M;
      const f = M.fall(opt);
      const bilder = M.bilderFuer(f, opt.ausschnitt);
      const { ergebnisse, sz, maskImg, feld, raster, ...rest } = f;
      return { rest, bilder };
    }, fall);
    png(r.bilder.ausschnitt, `${BASIS}/bilder/${name}-ausschnitt.png`);
    png(r.bilder.gesamt, `${BASIS}/bilder/${name}-gesamt.png`);
    writeFileSync(`${BASIS}/bilder/${name}.json`, JSON.stringify(r.rest, null, 1));
    console.log(name, JSON.stringify(r.rest.massnahmen ? Object.keys(r.rest.massnahmen) : []), 'gpuMs', r.rest.gpuMs, 'cpuMs', r.rest.cpuMs);
  }
});
