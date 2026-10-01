import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/** Was kann dieser Browser, und was kosten kleine Bilder? Nur Messung, kein Test. */
test('Fähigkeiten und Kosten kleiner Bilder', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const erg = await page.evaluate(async () => {
    const W = 1280;
    const H = 720;
    const fe = window as any;
    const faehig = {
      ua: navigator.userAgent,
      VideoEncoder: typeof fe.VideoEncoder,
      VideoDecoder: typeof fe.VideoDecoder,
      ImageDecoder: typeof fe.ImageDecoder,
      OffscreenCanvas: typeof fe.OffscreenCanvas,
      createImageBitmap: typeof fe.createImageBitmap,
      rvfc: typeof (HTMLVideoElement.prototype as any).requestVideoFrameCallback,
      memory: (performance as any).memory
        ? { genutzt: (performance as any).memory.usedJSHeapSize, grenze: (performance as any).memory.jsHeapSizeLimit }
        : null,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as any).deviceMemory ?? null,
    };
    // rAF-Takt
    const takt: number[] = await new Promise((fertig) => {
      const t: number[] = [];
      const schritt = (n: number) => {
        t.push(n);
        if (t.length < 61) requestAnimationFrame(schritt);
        else fertig(t);
      };
      requestAnimationFrame(schritt);
    });
    const rafMs = (takt[takt.length - 1] - takt[0]) / (takt.length - 1);

    // Zwei Bilder: einfach und mit feiner Textur (obere Schranke für die Grösse).
    const leinwand = document.createElement('canvas');
    leinwand.width = W;
    leinwand.height = H;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    const einfach = () => {
      ctx.fillStyle = 'hsl(200,70%,40%)';
      ctx.fillRect(0, 0, W, H);
      for (let k = 0; k < 40; k += 1) {
        ctx.fillStyle = `hsl(${(k * 31) % 360},80%,60%)`;
        ctx.fillRect((k * 97) % 1200, (k * 53) % 660, 80, 60);
      }
    };
    const textur = () => {
      const t = document.createElement('canvas');
      t.width = W;
      t.height = H;
      const tc = t.getContext('2d') as CanvasRenderingContext2D;
      const d = tc.createImageData(W, H);
      let saat = 12345;
      const zufall = () => {
        saat = (saat * 16807) % 2147483647;
        return saat / 2147483647;
      };
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = (y * W + x) * 4;
          const grund = 90 + 60 * Math.sin(x / 40) * Math.cos(y / 33);
          const r = grund + (zufall() - 0.5) * 50;
          d.data[i] = r;
          d.data[i + 1] = r * 0.9 + (zufall() - 0.5) * 30;
          d.data[i + 2] = r * 0.7 + (zufall() - 0.5) * 30;
          d.data[i + 3] = 255;
        }
      }
      tc.putImageData(d, 0, 0);
      ctx.drawImage(t, 0, 0);
    };
    const kosten: any[] = [];
    for (const [bildName, maler] of [['einfach', einfach], ['textur', textur]] as const) {
      maler();
      for (const kante of [320, 480, 640]) {
        const b = kante;
        const h = Math.round((kante * H) / W);
        const klein = document.createElement('canvas');
        klein.width = b;
        klein.height = h;
        const kc = klein.getContext('2d') as CanvasRenderingContext2D;
        kc.imageSmoothingQuality = 'high';
        const tv = performance.now();
        for (let i = 0; i < 10; i += 1) kc.drawImage(leinwand, 0, 0, b, h);
        const verkleinernMs = (performance.now() - tv) / 10;
        for (const [typ, guete] of [['image/webp', 0.6], ['image/webp', 0.8], ['image/jpeg', 0.7], ['image/jpeg', 0.85]] as const) {
          const t0 = performance.now();
          let blob: Blob | null = null;
          for (let i = 0; i < 5; i += 1) {
            blob = await new Promise<Blob | null>((f) => klein.toBlob((x) => f(x), typ, guete));
          }
          const kodMs = (performance.now() - t0) / 5;
          if (!blob) {
            kosten.push({ bildName, kante, typ, guete, fehler: 'kein Blob' });
            continue;
          }
          const echt = blob.type;
          const t1 = performance.now();
          let bmp: ImageBitmap | null = null;
          for (let i = 0; i < 10; i += 1) {
            bmp?.close();
            bmp = await createImageBitmap(blob);
          }
          const dekMs = (performance.now() - t1) / 10;
          const ziel = document.createElement('canvas');
          ziel.width = W;
          ziel.height = H;
          const zc = ziel.getContext('2d') as CanvasRenderingContext2D;
          zc.imageSmoothingQuality = 'high';
          const t2 = performance.now();
          for (let i = 0; i < 10; i += 1) zc.drawImage(bmp!, 0, 0, W, H);
          const hochMs = (performance.now() - t2) / 10;
          bmp?.close();
          kosten.push({
            bildName,
            kante,
            typ,
            echt,
            guete,
            bytes: blob.size,
            verkleinernMs: +verkleinernMs.toFixed(2),
            kodierenMs: +kodMs.toFixed(2),
            dekodierenMs: +dekMs.toFixed(2),
            hochskalierenMs: +hochMs.toFixed(2),
          });
        }
        // Zum Vergleich: unkomprimiert als ImageData / ImageBitmap aus Canvas.
        const t3 = performance.now();
        let bm2: ImageBitmap | null = null;
        for (let i = 0; i < 10; i += 1) {
          bm2?.close();
          bm2 = await createImageBitmap(klein);
        }
        kosten.push({
          bildName,
          kante,
          typ: 'bitmap-aus-canvas',
          rohBytes: b * h * 4,
          bitmapMs: +((performance.now() - t3) / 10).toFixed(2),
        });
        bm2?.close();
      }
    }
    return { faehig, rafMs, kosten };
  });
  console.log(JSON.stringify(erg.faehig));
  console.log('rAF-Takt ms', erg.rafMs);
  for (const k of erg.kosten) console.log(JSON.stringify(k));
  writeFileSync(
    '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess/probe.json',
    JSON.stringify(erg, null, 1),
  );
});
