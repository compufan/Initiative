import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Was kostet ein Bild der Vorschau? Die App-eigenen Zeichenfunktionen
 * (zeichneAnsicht, fluechtig) mit ein, zwei, vier Masken in Rechengrösse
 * 960 x 540 – und der Weg aus einem kleinen, komprimierten Speicherbild dorthin.
 * Nur Messung. Läuft ohne Video.
 */
test('Zeichenkosten der Vorschau', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 412, height: 880 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle');
  await page.evaluate(([b, h, kanten, masken]) => {
    const w = window as any;
    w.__B = b; w.__H = h; w.__kanten = kanten; w.__masken = masken;
  }, [Number(process.env.ZB ?? 960), Number(process.env.ZH ?? 540), (process.env.ZKANTEN ?? '1400,840').split(',').map(Number), (process.env.ZMASKEN ?? '0,1,2,4').split(',').map(Number)] as const);
  const erg = await page.evaluate(async () => {
    const pfade = {
      zeichnen: '/src/modules/bild/zeichnen.ts',
      ton: '/src/modules/bild/tonGpu.ts',
      doc: '/src/modules/bild/doc.ts',
      tonTyp: '/src/modules/bild/ton.ts',
      rle: '/src/modules/video/rle.ts',
    };
    const zeichnen = (await import(/* @vite-ignore */ pfade.zeichnen)) as any;
    const ton = (await import(/* @vite-ignore */ pfade.ton)) as any;
    const docModul = (await import(/* @vite-ignore */ pfade.doc)) as any;
    const tonTyp = (await import(/* @vite-ignore */ pfade.tonTyp)) as any;
    const rle = (await import(/* @vite-ignore */ pfade.rle)) as any;
    const B = (window as any).__B ?? 960;
    const H = (window as any).__H ?? 540;
    const stat = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      return {
        mittel: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
        p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
        p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
        max: +s[s.length - 1].toFixed(2),
      };
    };

    // Quellbild: Textur + bunte Flächen, je Durchgang anders.
    const quelle = document.createElement('canvas');
    quelle.width = B;
    quelle.height = H;
    const qc = quelle.getContext('2d') as CanvasRenderingContext2D;
    const textur = document.createElement('canvas');
    textur.width = 240;
    textur.height = 135;
    const tc = textur.getContext('2d') as CanvasRenderingContext2D;
    const td = tc.createImageData(240, 135);
    let saat = 99;
    const zufall = () => {
      saat = (saat * 16807) % 2147483647;
      return saat / 2147483647;
    };
    for (let i = 0; i < 240 * 135; i += 1) {
      const v = 80 + zufall() * 130;
      td.data[i * 4] = v;
      td.data[i * 4 + 1] = v * 0.9;
      td.data[i * 4 + 2] = v * 0.8;
      td.data[i * 4 + 3] = 255;
    }
    tc.putImageData(td, 0, 0);
    const malen = (n: number) => {
      qc.fillStyle = `hsl(${(n * 3) % 360},60%,40%)`;
      qc.fillRect(0, 0, B, H);
      qc.globalAlpha = 0.4;
      qc.drawImage(textur, -((n * 5) % 240), 0, B + 240, H);
      qc.globalAlpha = 1;
      for (let k = 0; k < 30; k += 1) {
        qc.fillStyle = `hsl(${(n * 7 + k * 31) % 360},80%,60%)`;
        qc.fillRect((k * 71 + n * 9) % 880, (k * 43 + n * 4) % 480, 70, 50);
      }
    };

    const neutralBereich = docModul.BEREICH_NEUTRAL;
    let marke = 1000;
    /** Eine weiche Netzmaske (Scheibe), je Aufruf mit neuer Marke – wie eine neue Maske je Filmbild. */
    const netzTeil = (nr: number, n: number) => {
      const alpha = new Uint8Array(B * H);
      const cx = 200 + nr * 180 + (n % 40) * 3;
      const cy = 270 + Math.sin(n / 9) * 60;
      const r = 90;
      const y0 = Math.max(0, Math.floor(cy - r - 10));
      const y1 = Math.min(H, Math.ceil(cy + r + 10));
      const x0 = Math.max(0, Math.floor(cx - r - 10));
      const x1 = Math.min(B, Math.ceil(cx + r + 10));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const d = Math.hypot(x - cx, y - cy);
          alpha[y * B + x] = d < r ? 255 : d < r + 6 ? Math.round(255 * (1 - (d - r) / 6)) : 0;
        }
      }
      marke += 1;
      return { id: `t${nr}`, modus: 'dazu', umkehren: false, art: 'netz', netz: 'object', breite: B, hoehe: H, alpha, marke };
    };
    const docMit = (masken: number, n: number, frisch: boolean) => {
      const doc = docModul.neuesDoc(B, H);
      doc.anpassung = { ...doc.anpassung, belichtung: 0.2, saettigung: -0.4 };
      doc.bereiche = Array.from({ length: masken }, (_, i) => ({
        id: `b${i}`,
        name: `Maske ${i + 1}`,
        aktiv: true,
        teile: [frisch ? netzTeil(i, n) : (docMit as any).fest[i]],
        anpassung: { ...neutralBereich, belichtung: -0.5 + i * 0.25, saettigung: i % 2 ? 0.6 : -0.8 },
      }));
      return doc;
    };
    (docMit as any).fest = [0, 1, 2, 3].map((i) => netzTeil(i, 0));

    const ziel = document.createElement('canvas');
    const lauf = async (masken: number, maxKante: number, frisch: boolean, runden = 50) => {
      const roh: number[] = [];
      const sync: number[] = [];
      for (let i = 0; i < runden + 5; i += 1) {
        malen(i);
        ton.quelleVeraendert(quelle);
        const doc = masken === 0 ? { ...docModul.neuesDoc(B, H), anpassung: { ...docModul.neuesDoc(B, H).anpassung, belichtung: 0.2, saettigung: -0.4 } } : docMit(masken, i, frisch);
        const t0 = performance.now();
        zeichnen.zeichneAnsicht(ziel, quelle, B, H, doc, { maxKante, zuschnittZeigen: false, fluechtig: true });
        const t1 = performance.now();
        (ziel.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, 1, 1);
        const t2 = performance.now();
        if (i >= 5) {
          roh.push(t1 - t0);
          sync.push(t2 - t0);
        }
        await new Promise((f) => setTimeout(f, 0));
      }
      return { masken, maxKante, frischeMasken: frisch, ohneSync: stat(roh), mitSync: stat(sync), ziel: `${ziel.width}x${ziel.height}`, weg: ton.letzterWeg };
    };
    const zeichnenMs: any[] = [];
    for (const maxKante of (window as any).__kanten ?? [1400, 840]) {
      for (const masken of (window as any).__masken ?? [0, 1, 2, 4]) {
        zeichnenMs.push(await lauf(masken, maxKante, false));
        if (masken > 0) zeichnenMs.push(await lauf(masken, maxKante, true));
      }
    }

    // Der Weg aus dem Speicherbild: toBlob -> createImageBitmap -> drawImage in Rechengrösse
    const kleinDaten: Blob[] = [];
    for (let n = 0; n < 40; n += 1) {
      malen(n);
      const k = document.createElement('canvas');
      k.width = 480;
      k.height = 270;
      const kc = k.getContext('2d') as CanvasRenderingContext2D;
      kc.imageSmoothingQuality = 'high';
      kc.drawImage(quelle, 0, 0, 480, 270);
      kleinDaten.push(await new Promise<Blob>((f) => k.toBlob((b) => f(b as Blob), 'image/webp', 0.75)));
    }
    const dek: number[] = [];
    const hoch: number[] = [];
    for (const blob of kleinDaten) {
      const t0 = performance.now();
      const bmp = await createImageBitmap(blob);
      const t1 = performance.now();
      qc.imageSmoothingQuality = 'high';
      qc.drawImage(bmp, 0, 0, B, H);
      const t2 = performance.now();
      bmp.close();
      dek.push(t1 - t0);
      hoch.push(t2 - t1);
    }

    // RLE: Maske dekodieren
    const alpha = netzTeil(0, 0).alpha;
    const kodiert = rle.rleKodieren(alpha);
    const rl: number[] = [];
    const buf = new Uint8Array(B * H);
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      rle.rleDekodieren(kodiert, B * H, buf);
      rl.push(performance.now() - t0);
    }
    return {
      zeichnenMs,
      speicherbild: { bytesJeBild: kleinDaten.map((b) => b.size).reduce((a, b) => a + b, 0) / kleinDaten.length, dekodieren: stat(dek), hochskalieren: stat(hoch) },
      rle: { kodiertBytes: kodiert.byteLength, dekodieren: stat(rl) },
      tonTypVorhanden: typeof tonTyp,
    };
  });
  for (const z of erg.zeichnenMs) console.log(JSON.stringify(z));
  console.log(JSON.stringify(erg.speicherbild));
  console.log(JSON.stringify(erg.rle));
  writeFileSync(
    `/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess/zeichnen-${process.env.ZB ?? 960}.json`,
    JSON.stringify(erg, null, 1),
  );
});
