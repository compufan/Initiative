import { describe, expect, it } from 'vitest';
import {
  ansichtAlsZuschnitt,
  ansichtGroesse,
  aufVerhaeltnis,
  ausgabeGroesse,
  nachAnsicht,
  nachOriginal,
  neuesDoc,
  weiterdrehen,
  zuschnittHalten,
  zuschnittInAnsicht,
  type BildDoc,
  type Drehung,
} from './doc.js';

const W = 400;
const H = 300;

function doc(drehung: Drehung, spiegel = false): BildDoc {
  return { ...neuesDoc(W, H), drehung, spiegel };
}

describe('Drehen und Spiegeln', () => {
  it('tauscht die Kanten nur beim Hochkantdrehen', () => {
    expect(ansichtGroesse(W, H, 0)).toEqual({ w: 400, h: 300 });
    expect(ansichtGroesse(W, H, 90)).toEqual({ w: 300, h: 400 });
    expect(ansichtGroesse(W, H, 180)).toEqual({ w: 400, h: 300 });
    expect(ansichtGroesse(W, H, 270)).toEqual({ w: 300, h: 400 });
  });

  it('schiebt die linke obere Ecke im Uhrzeigersinn herum', () => {
    const ecke = { x: 0, y: 0 };
    expect(nachAnsicht(ecke, W, H, doc(0))).toEqual({ x: 0, y: 0 });
    // 90 Grad im Uhrzeigersinn: oben links landet oben rechts, und die neue
    // Breite ist die alte Hoehe.
    expect(nachAnsicht(ecke, W, H, doc(90))).toEqual({ x: 300, y: 0 });
    expect(nachAnsicht(ecke, W, H, doc(180))).toEqual({ x: 400, y: 300 });
    expect(nachAnsicht(ecke, W, H, doc(270))).toEqual({ x: 0, y: 400 });
  });

  it('findet für jeden Punkt wieder zurück', () => {
    const punkte = [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 137, y: 42 },
    ];
    for (const drehung of [0, 90, 180, 270] as Drehung[]) {
      for (const spiegel of [false, true]) {
        for (const p of punkte) {
          const hin = nachAnsicht(p, W, H, doc(drehung, spiegel));
          const zurueck = nachOriginal(hin, W, H, doc(drehung, spiegel));
          expect(zurueck.x).toBeCloseTo(p.x, 6);
          expect(zurueck.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });

  it('spiegelt waagerecht, nicht senkrecht', () => {
    expect(nachAnsicht({ x: 0, y: 50 }, W, H, doc(0, true))).toEqual({ x: 400, y: 50 });
  });

  it('dreht in beide Richtungen und bleibt im Bereich', () => {
    expect(weiterdrehen(0, 1)).toBe(90);
    expect(weiterdrehen(270, 1)).toBe(0);
    expect(weiterdrehen(0, -1)).toBe(270);
    expect(weiterdrehen(90, -3)).toBe(180);
  });
});

describe('Zuschnitt', () => {
  it('bleibt im Bild, auch wenn man ihn hinausschiebt', () => {
    expect(zuschnittHalten({ x: -50, y: -50, w: 100, h: 100 }, W, H)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(zuschnittHalten({ x: 9999, y: 9999, w: 100, h: 100 }, W, H)).toEqual({
      x: 300,
      y: 200,
      w: 100,
      h: 100,
    });
  });

  it('wird nicht kleiner beim Verschieben, sondern nur zurückgeschoben', () => {
    // Ein zu breites Rechteck wird auf Bildbreite gestutzt und liegt dann bei 0 –
    // nicht bei 0 mit halber Breite.
    const gehalten = zuschnittHalten({ x: 200, y: 0, w: 9999, h: 100 }, W, H);
    expect(gehalten).toEqual({ x: 0, y: 0, w: 400, h: 100 });
  });

  it('dreht mit dem Bild mit', () => {
    // Ein Streifen am linken Rand liegt nach 90 Grad oben.
    const streifen = { x: 0, y: 0, w: 40, h: 300 };
    const inAnsicht = zuschnittInAnsicht(streifen, W, H, doc(90));
    expect(inAnsicht).toEqual({ x: 0, y: 0, w: 300, h: 40 });
  });

  it('nimmt ein in der Ansicht gezogenes Rechteck entgegen', () => {
    const gezogen = { x: 0, y: 0, w: 300, h: 40 };
    const amOriginal = ansichtAlsZuschnitt(gezogen, W, H, doc(90));
    expect(amOriginal).toEqual({ x: 0, y: 0, w: 40, h: 300 });
  });

  it('verkleinert auf ein festes Verhältnis, statt zu wachsen', () => {
    const quadrat = aufVerhaeltnis({ x: 0, y: 0, w: 400, h: 300 }, 1, W, H);
    expect(quadrat.w).toBe(300);
    expect(quadrat.h).toBe(300);
    // Der Mittelpunkt bleibt, wo er war.
    expect(quadrat.x + quadrat.w / 2).toBeCloseTo(200, 6);
  });

  it('bekommt auch ein breites Verhältnis in ein schmales Bild', () => {
    const breit = aufVerhaeltnis({ x: 0, y: 0, w: 300, h: 400 }, 16 / 9, 300, 400);
    expect(breit.w).toBeLessThanOrEqual(300);
    expect(breit.h).toBeLessThanOrEqual(400);
    expect(breit.w / breit.h).toBeCloseTo(16 / 9, 6);
  });
});

describe('Ausgabegrösse', () => {
  it('lässt kleine Bilder in Ruhe', () => {
    expect(ausgabeGroesse({ x: 0, y: 0, w: 400, h: 300 }, 0)).toEqual({
      w: 400,
      h: 300,
      faktor: 1,
    });
  });

  it('begrenzt die längste Kante und behält das Verhältnis', () => {
    const gross = ausgabeGroesse({ x: 0, y: 0, w: 8000, h: 4000 }, 0, 2560);
    expect(gross.w).toBe(2560);
    expect(gross.h).toBe(1280);
  });

  it('rechnet die Drehung mit ein, nicht nur den Ausschnitt', () => {
    const hochkant = ausgabeGroesse({ x: 0, y: 0, w: 400, h: 300 }, 90);
    expect(hochkant).toEqual({ w: 300, h: 400, faktor: 1 });
  });
});
