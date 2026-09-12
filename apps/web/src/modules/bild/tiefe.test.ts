import { describe, expect, it } from 'vitest';

import {
  anteilZuTiefe,
  netzGroesse,
  tiefeNormalisieren,
  tiefenFeld,
  tiefenVerteilung,
  unschaerfeAn,
  type Tiefenkarte,
} from './tiefe.js';

describe('tiefeNormalisieren', () => {
  it('zieht den Wertebereich auf 0 bis 255', () => {
    const roh = new Float32Array([0.5, 1.0, 1.5, 2.0]);
    const karte = tiefeNormalisieren(roh, 2, 2);
    expect(karte.breite).toBe(2);
    expect(karte.hoehe).toBe(2);
    expect(karte.feld[0]).toBe(0);
    expect(karte.feld[3]).toBe(255);
    // Dazwischen linear.
    expect(karte.feld[1]).toBeGreaterThan(60);
    expect(karte.feld[1]).toBeLessThan(110);
  });

  it('lässt sich von einem einzelnen Ausreisser nicht die Skala verderben', () => {
    /*
     * 400 Werte von 1,00 bis 1,04 und ein einziger bei 50 – eine Spiegelung.
     * Über Kleinst- und Grösstwert normalisiert läge das ganze Bild danach
     * unter 1 von 255 und wäre als Tiefenkarte wertlos. Über das
     * 99.-Perzentil bleibt es gespreizt.
     */
    const roh = new Float32Array(401);
    for (let i = 0; i < 400; i += 1) roh[i] = 1 + (i / 399) * 0.04;
    roh[400] = 50;
    const karte = tiefeNormalisieren(roh, 401, 1);
    expect(karte.feld[399]).toBeGreaterThan(200);
    expect(karte.feld[0]).toBeLessThan(40);
    // Der Ausreisser selbst steht am Anschlag – das ist der Preis.
    expect(karte.feld[400]).toBe(255);
  });

  it('macht aus einem flachen Bild eine flache Karte statt Rauschen', () => {
    const roh = new Float32Array(16).fill(1.25);
    const karte = tiefeNormalisieren(roh, 4, 4);
    for (const wert of karte.feld) expect(wert).toBe(128);
  });

  it('überlebt NaN in der Rohausgabe', () => {
    const roh = new Float32Array([Number.NaN, 1, 2, 3]);
    const karte = tiefeNormalisieren(roh, 2, 2);
    expect(karte.feld[0]).toBe(0);
    expect(karte.feld[3]).toBe(255);
  });

  it('liefert ein leeres Feld, wenn die Rohausgabe zu kurz ist', () => {
    const karte = tiefeNormalisieren(new Float32Array(3), 2, 2);
    expect(karte.feld.length).toBe(4);
    expect(Array.from(karte.feld)).toEqual([0, 0, 0, 0]);
  });
});

describe('unschaerfeAn', () => {
  it('ist auf der Fokusebene null', () => {
    expect(unschaerfeAn(0.5, 0.5, 0.25)).toBe(0);
  });

  it('wächst nach beiden Seiten gleich – wie eine echte Linse', () => {
    expect(unschaerfeAn(0.6, 0.5, 0.4)).toBeCloseTo(0.25, 6);
    expect(unschaerfeAn(0.4, 0.5, 0.4)).toBeCloseTo(0.25, 6);
  });

  it('wächst linear, nicht in einer Kurve', () => {
    // Der Zerstreuungskreis ist proportional zum Unterschied der Kehrwerte
    // der Entfernung – und genau die gibt das Netz aus.
    const a = unschaerfeAn(0.6, 0.5, 1);
    const b = unschaerfeAn(0.7, 0.5, 1);
    const c = unschaerfeAn(0.8, 0.5, 1);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it('klemmt bei eins', () => {
    expect(unschaerfeAn(1, 0, 0.25)).toBe(1);
  });

  it('macht aus Spanne null eine harte Kante statt Unendlich', () => {
    expect(unschaerfeAn(0.6, 0.5, 0)).toBe(1);
    expect(unschaerfeAn(0.5, 0.5, 0)).toBe(0);
  });

  it('lässt sich von einer negativen Spanne nicht umdrehen', () => {
    /*
     * Der Fall, gegen den der Mindestwert wirklich schützt. Ohne ihn kippt
     * bei negativer Spanne das Vorzeichen: Jeder Abstand wird negativ,
     * klemmt auf 0, und das ganze Bild bleibt scharf – ein kaputter Wert im
     * Dokument sähe aus wie ein Regler, der nichts tut.
     */
    expect(unschaerfeAn(0.9, 0.5, -0.5)).toBe(1);
  });
});

describe('tiefenFeld', () => {
  it('dehnt aus und rechnet dann erst die Unschärfe', () => {
    /*
     * Zwei Punkte beiderseits der Fokusebene: 0 und 255, Fokus in der Mitte.
     * Beide sind voll unscharf. Ausgedehnt liegt dazwischen die Tiefe 128 –
     * also die Fokusebene, also SCHARF.
     *
     * Wer erst die Kurve rechnet und dann ausdehnt, mittelt 1 und 1 zu 1 und
     * bekommt einen durchgehend unscharfen Streifen, wo der scharfe Bereich
     * sein müsste. Genau diese Reihenfolge prüft der Test.
     */
    /*
     * Die Karte trägt jetzt auch die Mitte.
     *
     * Der Fokusregler läuft über die VERTEILUNG der Tiefen im Bild (siehe
     * `anteilZuTiefe`). Bei einer Karte aus nur zwei Werten gibt es keine
     * Mitte, auf die er zeigen könnte – die Hälfte des Bildes liegt vorn, die
     * andere hinten, und der Median ist einer der beiden. Mit einem dritten
     * Punkt bei 128 ist die Mitte vorhanden, und der Test prüft wieder das,
     * wofür er da ist: die Reihenfolge von Ausdehnen und Kurve.
     */
    const karte = { breite: 3, hoehe: 1, feld: new Uint8Array([0, 128, 255]) };
    const feld = tiefenFeld(karte, 0.5, 0.5, 9, 1);
    expect(feld[0]).toBeGreaterThan(200);
    expect(feld[8]).toBeGreaterThan(200);
    expect(feld[4]).toBeLessThan(40);
  });

  it('behält die Lage: links bleibt links', () => {
    const karte = { breite: 2, hoehe: 1, feld: new Uint8Array([0, 255]) };
    // Fokus ganz vorne: dann ist „fern“ (0) unscharf und „nah“ (255) scharf.
    const feld = tiefenFeld(karte, 1, 1, 8, 1);
    expect(feld[0]).toBeGreaterThan(feld[7]);
  });

  it('verträgt eine leere Zielgrösse', () => {
    const karte = { breite: 2, hoehe: 2, feld: new Uint8Array(4) };
    expect(tiefenFeld(karte, 0.5, 0.5, 0, 0).length).toBe(0);
  });
});

describe('netzGroesse', () => {
  it('macht beide Kanten durch 14 teilbar', () => {
    for (const [b, h] of [
      [4000, 3000],
      [1920, 1440],
      [1080, 1920],
      [800, 800],
      [3000, 1000],
    ]) {
      const { w, h: hh } = netzGroesse(b, h);
      expect(w % 14).toBe(0);
      expect(hh % 14).toBe(0);
    }
  });

  it('behält das Seitenverhältnis annähernd bei', () => {
    /*
     * Eng gefasst, und das mit Absicht: Die kurze Kante wird auf ein
     * Vielfaches von 14 GERUNDET, nicht abgeschnitten. 4000 × 3000 gibt
     * 388,5 – gerundet 392 (Verhältnis 1,321), abgeschnitten 378 (1,370).
     * Bei einer lockeren Schranke von 0,05 gingen beide durch, und das
     * Abschneiden verzerrte jedes Bild sichtbar in die Länge.
     */
    const { w, h } = netzGroesse(4000, 3000);
    expect(w).toBe(518);
    expect(h).toBe(392);
    expect(Math.abs(w / h - 4 / 3)).toBeLessThan(0.02);
  });

  it('dreht sich mit dem Hochformat', () => {
    const { w, h } = netzGroesse(3000, 4000);
    expect(h).toBe(518);
    expect(w).toBeLessThan(h);
  });

  it('fällt nie unter einen Flicken', () => {
    const { w, h } = netzGroesse(10000, 1);
    expect(w).toBeGreaterThanOrEqual(14);
    expect(h).toBeGreaterThanOrEqual(14);
  });

  it('verträgt Unsinn als Größe', () => {
    const { w, h } = netzGroesse(0, 0);
    expect(w).toBe(518);
    expect(h).toBe(518);
  });
});

describe('Die Staffelung: der Regler folgt dem Bild, nicht der Kehrwertskala', () => {
  /**
   * Die gemeldete Szene: Tisch im Vordergrund, Person am Tisch, Himmel dahinter.
   *
   * Gebaut aus echten Entfernungen über den Kehrwert – so, wie das Netz sie
   * ausgibt. Die Flächenanteile sind grob realistisch: Der Tisch füllt das
   * untere Drittel, die Person steht mittig, der Himmel nimmt den Rest.
   */
  function tischSzene(): Tiefenkarte {
    const breite = 60;
    const hoehe = 60;
    const roh = new Float32Array(breite * hoehe);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        let meter: number;
        if (y > 40)
          meter = 0.4 + ((y - 40) / 20) * 0.4; // Tisch, 0,4 … 0,8 m
        else if (y > 18 && x > 20 && x < 40)
          meter = 3; // Person
        else meter = 1000; // Himmel
        roh[y * breite + x] = 1 / meter;
      }
    }
    return tiefeNormalisieren(roh, breite, hoehe);
  }

  it('quetscht Person und Himmel in der ROHEN Karte dicht zusammen', () => {
    const karte = tischSzene();
    const person = karte.feld[30 * 60 + 30];
    const himmel = karte.feld[5 * 60 + 5];
    const tischVorn = karte.feld[59 * 60 + 30];
    /*
     * Der gemeldete Befund, in Zahlen: Der Tisch nimmt den Löwenanteil der
     * Skala (137 von 255 für vierzig Zentimeter), Person und Himmel teilen
     * sich den Rest (36). Zwischen der Person und dem Unendlichen liegen
     * damit weniger Stufen als zwischen Tischkante und Tischmitte.
     */
    expect(tischVorn - person).toBeGreaterThan(90);
    expect(person - himmel).toBeLessThan(50);
  });

  /*
   * Und das ist die Abhilfe: Über die Verteilung bekommt jede Raste denselben
   * ANTEIL DES BILDES. Person und Himmel rücken dadurch auf der Reglerskala
   * weit auseinander, obwohl sich an der Karte nichts geändert hat.
   */
  it('legt Person und Himmel auf dem Regler weit auseinander', () => {
    const karte = tischSzene();
    const verteilung = tiefenVerteilung(karte.feld);

    /** Bei welcher Raste liegt dieser Tiefenwert? */
    const rasteVon = (wert: number) => {
      let beste = 0;
      for (let r = 0; r <= 100; r += 1) {
        if (anteilZuTiefe(verteilung, r / 100) * 255 <= wert) beste = r;
      }
      return beste;
    };

    const person = rasteVon(karte.feld[30 * 60 + 30]);
    const himmel = rasteVon(karte.feld[5 * 60 + 5]);
    // Vorher lagen zwischen beiden dreizehn Rasten von hundert.
    expect(person - himmel).toBeGreaterThan(25);
  });

  it('lässt bei Fokus auf der Person den Himmel unscharf und den Tisch auch', () => {
    const karte = tischSzene();
    const verteilung = tiefenVerteilung(karte.feld);

    // Die Raste, die auf der Person sitzt: Der Himmel füllt rund die Hälfte
    // des Bildes, die Person liegt gleich darüber.
    let fokusRaste = 0;
    for (let r = 0; r <= 100; r += 1) {
      const t = anteilZuTiefe(verteilung, r / 100) * 255;
      if (
        Math.abs(t - karte.feld[30 * 60 + 30]) <
        Math.abs(anteilZuTiefe(verteilung, fokusRaste / 100) * 255 - karte.feld[30 * 60 + 30])
      ) {
        fokusRaste = r;
      }
    }

    const feld = tiefenFeld(karte, fokusRaste / 100, 0.2, 60, 60);
    const person = feld[30 * 60 + 30];
    const himmel = feld[5 * 60 + 5];
    const tisch = feld[59 * 60 + 30];

    expect(person).toBeLessThan(40);
    expect(himmel).toBeGreaterThan(150);
    expect(tisch).toBeGreaterThan(150);
  });

  it('gibt bei einem flachen Bild eine brauchbare Verteilung zurück', () => {
    const feld = new Uint8Array(100).fill(128);
    const verteilung = tiefenVerteilung(feld);
    expect(verteilung[255]).toBeCloseTo(1, 5);
    // Jeder Anteil landet auf demselben Wert – es gibt ja nur einen.
    expect(anteilZuTiefe(verteilung, 0.5) * 255).toBe(128);
    expect(anteilZuTiefe(verteilung, 0) * 255).toBe(128);
    expect(anteilZuTiefe(verteilung, 1) * 255).toBe(128);
  });

  it('verschluckt sich nicht an einem leeren Feld', () => {
    const verteilung = tiefenVerteilung(new Uint8Array(0));
    expect(anteilZuTiefe(verteilung, 0.5)).toBeGreaterThanOrEqual(0);
  });
});
