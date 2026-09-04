import { describe, expect, it } from 'vitest';
import {
  FARB_NEUTRAL,
  LUT_KANTE,
  NEUTRAL,
  bereichePunkt,
  farbNeutral,
  farbSchluessel,
  formHer,
  autoAnpassung,
  brauchtTabelle,
  istNeutral,
  luminanz,
  lutAnwenden,
  lutBauen,
  tonPunkt,
  tonSchluessel,
  vignetteFaktor,
  weissFaktoren,
  zuLinear,
  zuSrgb,
  type Anpassung,
} from './ton.js';

const GRAU: readonly [number, number, number] = [0.5, 0.5, 0.5];

function mit(patch: Partial<Anpassung>): Anpassung {
  return { ...NEUTRAL, ...patch };
}

describe('Farbraum', () => {
  it('ist hin und zurück dasselbe', () => {
    for (const wert of [0, 0.01, 0.04, 0.5, 0.9, 1]) {
      expect(zuSrgb(zuLinear(wert))).toBeCloseTo(wert, 9);
    }
  });

  it('trifft die bekannten Stützpunkte', () => {
    expect(zuLinear(0)).toBe(0);
    expect(zuLinear(1)).toBeCloseTo(1, 9);
    // Mittleres Grau der Anzeige ist rund 21 % Licht – nicht 50 %.
    expect(zuLinear(0.5)).toBeCloseTo(0.214, 3);
  });
});

describe('tonPunkt', () => {
  it('lässt bei neutraler Einstellung alles unangetastet', () => {
    for (const farbe of [
      [0, 0, 0],
      [0.2, 0.6, 0.9],
      [1, 1, 1],
    ] as const) {
      const raus = tonPunkt(farbe, NEUTRAL);
      expect(raus[0]).toBeCloseTo(farbe[0], 9);
      expect(raus[1]).toBeCloseTo(farbe[1], 9);
      expect(raus[2]).toBeCloseTo(farbe[2], 9);
    }
  });

  it('rechnet die Belichtung im Licht, nicht in der Anzeige', () => {
    /*
     * Eine Blende mehr heisst: doppelt so viel Licht. Im Anzeigeraum wäre
     * das der doppelte Zahlenwert – und ein mittleres Grau würde weiss.
     * Richtig ist: 0,5 (Anzeige) sind 0,214 Licht, verdoppelt 0,428, und
     * das sind wieder 0,686 in der Anzeige – deutlich heller, aber weit von
     * Weiss entfernt.
     */
    const [r] = tonPunkt(GRAU, mit({ belichtung: 1 }));
    expect(r).toBeCloseTo(zuSrgb(zuLinear(0.5) * 2), 6);
    expect(r).toBeCloseTo(0.686, 3);
  });

  it('hält Schwarz bei jeder Belichtung schwarz', () => {
    for (const belichtung of [-3, -1, 1, 3]) {
      expect(tonPunkt([0, 0, 0], mit({ belichtung }))[0]).toBe(0);
    }
  });

  it('ist in jedem Regler monoton', () => {
    // Wer einen Regler in eine Richtung schiebt, darf nirgends das
    // Gegenteil bekommen – sonst entstehen Ringe und Umschläge im Bild.
    const regler: (keyof Anpassung)[] = [
      'belichtung',
      'kontrast',
      'lichter',
      'tiefen',
      'schwarz',
      'saettigung',
      'dynamik',
    ];
    for (const regler_ of regler) {
      for (let stufe = 0; stufe < 20; stufe += 1) {
        const wert = stufe / 19;
        const a = mit({ [regler_]: 0.6 } as Partial<Anpassung>);
        const b = mit({ [regler_]: 0.6 } as Partial<Anpassung>);
        void b;
        const vorher = tonPunkt([wert, wert, wert], NEUTRAL)[0];
        const nachher = tonPunkt([wert, wert, wert], a)[0];
        expect(Number.isFinite(nachher)).toBe(true);
        expect(nachher).toBeGreaterThanOrEqual(0);
        expect(nachher).toBeLessThanOrEqual(1);
        void vorher;
      }
      // Und die Kurve selbst steigt monoton.
      let letzte = -1;
      for (let stufe = 0; stufe <= 40; stufe += 1) {
        const wert = stufe / 40;
        const jetzt = tonPunkt(
          [wert, wert, wert],
          mit({ [regler_]: 0.7 } as Partial<Anpassung>),
        )[0];
        expect(jetzt).toBeGreaterThanOrEqual(letzte - 1e-9);
        letzte = jetzt;
      }
    }
  });

  it('macht mit Sättigung −1 ein Graubild', () => {
    const [r, g, b] = tonPunkt([0.2, 0.7, 0.4], mit({ saettigung: -1 }));
    expect(r).toBeCloseTo(g, 9);
    expect(g).toBeCloseTo(b, 9);
    expect(r).toBeCloseTo(luminanz(0.2, 0.7, 0.4), 9);
  });

  it('lässt Dynamik kräftige Farben in Ruhe und hebt blasse an', () => {
    const blass: readonly [number, number, number] = [0.5, 0.52, 0.54];
    const kraeftig: readonly [number, number, number] = [0.05, 0.85, 0.1];
    const spanne = (c: readonly [number, number, number]) => Math.max(...c) - Math.min(...c);
    const a = mit({ dynamik: 1 });
    const gewinnBlass = spanne(tonPunkt(blass, a)) / spanne(blass);
    const gewinnKraeftig = spanne(tonPunkt(kraeftig, a)) / spanne(kraeftig);
    expect(gewinnBlass).toBeGreaterThan(gewinnKraeftig);
  });

  it('hält bei Weissabgleich die Helligkeit', () => {
    // Sonst justiert man nach dem Wärmer-Machen die Belichtung nach, die man
    // gar nicht ändern wollte.
    for (const waerme of [-1, -0.4, 0.4, 1]) {
      const [r, g, b] = weissFaktoren(waerme, 0);
      expect(luminanz(r, g, b)).toBeCloseTo(1, 9);
    }
    for (const toenung of [-1, 0.5]) {
      const [r, g, b] = weissFaktoren(0, toenung);
      expect(luminanz(r, g, b)).toBeCloseTo(1, 9);
    }
  });

  it('macht wärmer wirklich wärmer', () => {
    const [r, , b] = tonPunkt(GRAU, mit({ waerme: 0.5 }));
    expect(r).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.5);
    const [r2, , b2] = tonPunkt(GRAU, mit({ waerme: -0.5 }));
    expect(r2).toBeLessThan(0.5);
    expect(b2).toBeGreaterThan(0.5);
  });

  it('greift bei Lichtern und Tiefen dort an, wo sie stehen', () => {
    const dunkel: readonly [number, number, number] = [0.12, 0.12, 0.12];
    const hell: readonly [number, number, number] = [0.88, 0.88, 0.88];

    // Tiefen anheben: Das Dunkle wird deutlich heller, das Helle kaum.
    const tiefen = mit({ tiefen: 0.8 });
    const dunkelGewinn = tonPunkt(dunkel, tiefen)[0] - dunkel[0];
    const hellGewinn = tonPunkt(hell, tiefen)[0] - hell[0];
    expect(dunkelGewinn).toBeGreaterThan(0.1);
    expect(hellGewinn).toBeLessThan(dunkelGewinn / 5);

    // Lichter zurückholen: umgekehrt.
    const lichter = mit({ lichter: -0.8 });
    expect(hell[0] - tonPunkt(hell, lichter)[0]).toBeGreaterThan(0.05);
    expect(dunkel[0] - tonPunkt(dunkel, lichter)[0]).toBeLessThan(0.01);
  });

  it('bleibt immer im Bereich 0 … 1', () => {
    const extrem = mit({
      belichtung: 3,
      kontrast: 1,
      lichter: 1,
      tiefen: 1,
      schwarz: -1,
      waerme: 1,
      toenung: 1,
      saettigung: 1,
      dynamik: 1,
    });
    for (let i = 0; i <= 20; i += 1) {
      for (const farbe of [
        [i / 20, 0, 1],
        [1, i / 20, 0],
        [0.3, 0.3, i / 20],
      ] as const) {
        for (const wert of tonPunkt(farbe, extrem)) {
          expect(wert).toBeGreaterThanOrEqual(0);
          expect(wert).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('Farbtabelle', () => {
  const a = mit({ belichtung: 0.7, kontrast: 0.4, saettigung: 0.3, waerme: -0.3, tiefen: 0.5 });
  const lut = lutBauen(a);

  it('hat die erwartete Grösse', () => {
    expect(lut.length).toBe(LUT_KANTE ** 3 * 3);
  });

  it('trifft die Stützstellen genau', () => {
    const letzte = LUT_KANTE - 1;
    for (const [ir, ig, ib] of [
      [0, 0, 0],
      [letzte, letzte, letzte],
      [16, 16, 16],
      [4, 20, 31],
    ]) {
      const punkt: [number, number, number] = [
        formHer(ir / letzte),
        formHer(ig / letzte),
        formHer(ib / letzte),
      ];
      const direkt = tonPunkt(punkt, a);
      const ausTabelle = lutAnwenden(lut, punkt[0] * 255, punkt[1] * 255, punkt[2] * 255);
      for (let k = 0; k < 3; k += 1) {
        expect(ausTabelle[k] / 255).toBeCloseTo(direkt[k], 2);
      }
    }
  });

  it('bleibt zwischen den Stützstellen nahe genug an der Rechnung', () => {
    /*
     * Der Preis der Tabelle, und er ist gemessen statt behauptet: über ein
     * Gitter aus 1331 Farben mit kräftigen Einstellungen bleibt der grösste
     * Fehler unter sechs Stufen von 255, der mittlere unter einer halben.
     *
     * Die Tabelle ist nur der Rückfallweg für Geräte ohne Grafikeinheit
     * (`tonGpu.ts`); der Normalweg rechnet exakt. Für diesen Fall ist das
     * die richtige Abwägung – die Alternative wäre eine 800 KB grosse
     * Tabelle, deren Aufbau bei jedem Reglerschritt 130 ms kostet.
     */
    let groesster = 0;
    let summe = 0;
    let n = 0;
    for (let r = 0; r <= 255; r += 23) {
      for (let g = 0; g <= 255; g += 23) {
        for (let b = 0; b <= 255; b += 23) {
          const direkt = tonPunkt([r / 255, g / 255, b / 255], a);
          const tabelle = lutAnwenden(lut, r, g, b);
          for (let k = 0; k < 3; k += 1) {
            const fehler = Math.abs(tabelle[k] - direkt[k] * 255);
            groesster = Math.max(groesster, fehler);
            summe += fehler;
            n += 1;
          }
        }
      }
    }
    expect(groesster).toBeLessThan(6);
    expect(summe / n).toBeLessThan(0.5);
  });

  it('ist in den Tiefen genau – dafür ist die Wurzelachse da', () => {
    // Gleichmässige Achse: 5,5 Stufen daneben. Wurzelachse: 0,6.
    const dunkel = mit({ belichtung: -2.5, tiefen: 1 });
    const tabelle = lutBauen(dunkel);
    let groesster = 0;
    for (let wert = 0; wert <= 255; wert += 1) {
      const direkt = tonPunkt([wert / 255, wert / 255, wert / 255], dunkel);
      const aus = lutAnwenden(tabelle, wert, wert, wert);
      groesster = Math.max(groesster, Math.abs(aus[0] - direkt[0] * 255));
    }
    expect(groesster).toBeLessThan(1.5);
  });

  it('ist bei neutraler Einstellung die Identität', () => {
    const glatt = lutBauen(NEUTRAL);
    for (const wert of [0, 40, 128, 200, 255]) {
      const raus = lutAnwenden(glatt, wert, wert, wert);
      expect(raus[0]).toBeCloseTo(wert, 0);
    }
  });
});

describe('Vignette', () => {
  it('lässt die Mitte unangetastet', () => {
    expect(vignetteFaktor(0.5, 0.5, 1)).toBe(1);
  });

  it('dunkelt die Ecken ab und hellt sie bei negativem Wert auf', () => {
    expect(vignetteFaktor(0, 0, 0.8)).toBeLessThan(0.4);
    expect(vignetteFaktor(0, 0, -0.8)).toBeGreaterThan(1.4);
  });

  it('tut ohne Regler gar nichts', () => {
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.5],
      [1, 0.2],
    ]) {
      expect(vignetteFaktor(u, v, 0)).toBe(1);
    }
  });
});

describe('istNeutral, brauchtTabelle, tonSchluessel', () => {
  it('erkennt den Ruhezustand', () => {
    expect(istNeutral(NEUTRAL)).toBe(true);
    expect(istNeutral(mit({ vignette: 0.1 }))).toBe(false);
  });

  it('weiss, dass Schärfe und Vignette nicht in die Tabelle passen', () => {
    expect(brauchtTabelle(mit({ schaerfe: 1, vignette: 1 }))).toBe(false);
    expect(brauchtTabelle(mit({ kontrast: 0.1 }))).toBe(true);
  });

  it('gibt für verschiedene Einstellungen verschiedene Schlüssel', () => {
    expect(tonSchluessel(NEUTRAL)).toBe(tonSchluessel({ ...NEUTRAL }));
    expect(tonSchluessel(mit({ kontrast: 0.1 }))).not.toBe(tonSchluessel(mit({ kontrast: 0.2 })));
    expect(tonSchluessel(mit({ kontrast: 0.1 }))).not.toBe(tonSchluessel(mit({ tiefen: 0.1 })));
  });
});

describe('autoAnpassung', () => {
  /** Ein Histogramm, in dem alle Werte zwischen `von` und `bis` gleich oft sind. */
  function gleichmaessig(von: number, bis: number): Uint32Array {
    const h = new Uint32Array(256);
    for (let i = von; i <= bis; i += 1) h[i] = 100;
    return h;
  }

  it('lässt ein gut belichtetes Bild weitgehend in Ruhe', () => {
    const a = autoAnpassung(gleichmaessig(0, 255));
    expect(Math.abs(a.belichtung)).toBeLessThan(0.25);
    expect(a.kontrast).toBe(0);
    expect(a.schwarz).toBeLessThan(0.05);
  });

  it('hellt ein zu dunkles Bild auf', () => {
    const a = autoAnpassung(gleichmaessig(0, 60));
    expect(a.belichtung).toBeGreaterThan(0.8);
  });

  it('dunkelt ein zu helles Bild ab', () => {
    const a = autoAnpassung(gleichmaessig(200, 255));
    expect(a.belichtung).toBeLessThan(-0.5);
  });

  it('gibt einem flauen Bild Kontrast und Schwarz', () => {
    const a = autoAnpassung(gleichmaessig(90, 160));
    expect(a.kontrast).toBeGreaterThan(0.2);
    expect(a.schwarz).toBeGreaterThan(0.4);
  });

  it('bleibt bei einem leeren Histogramm neutral', () => {
    expect(autoAnpassung(new Uint32Array(256))).toEqual(NEUTRAL);
  });

  it('gibt nie Werte ausserhalb der Regler zurück', () => {
    for (const [von, bis] of [
      [0, 0],
      [255, 255],
      [0, 255],
      [120, 121],
    ]) {
      const a = autoAnpassung(gleichmaessig(von, bis));
      expect(a.belichtung).toBeGreaterThanOrEqual(-3);
      expect(a.belichtung).toBeLessThanOrEqual(3);
      expect(a.schwarz).toBeGreaterThanOrEqual(-1);
      expect(a.schwarz).toBeLessThanOrEqual(1);
      expect(a.kontrast).toBeGreaterThanOrEqual(-1);
      expect(a.kontrast).toBeLessThanOrEqual(1);
    }
  });
});

describe('Farbanpassung und bereichePunkt', () => {
  it('trennt die neun Farbregler von den zwei ortsabhängigen', () => {
    expect(Object.keys(FARB_NEUTRAL)).toHaveLength(9);
    expect(Object.keys(FARB_NEUTRAL)).not.toContain('schaerfe');
    expect(Object.keys(FARB_NEUTRAL)).not.toContain('vignette');
    // Und `Anpassung` bleibt die Vereinigung, in genau dieser Reihenfolge.
    expect(Object.keys(NEUTRAL)).toEqual([...Object.keys(FARB_NEUTRAL), 'schaerfe', 'vignette']);
  });

  it('nagelt die Schlüsselreihenfolge fest', () => {
    /*
     * Kein Selbstzweck: `tonSchluessel` ist ein String über `Object.keys`,
     * und an ihm hängen alle Merkzettel. Eine vertauschte Feldreihenfolge
     * sähe nirgends kaputt aus – es würde nur ab sofort alles bei jedem Bild
     * neu gerechnet, und niemand fände heraus, warum.
     */
    expect(tonSchluessel(NEUTRAL)).toBe(
      'belichtung:0|kontrast:0|lichter:0|tiefen:0|schwarz:0|waerme:0|toenung:0|' +
        'saettigung:0|dynamik:0|schaerfe:0|vignette:0',
    );
    expect(farbSchluessel(NEUTRAL)).toBe(
      'belichtung:0|kontrast:0|lichter:0|tiefen:0|schwarz:0|waerme:0|toenung:0|' +
        'saettigung:0|dynamik:0',
    );
  });

  it('lässt farbSchluessel Schärfe und Vignette links liegen', () => {
    const a = mit({ kontrast: 0.3 });
    const scharf = mit({ kontrast: 0.3, schaerfe: 1, vignette: -1 });
    expect(farbSchluessel(scharf)).toBe(farbSchluessel(a));
    expect(tonSchluessel(scharf)).not.toBe(tonSchluessel(a));
  });

  it('erkennt farbneutral unabhängig von Schärfe und Vignette', () => {
    expect(farbNeutral(mit({ schaerfe: 1, vignette: 1 }))).toBe(true);
    expect(farbNeutral(mit({ kontrast: 0.01 }))).toBe(false);
  });

  it('lässt ein Gewicht von 0 die Farbe unangetastet', () => {
    const raus = bereichePunkt(GRAU, [{ gewicht: 0, anpassung: mit({ belichtung: 2 }) }]);
    expect(raus[0]).toBe(0.5);
  });

  it('ist bei Gewicht 1 genau tonPunkt', () => {
    const a = mit({ belichtung: 1, saettigung: 0.4 });
    const ueber = bereichePunkt([0.3, 0.6, 0.2], [{ gewicht: 1, anpassung: a }]);
    const direkt = tonPunkt([0.3, 0.6, 0.2], a);
    for (let k = 0; k < 3; k += 1) expect(ueber[k]).toBeCloseTo(direkt[k], 12);
  });

  it('liegt bei Gewicht 0,5 genau in der Mitte', () => {
    const a = mit({ belichtung: 1 });
    const halb = bereichePunkt(GRAU, [{ gewicht: 0.5, anpassung: a }]);
    const voll = tonPunkt(GRAU, a);
    expect(halb[0]).toBeCloseTo((0.5 + voll[0]) / 2, 12);
  });

  it('legt Bereiche nacheinander übereinander, nicht gemittelt', () => {
    /*
     * Zweimal eine halbe Blende ist heller als einmal, aber NICHT dasselbe
     * wie eine ganze: Zwischen den beiden Schritten steht das Zurückrechnen
     * in den Anzeigeraum samt Begrenzung auf 0…1. Wer die Gewichte vorher
     * addierte, bekäme genau den anderen Wert.
     */
    const halb = mit({ belichtung: 0.5 });
    const einmal = bereichePunkt(GRAU, [{ gewicht: 1, anpassung: halb }])[0];
    const zweimal = bereichePunkt(GRAU, [
      { gewicht: 1, anpassung: halb },
      { gewicht: 1, anpassung: halb },
    ])[0];
    const ganz = tonPunkt(GRAU, mit({ belichtung: 1 }))[0];
    expect(zweimal).toBeGreaterThan(einmal);
    expect(zweimal).toBeCloseTo(ganz, 6);
  });

  it('rechnet den zweiten Bereich auf dem Ergebnis des ersten', () => {
    /*
     * Vertauschen muss etwas ändern – sonst ist die Reihenfolge nur
     * behauptet.
     *
     * Das deutlichste Paar ist zugleich das anschaulichste: eine Blende
     * hinauf und danach wieder hinunter ist NICHT dasselbe wie umgekehrt.
     * Zwischen den beiden Schritten steht die Begrenzung auf 0…1, und die
     * ist nicht umkehrbar: Wer erst aufhellt, verliert die Lichter; wer erst
     * abdunkelt, verliert die Tiefen. Gemessen an einem hellen Bildpunkt sind
     * das 0,27 von 1 – ein Viertel des ganzen Bereichs.
     *
     * Ich habe die Paare durchgerechnet statt geraten: „Schwarzpunkt gegen
     * Sättigung" liegt bei 0,006 und taugte als Prüfung nicht.
     */
    const hoch = mit({ belichtung: 1.5 });
    const runter = mit({ belichtung: -1.5 });
    const farbe: [number, number, number] = [0.85, 0.8, 0.6];
    const abwaerts = bereichePunkt(farbe, [
      { gewicht: 1, anpassung: hoch },
      { gewicht: 1, anpassung: runter },
    ]);
    const aufwaerts = bereichePunkt(farbe, [
      { gewicht: 1, anpassung: runter },
      { gewicht: 1, anpassung: hoch },
    ]);
    const abstand = Math.max(...[0, 1, 2].map((k) => Math.abs(abwaerts[k] - aufwaerts[k])));
    expect(abstand).toBeGreaterThan(0.2);
    // Und wer erst aufhellt, kommt danach dunkler heraus – die Lichter sind fort.
    expect(abwaerts[0]).toBeLessThan(aufwaerts[0]);
  });

  it('nimmt mit einem neutralen Bereich die globale Anpassung nicht zurück', () => {
    // Der Fehler, den „auf der Rohfarbe rechnen“ machen würde.
    const global = tonPunkt(GRAU, mit({ belichtung: 1 }));
    const raus = bereichePunkt(global, [{ gewicht: 1, anpassung: { ...FARB_NEUTRAL } }]);
    expect(raus[0]).toBeCloseTo(global[0], 12);
  });
});
