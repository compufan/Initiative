import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Abdeckung', async ({ page }) => {
  await page.goto('/');
  await page.addScriptTag({ path: `${BASIS}/mess/lib.js` });
  const r = await page.evaluate(async () => {
    const bk = await import('/src/modules/bild/bokeh.ts');
    const W = 800, H = 600;
    const aus: any = {};
    for (const [px, py] of [[400, 300], [130, 560], [700, 560], [130, 40], [700, 40]]) {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i += 1) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 20; d[i * 4 + 3] = 255; }
      for (let y = py - 1; y <= py + 1; y += 1) for (let x = px - 1; x <= px + 1; x += 1) for (let k = 0; k < 3; k += 1) d[(y * W + x) * 4 + k] = 255;
      bk.bokehRgba(d, W, H, 10);
      let hell = 0, minx = 9999, maxx = -1, miny = 9999, maxy = -1;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (d[(y * W + x) * 4] > 22) { hell += 1; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      aus[`${px},${py}`] = { hell, breite: maxx - minx + 1, hoehe: maxy - miny + 1 };
    }
    return aus;
  });
  console.log(JSON.stringify(r));
});
