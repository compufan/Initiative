import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('Randfaelle', async ({ page }) => {
  test.setTimeout(3_600_000);
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu', 'cpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  await page.evaluate(async () => { await (window as any).M.laden(); });
  const r = await page.evaluate(() => {
    const M = (window as any).M;
    const aus: any = {};
    const zufall = (n: number) => { const a = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i += 1) { a[i * 4] = (i * 37) % 256; a[i * 4 + 1] = (i * 91) % 256; a[i * 4 + 2] = (i * 13) % 256; a[i * 4 + 3] = 255; } return a; };
    for (const [W, H, bokeh, weich] of [[1, 1, 1, 1], [3, 2, 20, 20], [7, 5, 20, 20], [33, 17, 20, 20], [33, 17, 1, 1], [1201, 899, 0.5, 0.5], [64, 4, 10, 10]] as any) {
      const orig = zufall(W * H);
      const mask = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) mask[y * W + x] = x < W / 2 ? 255 : 0;
      const name = `${W}x${H} bokeh${bokeh} weich${weich}`;
      try {
        const par = { bokeh, weich, K_stufen: 3, reinheit: 0, summiert: true };
        const g = M.G.beideBild(orig, W, H, mask, par, 0);
        const c = M.C.beide(orig, W, H, mask, par);
        let mx = 0, nan = 0, s = 0, leftGeaendert = 0;
        for (let i = 0; i < W * H * 4; i += 1) { const d = Math.abs(g.daten[i] - c.daten[i]); s += d; if (d > mx) mx = d; if (Number.isNaN(g.daten[i]) || Number.isNaN(c.daten[i])) nan += 1; }
        for (let y = 0; y < H; y += 1) for (let x = Math.floor(W / 2) + 2; x < W; x += 1) for (let k = 0; k < 3; k += 1) if (g.daten[(y * W + x) * 4 + k] !== orig[(y * W + x) * 4 + k]) leftGeaendert += 1;
        aus[name] = { gpuGegenCpuMax: mx, mittel: +(s / (W * H * 4)).toFixed(3), nan, ausserhalbGeaendert: leftGeaendert };
      } catch (e: any) {
        aus[name] = { fehler: String(e && e.message ? e.message.slice(0, 200) : e) };
      }
    }
    return aus;
  });
  console.log(JSON.stringify(r, null, 1));
});
