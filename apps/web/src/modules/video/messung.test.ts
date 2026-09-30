import { describe, expect, it } from 'vitest';

import type { Lesung } from './leserDienst.js';
import { kettenPlan } from './masken.js';
import {
  ablegbar,
  fensterRechnen,
  inhaltFensterSuchen,
  type FensterLeser,
} from './maskenVerfolgen.js';
import { bildIndex } from './raster.js';
import { rleKodieren } from './rle.js';
import { SPUR_BUDGET, Vorrat } from './spurVorrat.js';
import { bewegtGlaetten, grauMass, type Grau } from './verfolgung.js';

/**
 * Messungen für die Verfolgung im Hintergrund – nur auf Verlangen:
 *
 *     SPUR_MESSEN=1 npx vitest run src/modules/video/messung.test.ts
 *
 * Gemessen wird, was die Verfolgung JE FILMBILD selbst kostet – ohne Lesen
 * und ohne Modell: Suche der Spur, Überblenden, Glätten, Lauflängen,
 * Messwerte, Ablegen. Dazu die Grösse der Lauflängen einer weichen Scheibe
 * und einer verrauschten Zuversichtsmaske (wie „Person" sie liefert), in
 * Rechengrösse 960 × 540. Die Zahlen stehen in der Ausgabe; geprüft wird
 * nur, dass sie in der Grössenordnung der Spez liegen.
 */

const MESSEN =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.SPUR_MESSEN === '1';

const B = 960;
const H = 540;
const S = 40;

/** Pseudozufall mit festem Anfang – dieselben Zahlen bei jedem Lauf. */
function zufall(anfang: number) {
  let z = anfang;
  return () => {
    z = (z * 1103515245 + 12345) & 0x7fffffff;
    return z / 0x7fffffff;
  };
}

/** Eine weiche Scheibe: innen 255, ein Rand von `rand` Punkten Breite. */
function weicheScheibe(mx: number, my: number, r: number, rand = 6): Uint8Array {
  const maske = new Uint8Array(B * H);
  for (let y = Math.max(0, Math.floor(my - r - rand)); y < Math.min(H, my + r + rand); y += 1) {
    for (let x = Math.max(0, Math.floor(mx - r - rand)); x < Math.min(B, mx + r + rand); x += 1) {
      const d = Math.hypot(x - mx, y - my) - r;
      if (d <= -rand / 2) maske[y * B + x] = 255;
      else if (d < rand / 2) maske[y * B + x] = Math.round(255 * (0.5 - d / rand));
    }
  }
  return maske;
}

/**
 * Wie ein Freisteller, der Zuversicht liefert statt einer Maske: innen
 * 235 … 255 mit Rauschen, aussen 0 … 12, dazwischen ein unruhiger Rand.
 */
function verrauscht(mx: number, my: number, r: number, anfang = 7): Uint8Array {
  const naechste = zufall(anfang);
  const maske = new Uint8Array(B * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) {
      const d = Math.hypot(x - mx, y - my) - r + 4 * (naechste() - 0.5);
      let wert: number;
      if (d < -5) wert = 235 + 20 * naechste();
      else if (d > 5) wert = 12 * naechste();
      else wert = 255 * (0.5 - d / 10) + 30 * (naechste() - 0.5);
      maske[y * B + x] = Math.max(0, Math.min(255, Math.round(wert)));
    }
  }
  return maske;
}

function grauBild(k: number, mx: number, my: number, r: number): Grau {
  const { b, h, faktor } = grauMass(B, H);
  const werte = new Float32Array(b * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < b; x += 1) {
      const px = x * faktor;
      const py = y * faktor;
      let g = 128 + 50 * Math.sin(px / 13 + Math.cos(py / 17)) * Math.cos(py / 11 - px / 29);
      if (Math.hypot(px - mx, py - my) <= r) g = 210 + 30 * Math.sin(px / 7) * Math.cos(py / 9);
      werte[y * b + x] = g;
    }
  }
  void k;
  return { breite: b, hoehe: h, werte };
}

describe.skipIf(!MESSEN)('Messung bei 960 × 540', () => {
  it('Lauflängen je Bild', () => {
    const scheibe = weicheScheibe(480, 270, 120);
    const rauschen = verrauscht(480, 270, 120);
    const leer = new Uint8Array(B * H);
    // Zwei Nachbarn, um den weichen Rand, den das Glätten dazulegt, mitzumessen.
    const geglaettet = bewegtGlaetten(
      [weicheScheibe(476, 270, 120), scheibe, weicheScheibe(484, 270, 120)],
      B,
      H,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 0 },
      ],
    )[1];
    const rauschGlatt = bewegtGlaetten(
      [verrauscht(476, 270, 120, 3), rauschen, verrauscht(484, 270, 120, 11)],
      B,
      H,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 0 },
      ],
    )[1];
    const zahlen = {
      roh: B * H,
      scheibe: rleKodieren(scheibe).length,
      scheibeGeglaettet: rleKodieren(geglaettet).length,
      rauschen: rleKodieren(rauschen).length,
      rauschenGeglaettet: rleKodieren(rauschGlatt).length,
      rauschenAbgelegt: ablegbar(rauschGlatt).rle.length,
      scheibeAbgelegt: ablegbar(geglaettet).rle.length,
      leer: rleKodieren(leer).length,
    };
    console.log('RLE_BYTES', JSON.stringify(zahlen));
    expect(zahlen.scheibe).toBeLessThan(16 * 1024);
  });

  for (const art of ['scheibe', 'rauschen'] as const) {
    it(`Spur je Bild – ${art}`, async () => {
      /*
       * Ein Lauf über 81 Bilder in Fenstern wie im Betrieb (20 Pfadbilder
       * bei 960 × 540), Schlüsselbilder alle 4. Das Modell ist eine Tabelle:
       * Die Zeit ist die der Verfolgung selbst.
       */
      const anzahl = 81;
      const wo = (k: number) => ({ x: 200 + 4 * k, y: 270 });
      const masken = new Map<number, Uint8Array>();
      const maskeAn = (k: number) => {
        let m = masken.get(k);
        if (!m) {
          m =
            art === 'scheibe'
              ? weicheScheibe(wo(k).x, wo(k).y, 100)
              : verrauscht(wo(k).x, wo(k).y, 100, k + 1);
          masken.set(k, m);
        }
        return m;
      };
      const graue = Array.from({ length: anzahl }, (_, k) => grauBild(k, wo(k).x, wo(k).y, 100));
      const leser: FensterLeser = {
        async holen(ms): Promise<Lesung> {
          return { voll: null, grau: graue[bildIndex(ms, S)] };
        },
      };
      const ziele = Array.from({ length: anzahl }, (_, k) => k);
      const lauf = kettenPlan({ anker: 0, ziele, K: 4, fenster: 20, jenseits: 'verloren' }).vor
        .laeufe[0];
      for (const k of lauf.schluessel) maskeAn(k);
      maskeAn(0);
      const vorrat = new Vorrat(SPUR_BUDGET, 320 * 180);
      const kette = vorrat.kette('m', 0);
      const u = { leser, vorrat, s: S, b: B, h: H, luft: async () => {} };
      const beginn = performance.now();
      for (;;) {
        const plan = inhaltFensterSuchen(lauf, 'fein', 'vor', kette, 20);
        if (!plan) break;
        await fensterRechnen(
          {
            art: 'inhalt',
            kette,
            richtung: 'vor',
            pass: 'fein',
            pfad: plan.pfad,
            ziele: new Set(lauf.ziele),
            schluessel: new Set(lauf.schluessel),
            laufStart: 0,
            start: plan.rand
              ? { art: 'rand', zustand: plan.rand }
              : { art: 'anker', maske: maskeAn(0), punkte: null },
            tipp: false,
            wiederBilder: 50,
            brauchtBild: () => false,
            rechnen: async (k) => maskeAn(k),
          },
          u,
        );
      }
      const dauer = performance.now() - beginn;
      let bytes = 0;
      for (let k = 1; k < anzahl; k += 1) {
        const eintrag = kette.bild(k);
        if (eintrag && !eintrag.verloren) bytes += eintrag.rle.length;
      }
      const zahlen = {
        msJeBild: +(dauer / (anzahl - 1)).toFixed(2),
        rleMittelBytes: Math.round(bytes / (anzahl - 1)),
      };
      console.log(`SPUR_${art.toUpperCase()}`, JSON.stringify(zahlen));
      expect(kette.anzahl).toBe(anzahl - 1);
    }, 120_000);
  }
});
