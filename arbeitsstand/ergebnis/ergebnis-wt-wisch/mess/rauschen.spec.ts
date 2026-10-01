import { test } from '@playwright/test';
test('Grösse eines Rauschbildes im Speicher', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  const erg = await page.evaluate(async () => {
    const roh = document.createElement('canvas');
    roh.width = 1280;
    roh.height = 720;
    const rc = roh.getContext('2d') as CanvasRenderingContext2D;
    const d = rc.createImageData(1280, 720);
    for (let i = 0; i < d.data.length; i += 1) d.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
    rc.putImageData(d, 0, 0);
    const klein = document.createElement('canvas');
    klein.width = 480;
    klein.height = 270;
    const kc = klein.getContext('2d') as CanvasRenderingContext2D;
    kc.imageSmoothingQuality = 'high';
    kc.drawImage(roh, 0, 0, 480, 270);
    const aus: Record<string, number> = {};
    for (const [typ, g] of [['image/webp', 0.75], ['image/jpeg', 0.8]] as const) {
      const b = await new Promise<Blob>((f) => klein.toBlob((x) => f(x as Blob), typ, g));
      aus[`Rauschen 1280 auf 480 verkleinert, ${typ} ${g}`] = b.size;
    }
    // Schlimmster Fall: Rauschen schon in 480 x 270
    const d2 = kc.createImageData(480, 270);
    for (let i = 0; i < d2.data.length; i += 1) d2.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
    kc.putImageData(d2, 0, 0);
    for (const [typ, g] of [['image/webp', 0.75], ['image/jpeg', 0.8]] as const) {
      const b = await new Promise<Blob>((f) => klein.toBlob((x) => f(x as Blob), typ, g));
      aus[`Rauschen unmittelbar 480 x 270, ${typ} ${g}`] = b.size;
    }
    return aus;
  });
  console.log(JSON.stringify(erg, null, 1));
});
