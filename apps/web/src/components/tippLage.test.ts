import { describe, expect, it } from 'vitest';
import { tippLage } from './tippLage.js';

const FENSTER = { breite: 390, hoehe: 844 };
const TIPP = { breite: 200, hoehe: 44 };

describe('tippLage', () => {
  it('setzt die Blase über das Element und mittig darüber', () => {
    const lage = tippLage({ links: 100, oben: 400, breite: 40, hoehe: 40 }, TIPP, FENSTER);
    expect(lage.darunter).toBe(false);
    // Mitte des Elements: 120. Mitte der Blase soll dort liegen.
    expect(lage.links + TIPP.breite / 2).toBeCloseTo(120, 6);
    // Über dem Element, mit Luft dazwischen.
    expect(lage.oben + TIPP.hoehe).toBeLessThan(400);
  });

  it('klappt nach unten, wenn oben kein Platz ist', () => {
    // Ein Knopf in der obersten Leiste – genau die Sorte, die nur ein Symbol
    // trägt und deshalb am ehesten eine Erklärung braucht.
    const lage = tippLage({ links: 100, oben: 12, breite: 40, hoehe: 40 }, TIPP, FENSTER);
    expect(lage.darunter).toBe(true);
    expect(lage.oben).toBeGreaterThan(12 + 40);
  });

  it('hält die Blase am rechten Rand im Bild', () => {
    // Ohne das Klemmen ragte die rechte Hälfte hinaus und wäre unlesbar.
    const lage = tippLage({ links: 340, oben: 400, breite: 40, hoehe: 40 }, TIPP, FENSTER);
    expect(lage.links + TIPP.breite).toBeLessThanOrEqual(FENSTER.breite);
    expect(lage.links).toBeGreaterThanOrEqual(0);
  });

  it('hält die Blase am linken Rand im Bild', () => {
    const lage = tippLage({ links: 4, oben: 400, breite: 40, hoehe: 40 }, TIPP, FENSTER);
    expect(lage.links).toBeGreaterThanOrEqual(0);
  });

  it('verdeckt das Element nicht', () => {
    // Der Sinn der Blase ist, etwas über den Knopf zu sagen. Liegt sie darauf,
    // sieht man nicht mehr, wovon die Rede ist.
    for (const oben of [12, 100, 400, 800]) {
      const ziel = { links: 100, oben, breite: 40, hoehe: 40 };
      const lage = tippLage(ziel, TIPP, FENSTER);
      const blaseUnten = lage.oben + TIPP.hoehe;
      const zielUnten = ziel.oben + ziel.hoehe;
      const ueberlappt = lage.oben < zielUnten && blaseUnten > ziel.oben;
      expect(ueberlappt).toBe(false);
    }
  });

  it('bleibt auch bei einem Element am unteren Rand im Bild', () => {
    const lage = tippLage({ links: 100, oben: 820, breite: 40, hoehe: 40 }, TIPP, FENSTER);
    expect(lage.oben).toBeGreaterThanOrEqual(0);
    expect(lage.oben + TIPP.hoehe).toBeLessThanOrEqual(FENSTER.hoehe);
  });

  it('zentriert eine Blase, die breiter ist als der Bildschirm, statt sie anzuheften', () => {
    // Sonst gewönne Math.max, die Blase klebte links und der Überhang läge
    // rechts im Nichts.
    const breit = { breite: 500, hoehe: 44 };
    const lage = tippLage({ links: 100, oben: 400, breite: 40, hoehe: 40 }, breit, FENSTER);
    const mitteBlase = lage.links + breit.breite / 2;
    expect(mitteBlase).toBeCloseTo(FENSTER.breite / 2, 6);
  });
});
