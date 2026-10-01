import { test } from '@playwright/test';
test('probe 8: Lichtpunkt Spitze', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const k = 400;
    const d = new Uint8ClampedArray(k * k * 4);
    for (let i = 0; i < k * k; i++) d.set([10, 10, 10, 255], i * 4);
    const mid = (k / 2) * k + k / 2;
    for (const c of [0, 1, 2]) d[mid * 4 + c] = 255;
    const feld = new Uint8Array(k * k).fill(255);
    const out: any = {};
    for (const weg of ['gpu', 'cpu']) {
      const s = m.handSzene(feld, k, k, { bokeh: 1 });
      const r = m.rendern(d, k, k, s, weg);
      let max = 0; for (let i = 0; i < k * k; i++) max = Math.max(max, r.daten[i * 4]);
      out[weg] = max;
    }
    return out;
  });
  console.log(JSON.stringify(r));
});
