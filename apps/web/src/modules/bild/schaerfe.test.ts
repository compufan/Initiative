import { describe, expect, it } from 'vitest';

import { schaerfeAn, schaerfenFeld, schwellenAnteil } from './schaerfe.js';
import { zuLinear, zuSrgb } from './ton.js';

describe('schwellenAnteil', () => {
  it('lässt ohne Schwelle alles durch', () => {
    expect(schwellenAnteil(0, 0)).toBe(1);
    expect(schwellenAnteil(0.001, 0)).toBe(1);
  });

  it('sperrt alles unterhalb der Schwelle', () => {
    expect(schwellenAnteil(0.01, 0.05)).toBe(0);
    expect(schwellenAnteil(0.05, 0.05)).toBe(0);
  });

  it('geht weich über, nicht als Sprung', () => {
    /*
     * Der eigentliche Punkt. Eine harte Schwelle erzeugt genau dort, wo sie
     * liegt, eine sichtbare Grenze: In einem Verlauf sieht man eine Linie, an
     * der die Schärfe einsetzt. Geprüft wird deshalb nicht „0 oder 1",
     * sondern dass es dazwischen ansteigt.
     */
    const a = schwellenAnteil(0.06, 0.05);
    const b = schwellenAnteil(0.08, 0.05);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(b).toBeGreaterThan(a);
  });

  it('lässt weit über der Schwelle wieder alles durch', () => {
    expect(schwellenAnteil(0.5, 0.05)).toBe(1);
  });
});

describe('schaerfeAn', () => {
  it('lässt eine glatte Fläche in Ruhe', () => {
    // Mitte gleich Mittel: Es gibt keine Kante, also nichts zu betonen.
    expect(schaerfeAn(0.4, 0.4, 0.4, 0.4, 1, 0)).toBeCloseTo(0.4, 9);
  });

  it('zieht eine Kante auseinander', () => {
    const hell = schaerfeAn(0.6, 0.5, 0.4, 0.8, 1, 0);
    const dunkel = schaerfeAn(0.4, 0.5, 0.2, 0.6, 1, 0);
    expect(hell).toBeGreaterThan(0.6);
    expect(dunkel).toBeLessThan(0.4);
  });

  it('schiesst nicht über die Nachbarschaft hinaus – der Saum', () => {
    /*
     * Die wichtigste Eigenschaft und der Grund, warum das hier überhaupt eine
     * eigene Funktion ist. Ohne die Begrenzung wird eine verstärkte Kante
     * heller als alles, was daneben steht – das ist der weisse Saum über
     * jeder dunklen Kante.
     */
    const roh = 0.6 + (0.6 - 0.3) * 5;
    expect(roh).toBeGreaterThan(0.7);
    expect(schaerfeAn(0.6, 0.3, 0.2, 0.7, 5, 0)).toBe(0.7);
    expect(schaerfeAn(0.3, 0.6, 0.2, 0.7, 5, 0)).toBe(0.2);
  });

  it('lässt Rauschen unter der Schwelle unangetastet', () => {
    // Ein Unterschied von einem Hundertstel bei einer Schwelle von fünf.
    expect(schaerfeAn(0.51, 0.5, 0.49, 0.52, 1, 0.05)).toBe(0.51);
  });
});

describe('schaerfenFeld', () => {
  /** Eine Kante: links dunkel, rechts hell. */
  function kante(breite: number, hoehe: number, weich = 0): Uint8ClampedArray {
    const d = new Uint8ClampedArray(breite * hoehe * 4);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const mitte = breite / 2;
        const t =
          weich > 0
            ? Math.min(1, Math.max(0, (x - mitte + weich) / (2 * weich)))
            : x < mitte
              ? 0
              : 1;
        const wert = Math.round(60 + t * 140);
        const at = (y * breite + x) * 4;
        d[at] = wert;
        d[at + 1] = wert;
        d[at + 2] = wert;
        d[at + 3] = 255;
      }
    }
    return d;
  }

  it('macht eine weiche Kante steiler', () => {
    const quelle = kante(40, 8, 4);
    const daten = new Uint8ClampedArray(quelle);
    schaerfenFeld(daten, 40, 8, 1, 3, 0, null, quelle);
    // Am Fuss der Kante wird es dunkler, am Kopf heller: Das ist die
    // Steigung, um die es geht.
    const at = (x: number) => (4 * 40 + x) * 4;
    expect(daten[at(17)]).toBeLessThanOrEqual(quelle[at(17)]);
    expect(daten[at(23)]).toBeGreaterThanOrEqual(quelle[at(23)]);
  });

  it('lässt Alpha in Ruhe', () => {
    const quelle = kante(16, 16, 2);
    const daten = new Uint8ClampedArray(quelle);
    schaerfenFeld(daten, 16, 16, 1, 2, 0, null, quelle);
    for (let i = 3; i < daten.length; i += 4) expect(daten[i]).toBe(255);
  });

  it('tut bei Stärke null gar nichts', () => {
    const quelle = kante(16, 16, 2);
    const daten = new Uint8ClampedArray(quelle);
    schaerfenFeld(daten, 16, 16, 0, 3, 0, null, quelle);
    expect(Array.from(daten)).toEqual(Array.from(quelle));
  });

  it('lässt aus, wo das Bokeh schon unscharf gezeichnet hat', () => {
    /*
     * Sonst holte die Schärfe genau die Hochfrequenz aus dem SCHARFEN
     * Quellbild zurück, die die Tiefenschärfe gerade entfernt hat – der
     * Hintergrund wäre unscharf und kantig zugleich.
     */
    const quelle = kante(16, 16, 2);
    const daten = new Uint8ClampedArray(quelle);
    const voll = new Uint8Array(16 * 16).fill(255);
    schaerfenFeld(daten, 16, 16, 1, 3, 0, voll, quelle);
    expect(Array.from(daten)).toEqual(Array.from(quelle));
  });

  it('erzeugt keinen Saum über die Nachbarschaft hinaus', () => {
    /*
     * Der Vergleich zur alten Fassung: Die klemmte hart auf 0 … 1 und liess
     * dazwischen alles zu – bei Stärke 1 stand über einer dunklen Kante ein
     * heller Streifen, der im Bild nirgends vorkam.
     */
    const breite = 40;
    const quelle = kante(breite, 8, 3);
    const daten = new Uint8ClampedArray(quelle);
    schaerfenFeld(daten, breite, 8, 1, 3, 0, null, quelle);
    let hoechst = 0;
    let tiefst = 255;
    for (let i = 0; i < quelle.length; i += 4) {
      hoechst = Math.max(hoechst, quelle[i]);
      tiefst = Math.min(tiefst, quelle[i]);
    }
    for (let i = 0; i < daten.length; i += 4) {
      // Eine Stufe Luft für das Runden auf ganze Bytes.
      expect(daten[i]).toBeLessThanOrEqual(hoechst + 1);
      expect(daten[i]).toBeGreaterThanOrEqual(tiefst - 1);
    }
  });

  it('rechnet in linearem Licht – halbes Licht gibt das halbe Ergebnis', () => {
    /*
     * Wie prüft man „lineares Licht"?
     *
     * Nicht an der Symmetrie des Saums – die ist auch in linearem Licht
     * unsymmetrisch, weil die Saumbegrenzung an den Enden einer Kante
     * verschieden weit greift. Die Eigenschaft, um die es wirklich geht, ist
     * eine andere: Licht ist proportional. Halbiert man die LICHTMENGE im
     * ganzen Bild, muss auch das Ergebnis der Schärfung halbe Lichtmenge
     * haben.
     *
     * In Anzeigewerten gerechnet gilt das nicht, denn die sind nicht
     * proportional zum Licht – dieselbe Kante bekommt dort in einem dunklen
     * Bild einen ganz anderen Saum als in einem hellen. Genau deshalb sah die
     * alte Fassung über dunklen Kanten anders aus als über hellen.
     */
    const breite = 48;
    const hoehe = 4;
    const bauen = (faktor: number) => {
      const d = new Uint8ClampedArray(breite * hoehe * 4);
      for (let y = 0; y < hoehe; y += 1) {
        for (let x = 0; x < breite; x += 1) {
          // Eine weiche Kante, in LINEAREM Licht angesetzt und dann erst in
          // Anzeigewerte gebracht.
          const t = Math.min(1, Math.max(0, (x - 20) / 8));
          const licht = (0.12 + t * 0.5) * faktor;
          const wert = Math.round(zuSrgb(licht) * 255);
          const at = (y * breite + x) * 4;
          d[at] = wert;
          d[at + 1] = wert;
          d[at + 2] = wert;
          d[at + 3] = 255;
        }
      }
      return d;
    };

    const ganz = bauen(1);
    const halb = bauen(0.5);
    const ganzRaus = new Uint8ClampedArray(ganz);
    const halbRaus = new Uint8ClampedArray(halb);
    schaerfenFeld(ganzRaus, breite, hoehe, 0.8, 3, 0, null, ganz);
    schaerfenFeld(halbRaus, breite, hoehe, 0.8, 3, 0, null, halb);

    const zeile = 2 * breite;
    let groessterFehler = 0;
    let etwasPassiert = 0;
    for (let x = 2; x < breite - 2; x += 1) {
      const a = zuLinear(ganzRaus[(zeile + x) * 4] / 255);
      const b = zuLinear(halbRaus[(zeile + x) * 4] / 255);
      etwasPassiert = Math.max(etwasPassiert, Math.abs(a - zuLinear(ganz[(zeile + x) * 4] / 255)));
      // Der Fehler im Verhältnis zum Wert – acht Bit sind in den dunklen
      // Stufen grob, ein absoluter Vergleich wäre dort unfair.
      groessterFehler = Math.max(groessterFehler, Math.abs(b - a / 2) / Math.max(0.01, a / 2));
    }
    // Erst der Beweis, dass überhaupt geschärft wurde – sonst wäre die
    // Gleichheit darunter die Gleichheit zweier unveränderter Bilder.
    expect(etwasPassiert).toBeGreaterThan(0.005);
    expect(groessterFehler, 'die Schärfung ist nicht proportional zum Licht').toBeLessThan(0.06);
  });

  it('hat einen Radius, der etwas tut', () => {
    // Der ganze Grund für den neuen Regler: Bei einer Kante, die über zwölf
    // Punkte weich ist, kann ein Radius von einem Punkt nichts ausrichten.
    const breite = 60;
    const quelle = kante(breite, 8, 12);
    const eng = new Uint8ClampedArray(quelle);
    const weit = new Uint8ClampedArray(quelle);
    schaerfenFeld(eng, breite, 8, 1, 1, 0, null, quelle);
    schaerfenFeld(weit, breite, 8, 1, 8, 0, null, quelle);
    const spanne = (feld: Uint8ClampedArray) => {
      const zeile = 4 * breite;
      let min = 255;
      let max = 0;
      for (let x = 20; x < 40; x += 1) {
        min = Math.min(min, feld[(zeile + x) * 4]);
        max = Math.max(max, feld[(zeile + x) * 4]);
      }
      return max - min;
    };
    expect(spanne(weit)).toBeGreaterThan(spanne(eng));
  });

  it('lässt Rauschen in einer glatten Fläche in Ruhe, wenn eine Schwelle steht', () => {
    const breite = 32;
    const hoehe = 32;
    const quelle = new Uint8ClampedArray(breite * hoehe * 4);
    let z = 12345;
    for (let i = 0; i < breite * hoehe; i += 1) {
      z = (z * 1103515245 + 12345) & 0x7fffffff;
      // Mittelgrau mit ±2 Stufen Korn – und sonst nichts.
      const wert = 128 + ((z >>> 16) % 5) - 2;
      quelle[i * 4] = wert;
      quelle[i * 4 + 1] = wert;
      quelle[i * 4 + 2] = wert;
      quelle[i * 4 + 3] = 255;
    }
    const ohne = new Uint8ClampedArray(quelle);
    const mit = new Uint8ClampedArray(quelle);
    schaerfenFeld(ohne, breite, hoehe, 1, 3, 0, null, quelle);
    schaerfenFeld(mit, breite, hoehe, 1, 3, 0.08, null, quelle);
    const korn = (feld: Uint8ClampedArray) => {
      let summe = 0;
      for (let i = 0; i < feld.length; i += 4) summe += Math.abs(feld[i] - 128);
      return summe;
    };
    expect(korn(ohne)).toBeGreaterThan(korn(quelle));
    expect(korn(mit)).toBeLessThanOrEqual(korn(quelle) + 1);
  });
});
