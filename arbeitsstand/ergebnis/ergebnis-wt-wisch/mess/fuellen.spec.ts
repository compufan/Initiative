import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Wie schnell lässt sich ein Wischspeicher füllen? Vorversuch mit einem
 * eigenen <video>: Sprünge in Stufen (16, 8, 4, 2, 1), ein einziger
 * aufsteigender Durchlauf, und die Wiedergabe mit erhöhter Rate. Je Bild:
 * drawImage in 480 x 270, toBlob (WebP 0,75). Nur Messung.
 */
test('Füllgeschwindigkeit des Wischspeichers', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 412, height: 880 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle');
  const erg = await page.evaluate(async () => {
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const schreiben = (await import(/* @vite-ignore */ schreibenPfad)) as any;
    const W = 1280;
    const H = 720;
    const ANZAHL = 300;
    const leinwand = document.createElement('canvas');
    leinwand.width = W;
    leinwand.height = H;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    const textur = document.createElement('canvas');
    textur.width = 320;
    textur.height = 180;
    const tc = textur.getContext('2d') as CanvasRenderingContext2D;
    const td = tc.createImageData(320, 180);
    let saat = 4711;
    const zufall = () => {
      saat = (saat * 16807) % 2147483647;
      return saat / 2147483647;
    };
    for (let i = 0; i < 320 * 180; i += 1) {
      const v = 90 + zufall() * 120;
      td.data[i * 4] = v;
      td.data[i * 4 + 1] = v * 0.9;
      td.data[i * 4 + 2] = v * 0.8;
      td.data[i * 4 + 3] = 255;
    }
    tc.putImageData(td, 0, 0);
    const video = async (gop: number) =>
      schreiben.videoSchreiben(
        ANZAHL,
        (n: number) => {
          ctx.fillStyle = `hsl(${(n * 3) % 360},70%,40%)`;
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 0.3;
          ctx.drawImage(textur, -((n * 6) % 320), 0, 1280 + 320, 720);
          ctx.globalAlpha = 1;
          for (let k = 0; k < 40; k += 1) {
            ctx.fillStyle = `hsl(${(n * 7 + k * 31) % 360},80%,60%)`;
            ctx.fillRect((k * 97 + n * 13) % 1200, 80 + ((k * 53 + n * 5) % 580), 80, 60);
          }
          ctx.fillStyle = '#fff';
          ctx.font = '160px sans-serif';
          ctx.fillText(String(n), 440, 420);
          return leinwand;
        },
        { breite: W, hoehe: H, bildrate: 25, schluesselAbstand: gop },
      );

    const klein = document.createElement('canvas');
    klein.width = 480;
    klein.height = 270;
    const kc = klein.getContext('2d') as CanvasRenderingContext2D;
    kc.imageSmoothingQuality = 'high';

    const oeffnen = async (datei: Blob) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = URL.createObjectURL(datei);
      await new Promise<void>((f) => v.addEventListener('loadedmetadata', () => f(), { once: true }));
      return v;
    };
    const springen = (v: HTMLVideoElement, s: number) =>
      new Promise<void>((f) => {
        v.addEventListener('seeked', () => f(), { once: true });
        v.currentTime = s;
      });

    const stufen = [16, 8, 4, 2, 1];
    const reihenfolge = (mitStufen: boolean): number[] => {
      if (!mitStufen) return Array.from({ length: ANZAHL }, (_, k) => k);
      const raus: number[] = [];
      const schon = new Set<number>();
      for (const st of stufen) {
        for (let k = 0; k < ANZAHL; k += st) {
          if (!schon.has(k)) {
            schon.add(k);
            raus.push(k);
          }
        }
      }
      return raus;
    };

    const ergebnisse: any[] = [];
    for (const gop of [25, 100]) {
      const datei = await video(gop);
      for (const [name, mitStufen, warten] of [
        ['stufen-16-8-4-2-1, toBlob abwarten', true, true],
        ['stufen-16-8-4-2-1, toBlob nebenher', true, false],
        ['ein Durchlauf +1, toBlob nebenher', false, false],
      ] as const) {
        const v = await oeffnen(datei);
        const ordnung = reihenfolge(mitStufen);
        const blobs = new Map<number, Blob>();
        const offen: Promise<void>[] = [];
        const t0 = performance.now();
        const stand: number[] = [];
        let gezaehlt = 0;
        const sprungMs: number[] = [];
        for (const k of ordnung) {
          const ts = performance.now();
          await springen(v, (k + 0.5) * 40 / 1000);
          sprungMs.push(performance.now() - ts);
          kc.drawImage(v, 0, 0, 480, 270);
          const p = new Promise<void>((f) =>
            klein.toBlob((b) => {
              if (b) blobs.set(k, b);
              f();
            }, 'image/webp', 0.75),
          );
          if (warten) await p;
          else offen.push(p);
          gezaehlt += 1;
          if ([19, 38, 75, 150, 299].includes(gezaehlt) || gezaehlt === ordnung.length) stand.push(Math.round(performance.now() - t0));
        }
        await Promise.all(offen);
        const gesamt = performance.now() - t0;
        const bytes = [...blobs.values()].reduce((a, b) => a + b.size, 0);
        sprungMs.sort((a, b) => a - b);
        ergebnisse.push({
          art: 'sprung',
          gop,
          name,
          bilder: blobs.size,
          gesamtMs: Math.round(gesamt),
          msJeBild: +(gesamt / ordnung.length).toFixed(1),
          sprungMedianMs: +sprungMs[Math.floor(sprungMs.length / 2)].toFixed(1),
          sprungP95Ms: +sprungMs[Math.floor(sprungMs.length * 0.95)].toFixed(1),
          bytesGesamt: bytes,
          bytesJeBild: Math.round(bytes / blobs.size),
          // Zeit, bis 19 / 38 / 75 / 150 / 300 Bilder drin sind (bei Stufen: 16 / 8 / 4 / 2 / 1 fertig)
          zwischenstaende: stand,
        });
        v.removeAttribute('src');
        v.load();
      }
      // Wiedergabe mit erhöhter Rate – jedes vom Video gemeldete Bild wird mitgeschnitten.
      for (const rate of [1, 2, 4, 8]) {
        const v = await oeffnen(datei);
        v.playbackRate = rate;
        const gesehen = new Set<number>();
        const offen: Promise<void>[] = [];
        let blobBytes = 0;
        const fertig = new Promise<void>((f) => {
          const schritt = (_j: number, meta: { mediaTime: number }) => {
            const k = Math.floor(meta.mediaTime * 1000 / 40 + 1e-6);
            if (!gesehen.has(k)) {
              gesehen.add(k);
              kc.drawImage(v, 0, 0, 480, 270);
              offen.push(
                new Promise<void>((g) =>
                  klein.toBlob((b) => {
                    if (b) blobBytes += b.size;
                    g();
                  }, 'image/webp', 0.75),
                ),
              );
            }
            (v as any).requestVideoFrameCallback(schritt);
          };
          (v as any).requestVideoFrameCallback(schritt);
          v.addEventListener('ended', () => f(), { once: true });
        });
        const t0 = performance.now();
        await v.play();
        await fertig;
        await Promise.all(offen);
        ergebnisse.push({
          art: 'wiedergabe',
          gop,
          rate,
          gesamtMs: Math.round(performance.now() - t0),
          verschiedeneBilder: gesehen.size,
          von: ANZAHL,
        });
        v.removeAttribute('src');
        v.load();
      }
    }
    return ergebnisse;
  });
  for (const e of erg) console.log(JSON.stringify(e));
  writeFileSync(
    '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess/fuellen.json',
    JSON.stringify(erg, null, 1),
  );
});
