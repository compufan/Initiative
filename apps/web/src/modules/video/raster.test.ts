import { describe, expect, it } from 'vitest';

import { FILM_BILDRATEN, filmSchrittMs, filmZeitpunkte } from './ausschnitt.js';
import {
  bildBereich,
  bildIndex,
  bildMitte,
  bildZuFilm,
  fensterGroesse,
  filmRaster,
  filmZuBild,
  grobAbstand,
  quellBilder,
  rasterEnde,
  rasterRunden,
  schluesselAbstand,
} from './raster.js';
import { rasterNeu, type Abschnitt } from './schnitt.js';

/**
 * Das Zeitraster: Bild k der Quelle bei der Bildrate des Films.
 *
 * Alles, was über den Film gespeichert wird, steht in k – ein Fehler um EIN
 * Bild legt eine Maske über das Nachbarbild, und das sieht man erst an
 * einem schnell bewegten Gegenstand, wenn überhaupt. Deshalb wird hier jede
 * Filmrate durchgezählt, auch die mit krummer Schrittweite (24, 30, 60).
 */

const RATEN = [10, 15, 24, 25, 30, 50, 60];

describe('bildIndex, bildMitte, rasterRunden', () => {
  it.each(RATEN)('trifft bei %i Bildern je Sekunde jedes Bild genau', (rate) => {
    const s = filmSchrittMs(rate);
    for (let k = 0; k < 3000; k += 1) {
      // Die Mitte gehört zu k, die linke Kante auch, knapp davor schon zu k − 1.
      expect(bildIndex(bildMitte(k, s), s)).toBe(k);
      expect(bildIndex(k * s, s)).toBe(k);
      if (k > 0) expect(bildIndex(k * s - 1e-3, s)).toBe(k - 1);
      expect(rasterRunden(k * s + 0.49 * s, s)).toBeCloseTo(k * s, 9);
      expect(rasterRunden(k * s + 0.51 * s, s)).toBeCloseTo((k + 1) * s, 9);
    }
  });

  it('kommt mit krummen Schritten zurecht', () => {
    // 1000 / 24 = 41,666…; 24 · s liegt in Gleitkomma knapp unter 1000.
    const s = 1000 / 24;
    expect(bildIndex(24 * s, s)).toBe(24);
    expect(bildIndex(1000, s)).toBe(24);
    expect(bildMitte(24, s)).toBeCloseTo(1020.8333, 3);
  });
});

describe('quellBilder und rasterEnde', () => {
  it('zählt nur GANZE Bilder der Quelle', () => {
    // Ein 126. Bild hätte seine Mitte genau auf dem Ende – siehe `quellBilder`.
    expect(quellBilder(5020, 40)).toBe(125);
    expect(quellBilder(5000, 40)).toBe(125);
    expect(quellBilder(5039, 40)).toBe(125);
    expect(rasterEnde(5020, 40)).toBe(5000);
    expect(quellBilder(3000, 1000 / 30)).toBe(90);
  });

  it('hat mindestens ein Bild, auch bei einer winzigen Quelle', () => {
    expect(quellBilder(10, 40)).toBe(1);
    expect(quellBilder(0, 40)).toBe(1);
  });
});

describe('bildBereich', () => {
  it('stimmt mit abtasten überein – auch für Kanten neben dem Raster', () => {
    const s = 1000 / 24;
    for (const [von, bis] of [
      [0, 1000],
      [1013, 2987],
      [41.7, 83.3],
      [500, 510],
    ]) {
      const plan = filmZeitpunkte([{ vonMs: von, bisMs: bis }], 24, 10_000).zeitpunkte;
      const { k0, k1 } = bildBereich({ vonMs: von, bisMs: bis }, s);
      expect(plan.map((ms) => bildIndex(ms, s))).toEqual(
        Array.from({ length: k1 - k0 }, (_, i) => k0 + i),
      );
    }
  });
});

describe('Kanten auf dem Raster', () => {
  it.each(RATEN)(
    'legt bei %i Bildern je Sekunde jedes Filmbild genau auf eine Rastermitte',
    (rate) => {
      const s = filmSchrittMs(rate);
      let zufall = 12345 + rate;
      const naechste = () => {
        zufall = (zufall * 1103515245 + 12345) % 2 ** 31;
        return zufall / 2 ** 31;
      };
      for (let runde = 0; runde < 40; runde += 1) {
        const roh: Abschnitt[] = Array.from({ length: 1 + Math.floor(naechste() * 4) }, (_, i) => {
          const von = naechste() * 20_000;
          return {
            id: `a${i}`,
            vonMs: von,
            bisMs: von + 1 + naechste() * 3000,
            doc: null,
            standMs: von,
          };
        });
        const { abschnitte } = rasterNeu(roh, s, 30_000);
        const plan = filmZeitpunkte(abschnitte, rate, 100_000);
        let stelle = 0;
        for (const [nummer, abschnitt] of abschnitte.entries()) {
          const { k0, k1 } = bildBereich(abschnitt, s);
          expect(abschnitt.vonMs).toBeCloseTo(k0 * s, 9);
          for (let k = k0; k < k1; k += 1) {
            const ms = plan.zeitpunkte[stelle];
            expect(plan.stueckJeBild[stelle]).toBe(nummer);
            // Genau die Mitte – bis auf Gleitkommareste.
            expect(Math.abs(ms - bildMitte(k, s))).toBeLessThan(1e-6);
            stelle += 1;
          }
        }
        expect(stelle).toBe(plan.zeitpunkte.length);
      }
    },
  );
});

describe('filmRaster', () => {
  const s = 40;
  const abschnitte = [
    { vonMs: 2000, bisMs: 2400 },
    { vonMs: 0, bisMs: 200 },
    { vonMs: 2200, bisMs: 2600 },
  ];

  it('zählt die Bilder in Filmreihenfolge und F ohne Doppelte', () => {
    const raster = filmRaster(abschnitte, s, 600);
    expect(raster.bilder).toHaveLength(10 + 5 + 10);
    expect(raster.bilder[0]).toEqual({ stelle: 0, nummer: 0, k: 50 });
    expect(raster.bilder[10]).toEqual({ stelle: 10, nummer: 1, k: 0 });
    // 55 … 59 kommen zweimal vor, stehen in F aber einmal.
    expect(raster.menge).toEqual([
      0, 1, 2, 3, 4, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64,
    ]);
    expect(raster.jenseits).toBe(0);
  });

  it('hält die Obergrenze des Filmbaus ein', () => {
    const raster = filmRaster(abschnitte, s, 12);
    expect(raster.bilder).toHaveLength(12);
    expect(raster.menge).toEqual([0, 1, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    expect(raster.jenseits).toBe(13);
  });

  it('ist ohne Abschnitte leer', () => {
    expect(filmRaster([], s, 600)).toEqual({ bilder: [], menge: [], jenseits: 0 });
  });
});

describe('Filmzeit und Rasterbild', () => {
  const s = 40;
  const abschnitte = [
    { vonMs: 2000, bisMs: 2400 },
    { vonMs: 0, bisMs: 200 },
  ];

  it('findet Abschnitt und Bild – die Grenze gehört dem späteren', () => {
    expect(filmZuBild(abschnitte, 0, s)).toEqual({ nummer: 0, k: 50 });
    expect(filmZuBild(abschnitte, 399, s)).toEqual({ nummer: 0, k: 59 });
    expect(filmZuBild(abschnitte, 400, s)).toEqual({ nummer: 1, k: 0 });
    // Hinter dem Ende: das letzte Bild, nicht das dahinter.
    expect(filmZuBild(abschnitte, 10_000, s)).toEqual({ nummer: 1, k: 4 });
    expect(filmZuBild([], 0, s)).toBeNull();
  });

  it('rechnet hin und zurück auf die Bildmitte', () => {
    for (let film = 0; film < 600; film += 7) {
      const ort = filmZuBild(abschnitte, film, s);
      expect(ort).not.toBeNull();
      if (!ort) continue;
      const mitte = bildZuFilm(abschnitte, ort.nummer, ort.k, s);
      expect(Math.abs(mitte - film)).toBeLessThanOrEqual(s / 2);
      expect(filmZuBild(abschnitte, mitte, s)).toEqual(ort);
    }
  });
});

describe('Schlüssel und Fenster', () => {
  it('rechnet bei jeder Filmrate an jedem vierten Bild ein Modell', () => {
    for (const { rate } of FILM_BILDRATEN) {
      expect(schluesselAbstand(filmSchrittMs(rate))).toBe(4);
    }
    expect(schluesselAbstand(filmSchrittMs(2))).toBe(1);
  });

  it('legt den Grobpass auf ein Vielfaches davon, rund eine Sekunde', () => {
    expect(grobAbstand(4, 40)).toBe(24);
    expect(grobAbstand(4, filmSchrittMs(60))).toBe(60);
    for (const { rate } of FILM_BILDRATEN) {
      const s = filmSchrittMs(rate);
      const K = schluesselAbstand(s);
      expect(grobAbstand(K, s) % K).toBe(0);
      expect(grobAbstand(K, s)).toBeGreaterThanOrEqual(2 * K);
    }
  });

  it('bemisst ein Fenster nach der Fläche', () => {
    expect(fensterGroesse(960, 540, 4)).toBe(20);
    expect(fensterGroesse(1280, 720, 4)).toBe(12);
    expect(fensterGroesse(640, 360, 4)).toBe(48);
    expect(fensterGroesse(4000, 3000, 4)).toBe(8);
  });
});
