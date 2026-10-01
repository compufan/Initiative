import { test } from '@playwright/test';

test('probe 6: Direkt klein', async ({ page }) => {
  page.on('console', (msg) => console.log('PAGE:', msg.text()));
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const out: string[] = [];
    for (const [W, H] of [[1, 1], [3, 2], [7, 5], [33, 17], [64, 48]]) {
      for (const [bokehPx, weichPx] of [[0.8, 0], [5, 0], [13, 0], [40, 0], [0, 2], [0, 13], [13, 4]]) {
        for (const reinheit of [0, 1] as const) {
          for (const guete of ['hoch', 'niedrig'] as const) {
            const n = W * H;
            // einfarbig
            const orig = new Uint8ClampedArray(n * 4);
            const mix = new Uint8ClampedArray(n * 4);
            for (let i = 0; i < n; i++) {
              orig.set([120, 60, 200, 255], i * 4);
              mix.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255], i * 4);
            }
            const maske = new Uint8Array(n).fill(255);
            const ebene = { bokehPx, weichPx, reinheit };
            const a = m.stufeDirekt(orig, W, H, maske, ebene, guete);
            let maxEinf = 0, nan = false;
            for (let i = 0; i < n * 4; i++) { maxEinf = Math.max(maxEinf, Math.abs(a.cpu[i] - orig[i])); if (a.gpu) maxEinf = Math.max(maxEinf, 0); }
            let gMax = 0;
            if (a.gpu) for (let i = 0; i < n * 4; i++) gMax = Math.max(gMax, Math.abs(a.gpu[i] - orig[i]));
            const b = m.stufeDirekt(mix, W, H, maske, ebene, guete);
            const u = b.gpu ? m.unterschied(b.gpu, b.cpu) : null;
            out.push(`${W}x${H} R=${bokehPx} s=${weichPx} rein=${reinheit} ${guete}: einfarbig cpu-abw ${maxEinf} gpu-abw ${a.gpu ? gMax : 'keine gpu'} | gemischt gpu/cpu ${u ? u.max + '/' + u.mittel.toFixed(3) : 'keine gpu'}`);
          }
        }
      }
    }
    return out;
  });
  console.log(r.join('\n'));
});
