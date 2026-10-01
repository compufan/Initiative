import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Vorversuch zum Zeichenweg: Wie gut läuft das Wischen, wenn die Bilder aus
 * einem Speicher kleiner WebP-Bilder kommen? Die Zeigerereignisse kommen mit
 * 60 Hz aus einem Zeitgeber in der Seite (Vorversuch ohne Leiste). Verglichen:
 *  A: entpacken IM Anzeigetakt (createImageBitmap, dann zeichnen)
 *  B: entpacken beim Zeigerereignis, zeichnen im Anzeigetakt
 *  C: wie B, dazu zwei Bilder in Fingerrichtung vorausgeladen
 * Gezeichnet wird roh (drawImage in 640 x 360) – der Zeichenweg der Bearbeitung
 * kommt in der Messung der App (zeichnen.spec.ts) dazu.
 * Nur Messung.
 */
test('Zeichenweg aus dem Speicher – roh', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  const erg = await page.evaluate(async () => {
    const ANZAHL = 300;
    // Speicher: 300 Bilder, 480 x 270, WebP 0,75
    const k480 = document.createElement('canvas');
    k480.width = 480;
    k480.height = 270;
    const c = k480.getContext('2d') as CanvasRenderingContext2D;
    const textur = document.createElement('canvas');
    textur.width = 120;
    textur.height = 68;
    const tc = textur.getContext('2d') as CanvasRenderingContext2D;
    const td = tc.createImageData(120, 68);
    let saat = 7;
    const zufall = () => {
      saat = (saat * 16807) % 2147483647;
      return saat / 2147483647;
    };
    for (let i = 0; i < 120 * 68; i += 1) {
      const v = 90 + zufall() * 120;
      td.data[i * 4] = v;
      td.data[i * 4 + 1] = v * 0.9;
      td.data[i * 4 + 2] = v * 0.8;
      td.data[i * 4 + 3] = 255;
    }
    tc.putImageData(td, 0, 0);
    const blobs: Blob[] = [];
    for (let n = 0; n < ANZAHL; n += 1) {
      c.fillStyle = `hsl(${(n * 3) % 360},70%,40%)`;
      c.fillRect(0, 0, 480, 270);
      c.globalAlpha = 0.3;
      c.drawImage(textur, -((n * 2) % 120), 0, 480 + 120, 270);
      c.globalAlpha = 1;
      c.fillStyle = '#fff';
      c.font = '90px sans-serif';
      c.fillText(String(n), 160, 160);
      blobs.push(await new Promise<Blob>((f) => k480.toBlob((b) => f(b as Blob), 'image/webp', 0.75)));
    }
    const bytes = blobs.reduce((a, b) => a + b.size, 0);

    const ziel = document.createElement('canvas');
    ziel.width = 640;
    ziel.height = 360;
    ziel.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:9999';
    document.body.appendChild(ziel);
    const zc = ziel.getContext('2d') as CanvasRenderingContext2D;

    const lauf = async (
      name: string,
      strategie: 'A' | 'B' | 'C',
      dauerMs: number,
      lruGroesse: number,
    ) => {
      const proben: Array<{ t: number; bild: number }> = [];
      const finger: Array<{ t: number; k: number }> = [];
      const entpackt = new Map<number, ImageBitmap | Promise<ImageBitmap>>();
      const lru: number[] = [];
      const laden = (k: number): Promise<ImageBitmap> => {
        let e = entpackt.get(k);
        if (!e) {
          e = createImageBitmap(blobs[k]);
          entpackt.set(k, e);
          (e as Promise<ImageBitmap>).then((b) => entpackt.set(k, b));
          lru.push(k);
          while (lru.length > lruGroesse) {
            const weg = lru.shift() as number;
            const w = entpackt.get(weg);
            if (w && !(w instanceof Promise)) w.close();
            entpackt.delete(weg);
          }
        }
        return e instanceof Promise ? e : Promise.resolve(e);
      };
      let ziel_k = 0;
      let angezeigt = -1;
      let geplant = false;
      let zeichnungen = 0;
      const zeichnen = (k: number, bmp: ImageBitmap) => {
        zc.drawImage(bmp, 0, 0, 640, 360);
        angezeigt = k;
        zeichnungen += 1;
      };
      const takt = () => {
        geplant = false;
        const k = ziel_k;
        if (strategie === 'A') {
          void laden(k).then((b) => {
            if (k === ziel_k || angezeigt < 0) zeichnen(k, b);
          });
        } else {
          const e = entpackt.get(k);
          if (e && !(e instanceof Promise)) zeichnen(k, e);
          else void laden(k).then((b) => zeichnen(k, b));
        }
      };
      // Takt der Proben: nach dem Anzeigetakt
      let aus = false;
      const probe = () => {
        if (aus) return;
        requestAnimationFrame(() => {
          setTimeout(() => proben.push({ t: performance.now(), bild: angezeigt }), 0);
          probe();
        });
      };
      probe();
      const t0 = performance.now();
      let letzter = -1;
      await new Promise<void>((fertig) => {
        const ereignis = () => {
          const jetzt = performance.now();
          const a = (jetzt - t0) / dauerMs;
          if (a > 1) {
            fertig();
            return;
          }
          const k = Math.min(ANZAHL - 1, Math.floor(a * ANZAHL));
          ziel_k = k;
          finger.push({ t: jetzt, k });
          if (strategie !== 'A') {
            void laden(k);
            if (strategie === 'C') {
              const v = k - letzter;
              if (letzter >= 0 && v !== 0) {
                void laden(Math.max(0, Math.min(ANZAHL - 1, k + v)));
                void laden(Math.max(0, Math.min(ANZAHL - 1, k + 2 * v)));
              }
            }
          }
          letzter = k;
          if (!geplant) {
            geplant = true;
            requestAnimationFrame(takt);
          }
          setTimeout(ereignis, 1000 / 60);
        };
        ereignis();
      });
      await new Promise((f) => setTimeout(f, 200));
      aus = true;
      // Auswertung
      let wechsel = 0;
      for (let i = 1; i < proben.length; i += 1) if (proben[i].bild !== proben[i - 1].bild) wechsel += 1;
      const spaet: number[] = [];
      const alter: number[] = [];
      let fi = 0;
      for (const p of proben) {
        while (fi + 1 < finger.length && finger[fi + 1].t <= p.t) fi += 1;
        if (p.t < t0 + 50 || p.t > t0 + dauerMs || p.bild < 0) continue;
        spaet.push(Math.abs(finger[fi].k - p.bild));
        // Alter: wann war der Finger zuletzt bei p.bild (±1)?
        let gefunden = -1;
        for (let i = fi; i >= 0; i -= 1) {
          if (Math.abs(finger[i].k - p.bild) <= 1) {
            gefunden = finger[i].t;
            break;
          }
        }
        if (gefunden >= 0) alter.push(Math.max(0, p.t - gefunden));
      }
      const stat = (a: number[]) => {
        const s = [...a].sort((x, y) => x - y);
        return { mittel: +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1), p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
      };
      for (const v of entpackt.values()) if (!(v instanceof Promise)) v.close();
      return {
        name,
        dauerMs,
        bilderJeS: +((wechsel / dauerMs) * 1000).toFixed(1),
        zeichnungenJeS: +((zeichnungen / dauerMs) * 1000).toFixed(1),
        verspaetungBilder: stat(spaet),
        bildalterMs: stat(alter),
      };
    };
    const liste: any[] = [];
    for (const dauer of [1000, 3000, 6000]) {
      for (const [name, s, lru] of [
        ['A entpacken im Takt', 'A', 4],
        ['B entpacken beim Ereignis, LRU 8', 'B', 8],
        ['C B + 2 Bilder voraus, LRU 12', 'C', 12],
      ] as const) {
        liste.push(await lauf(name, s, dauer, lru));
      }
    }
    return { bytesGesamt: bytes, bytesJeBild: Math.round(bytes / ANZAHL), liste };
  });
  console.log(JSON.stringify({ bytesGesamt: erg.bytesGesamt, bytesJeBild: erg.bytesJeBild }));
  for (const l of erg.liste) console.log(JSON.stringify(l));
  writeFileSync(
    '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess/prototyp.json',
    JSON.stringify(erg, null, 1),
  );
});
