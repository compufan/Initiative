import { describe, expect, it } from 'vitest';

import {
  BAENDER,
  BAENDER_NEUTRAL,
  KURVE_STUETZEN,
  ausHsl,
  bandGewichte,
  baenderNeutral,
  feinPunkt,
  kurveAn,
  kurveGerade,
  kurveTabelle,
  kurvenFeld,
  zuHsl,
  type Farbband,
  type Kurvenpunkt,
} from './fein.js';

const GERADE: Kurvenpunkt[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function bandMit(index: number, werte: Partial<Farbband>): Farbband[] {
  return BAENDER_NEUTRAL.map((b, i) => (i === index ? { ...b, ...werte } : { ...b }));
}

describe('kurveTabelle', () => {
  it('lässt eine Gerade eine Gerade sein', () => {
    const t = kurveTabelle(GERADE);
    for (let i = 0; i < KURVE_STUETZEN; i += 1) {
      expect(t[i]).toBeCloseTo(i / (KURVE_STUETZEN - 1), 5);
    }
  });

  it('behandelt eine leere Liste wie eine Gerade', () => {
    const leer = kurveTabelle([]);
    const gerade = kurveTabelle(GERADE);
    expect(Array.from(leer)).toEqual(Array.from(gerade));
  });

  it('trifft die gesetzten Stützpunkte', () => {
    const t = kurveTabelle([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ]);
    // 0,5 liegt auf Stützstelle 16 von 32 – genau auf dem Punkt.
    expect(t[16]).toBeCloseTo(0.75, 4);
    expect(t[0]).toBeCloseTo(0, 5);
    expect(t[KURVE_STUETZEN - 1]).toBeCloseTo(1, 5);
  });

  it('schwingt nicht über – auch nicht bei einem scharfen Knick', () => {
    /*
     * Der Grund für das monotone Verfahren.
     *
     * Ein gewöhnlicher kubischer Spline durch diese vier Punkte macht
     * zwischen dem dritten und vierten einen Bauch über 1 und fällt dann
     * wieder – nachgerechnet auf 1,04. In einem Foto ist das ein heller Saum
     * um jede helle Fläche, und weil die Kurve dort FÄLLT, kippt ein Verlauf
     * dort stellenweise rückwärts.
     */
    const t = kurveTabelle([
      { x: 0, y: 0 },
      { x: 0.3, y: 0.05 },
      { x: 0.7, y: 0.95 },
      { x: 1, y: 1 },
    ]);
    for (let i = 0; i < KURVE_STUETZEN; i += 1) {
      expect(t[i]).toBeGreaterThanOrEqual(0);
      expect(t[i]).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < KURVE_STUETZEN; i += 1) {
      // Monoton heisst: nie rückwärts. Ein Tausendstel Luft für die
      // Rundung auf `Float32Array`.
      expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 0.001);
    }
  });

  it('kommt mit unsortierten, doppelten und unmöglichen Punkten zurecht', () => {
    const t = kurveTabelle([
      { x: 1, y: 1 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0.5 },
      { x: 2, y: -1 },
    ]);
    expect(t.length).toBe(KURVE_STUETZEN);
    for (const wert of t) expect(Number.isFinite(wert)).toBe(true);
    // Der spätere Punkt auf demselben x gewinnt.
    expect(t[16]).toBeCloseTo(0.8, 3);
  });

  it('erkennt eine gerade Kurve', () => {
    expect(kurveGerade([])).toBe(true);
    expect(kurveGerade(GERADE)).toBe(true);
    expect(kurveGerade([{ x: 0.5, y: 0.6 }])).toBe(false);
  });
});

describe('kurveAn', () => {
  it('liest dieselben Werte, die in der Tabelle stehen', () => {
    const feld = kurvenFeld({
      gesamt: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.75 },
        { x: 1, y: 1 },
      ],
      rot: [],
      gruen: [],
      blau: [],
    });
    expect(kurveAn(feld, 0, 0)).toBeCloseTo(0, 5);
    expect(kurveAn(feld, 0, 0.5)).toBeCloseTo(0.75, 4);
    expect(kurveAn(feld, 0, 1)).toBeCloseTo(1, 5);
    // Die drei Kanalkurven sind gerade geblieben.
    expect(kurveAn(feld, 1, 0.3)).toBeCloseTo(0.3, 4);
    expect(kurveAn(feld, 3, 0.8)).toBeCloseTo(0.8, 4);
  });

  it('klemmt ausserhalb von 0 … 1', () => {
    const feld = kurvenFeld({ gesamt: GERADE, rot: [], gruen: [], blau: [] });
    expect(kurveAn(feld, 0, -5)).toBeCloseTo(0, 5);
    expect(kurveAn(feld, 0, 5)).toBeCloseTo(1, 5);
  });
});

describe('HSL hin und zurück', () => {
  it('kommt bei denselben Farben wieder heraus', () => {
    const proben: [number, number, number][] = [
      [0, 0, 0],
      [1, 1, 1],
      [0.5, 0.5, 0.5],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.8, 0.4, 0.1],
      [0.12, 0.34, 0.56],
      [0.9, 0.9, 0.2],
    ];
    for (const [r, g, b] of proben) {
      const [h, s, l] = zuHsl(r, g, b);
      const [r2, g2, b2] = ausHsl(h, s, l);
      expect(r2).toBeCloseTo(r, 5);
      expect(g2).toBeCloseTo(g, 5);
      expect(b2).toBeCloseTo(b, 5);
    }
  });

  it('gibt Grau keinen Farbton', () => {
    const [h, s] = zuHsl(0.4, 0.4, 0.4);
    expect(s).toBe(0);
    expect(h).toBe(0);
  });
});

describe('bandGewichte', () => {
  it('summiert sich überall auf eins', () => {
    /*
     * Ohne Normierung, und trotzdem überall eins: Es wirken immer genau die
     * zwei benachbarten Bänder, mit `t` und `1 − t`. Bliebe die Summe
     * irgendwo darunter, gäbe es dort einen Farbton, an dem die Regler
     * schwächer greifen – ein Streifen im Verlauf, den niemand erklären
     * könnte.
     */
    for (let i = 0; i < 360; i += 1) {
      const w = bandGewichte(i / 360);
      let summe = 0;
      for (const g of w) summe += g;
      expect(summe).toBeCloseTo(1, 6);
    }
  });

  it('lässt keinen Farbton unerfasst', () => {
    for (let i = 0; i < 360; i += 1) {
      const w = bandGewichte(i / 360);
      expect(Math.max(...Array.from(w))).toBeGreaterThan(0);
    }
  });

  it('gibt der eigenen Bandmitte das meiste Gewicht', () => {
    for (let i = 0; i < BAENDER.length; i += 1) {
      const w = bandGewichte(BAENDER[i].winkel / 360);
      const groesstes = Array.from(w).indexOf(Math.max(...Array.from(w)));
      expect(groesstes).toBe(i);
    }
  });

  it('läuft über den Kreis hinweg, nicht an ihm entlang', () => {
    // 350° ist zehn Grad vor Rot (0°), nicht dreihundertfünfzig danach.
    const w = bandGewichte(350 / 360);
    expect(w[0]).toBeGreaterThan(0.3);
  });
});

describe('feinPunkt', () => {
  it('lässt eine Farbe in Ruhe, wenn nichts eingestellt ist', () => {
    const raus = feinPunkt([0.3, 0.6, 0.2], null, BAENDER_NEUTRAL);
    expect(raus[0]).toBeCloseTo(0.3, 6);
    expect(raus[1]).toBeCloseTo(0.6, 6);
    expect(raus[2]).toBeCloseTo(0.2, 6);
  });

  it('hebt mit der Gesamtkurve alle drei Kanäle', () => {
    const feld = kurvenFeld({
      gesamt: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ],
      rot: [],
      gruen: [],
      blau: [],
    });
    const raus = feinPunkt([0.5, 0.5, 0.5], feld, null);
    expect(raus[0]).toBeCloseTo(0.7, 3);
    expect(raus[1]).toBeCloseTo(0.7, 3);
    expect(raus[2]).toBeCloseTo(0.7, 3);
  });

  it('färbt mit einer Kanalkurve – und nur diesen Kanal', () => {
    const feld = kurvenFeld({
      gesamt: [],
      rot: [],
      gruen: [],
      blau: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ],
    });
    const raus = feinPunkt([0.5, 0.5, 0.5], feld, null);
    expect(raus[0]).toBeCloseTo(0.5, 3);
    expect(raus[1]).toBeCloseTo(0.5, 3);
    expect(raus[2]).toBeCloseTo(0.7, 3);
  });

  it('entsättigt nur das gemeinte Band', () => {
    // Rot ganz entsättigen, Grün unberührt lassen.
    const baender = bandMit(0, { saettigung: -1 });
    const rot = feinPunkt([0.8, 0.2, 0.2], null, baender);
    const gruen = feinPunkt([0.2, 0.8, 0.2], null, baender);

    const sRot = zuHsl(rot[0], rot[1], rot[2])[1];
    const sGruen = zuHsl(gruen[0], gruen[1], gruen[2])[1];
    /*
     * Fast auf null, nicht „deutlich weniger".
     *
     * Die Schwelle ist der ganze Zweck dieses Tests: Mit der vorigen
     * Gewichtung (feste Halbbreite, hinterher normiert) blieben bei reinem
     * Rot genau 0,2 stehen, weil Orange ein Drittel des Gewichts abbekam.
     * Eine Grenze bei 0,2 hätte das durchgewunken.
     */
    expect(sRot).toBeLessThan(0.02);
    expect(sGruen).toBeCloseTo(zuHsl(0.2, 0.8, 0.2)[1], 3);
  });

  it('dreht den Farbton des gemeinten Bandes', () => {
    const baender = bandMit(3, { farbton: 1 });
    const gruen = feinPunkt([0.2, 0.8, 0.2], null, baender);
    const vorher = zuHsl(0.2, 0.8, 0.2)[0];
    const nachher = zuHsl(gruen[0], gruen[1], gruen[2])[0];
    /*
     * Der volle Hub sind dreissig Grad, also ein Zwölftel einer Umdrehung.
     * Geprüft wird der Betrag und nicht die Richtung: Die Richtung ist eine
     * Festlegung, der Hub eine Zusage.
     */
    expect(Math.abs(nachher - vorher)).toBeGreaterThan(0.03);
    expect(Math.abs(nachher - vorher)).toBeLessThan(0.12);
  });

  it('lässt Grau grau – auch bei voll aufgedrehten Bändern', () => {
    /*
     * Ein fast graues Bildpunkt hat einen Farbton, aber keine Aussage. Ohne
     * die Dämpfung über die Sättigung bekäme das Rauschen einer grauen Wand
     * einen Farbton zugewiesen und würde mitgedreht – aus einem ruhigen Grau
     * würde buntes Flimmern.
     */
    const baender = BAENDER_NEUTRAL.map(() => ({
      farbton: 1,
      saettigung: 1,
      helligkeit: 0,
    }));
    for (const wert of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const raus = feinPunkt([wert, wert, wert], null, baender);
      expect(raus[0]).toBeCloseTo(wert, 4);
      expect(raus[1]).toBeCloseTo(wert, 4);
      expect(raus[2]).toBeCloseTo(wert, 4);
    }

    /*
     * Und der Fall, auf den es wirklich ankommt: FAST grau.
     *
     * Ein exaktes Grau hat Sättigung null und käme auch ohne jede Dämpfung
     * unverändert zurück – die Rückrechnung aus HSL macht daraus wieder
     * dasselbe Grau. Die Dämpfung beweist es also erst an einem Bildpunkt,
     * der einen Farbton HAT: das leichte Farbrauschen einer grauen Wand.
     */
    const fastGrau: [number, number, number] = [0.5, 0.49, 0.49];
    const gedaempft = feinPunkt(fastGrau, null, baender);
    for (let k = 0; k < 3; k += 1) expect(gedaempft[k]).toBeCloseTo(fastGrau[k], 3);

    // Zum Vergleich: Ein deutlich bunter Punkt wird sehr wohl angefasst.
    const bunt: [number, number, number] = [0.8, 0.3, 0.3];
    const geaendert = feinPunkt(bunt, null, baender);
    expect(Math.abs(geaendert[1] - bunt[1])).toBeGreaterThan(0.05);
  });

  it('hält jeden Kanal in 0 … 1', () => {
    const feld = kurvenFeld({
      gesamt: [
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ],
      rot: [],
      gruen: [],
      blau: [],
    });
    const baender = BAENDER_NEUTRAL.map(() => ({
      farbton: -1,
      saettigung: 1,
      helligkeit: 1,
    }));
    for (let i = 0; i <= 20; i += 1) {
      const raus = feinPunkt([i / 20, 1 - i / 20, 0.5], feld, baender);
      for (const k of raus) {
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(1);
      }
    }
  });

  it('erkennt neutrale Bänder', () => {
    expect(baenderNeutral(BAENDER_NEUTRAL)).toBe(true);
    expect(baenderNeutral(bandMit(2, { helligkeit: 0.01 }))).toBe(false);
  });
});
