import { describe, expect, it } from 'vitest';
import {
  NEIGUNG_MAX,
  drehenUm,
  groessterRahmen,
  neigungImOriginal,
  neigungKlemmen,
  rahmenEcken,
  rahmenEinpassen,
  rahmenPasst,
} from './neigen.js';
import type { Zuschnitt } from './doc.js';

const BILD = { breite: 400, hoehe: 300 };
const VOLL: Zuschnitt = { x: 0, y: 0, w: 400, h: 300 };

describe('neigungKlemmen', () => {
  it('lässt erlaubte Winkel unverändert', () => {
    expect(neigungKlemmen(0)).toBe(0);
    expect(neigungKlemmen(7.5)).toBe(7.5);
    expect(neigungKlemmen(-7.5)).toBe(-7.5);
  });

  it('klemmt nach beiden Seiten', () => {
    expect(neigungKlemmen(90)).toBe(NEIGUNG_MAX);
    expect(neigungKlemmen(-90)).toBe(-NEIGUNG_MAX);
  });

  it('macht aus NaN und Infinity eine 0 statt sie durchzureichen', () => {
    // Ein NaN im Winkel vergiftet jede spätere Rechnung lautlos: Der
    // Zuschnitt wird NaN, das Bild verschwindet, und nichts sagt warum.
    expect(neigungKlemmen(Number.NaN)).toBe(0);
    expect(neigungKlemmen(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('neigungImOriginal', () => {
  it('lässt den Winkel ungespiegelt in Ruhe', () => {
    expect(neigungImOriginal(5, false)).toBe(5);
  });

  it('kehrt ihn bei gespiegeltem Bild um', () => {
    // Sonst läuft der Regler bei gespiegelten Bildern rückwärts.
    expect(neigungImOriginal(5, true)).toBe(-5);
  });
});

describe('drehenUm', () => {
  it('dreht im Uhrzeigersinn – x nach rechts wird y nach unten', () => {
    // Bildschirmkoordinaten: y zeigt nach unten. Ein Punkt rechts der Mitte
    // muss bei +90° unter die Mitte wandern, nicht darüber.
    const gedreht = drehenUm({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(gedreht.x).toBeCloseTo(0, 10);
    expect(gedreht.y).toBeCloseTo(10, 10);
  });

  it('dreht um das angegebene Zentrum, nicht um den Ursprung', () => {
    const gedreht = drehenUm({ x: 110, y: 100 }, { x: 100, y: 100 }, 90);
    expect(gedreht.x).toBeCloseTo(100, 10);
    expect(gedreht.y).toBeCloseTo(110, 10);
  });

  it('lässt bei 0° den Punkt in Ruhe', () => {
    expect(drehenUm({ x: 3, y: 7 }, { x: 1, y: 1 }, 0)).toEqual({ x: 3, y: 7 });
  });
});

describe('rahmenEcken', () => {
  it('dreht ZURÜCK, nicht vor', () => {
    // Das Bild dreht +θ, also liegt der Rahmen aus Sicht des ungedrehten
    // Bildes bei −θ. Ein mittiger, quadratischer Rahmen wäre gegen beide
    // Vorzeichen unempfindlich – deshalb hier bewusst ein Rahmen, der weder
    // mittig noch quadratisch ist.
    const rahmen: Zuschnitt = { x: 100, y: 40, w: 120, h: 60 };
    const ecken = rahmenEcken(rahmen, 30);
    const obenLinks = ecken[0];
    const vorwaerts = drehenUm({ x: 100, y: 40 }, { x: 160, y: 70 }, 30);
    expect(obenLinks.x).not.toBeCloseTo(vorwaerts.x, 3);
  });

  it('liefert bei 0° genau die vier Ecken', () => {
    const ecken = rahmenEcken({ x: 10, y: 20, w: 30, h: 40 }, 0);
    expect(ecken).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
  });

  it('behält den Abstand zur Mitte bei – eine Drehung staucht nicht', () => {
    const rahmen: Zuschnitt = { x: 100, y: 40, w: 120, h: 60 };
    const mitte = { x: 160, y: 70 };
    for (const ecke of rahmenEcken(rahmen, 12)) {
      const abstand = Math.hypot(ecke.x - mitte.x, ecke.y - mitte.y);
      expect(abstand).toBeCloseTo(Math.hypot(60, 30), 8);
    }
  });
});

describe('rahmenPasst', () => {
  it('sagt bei 0° ja zum vollen Bild', () => {
    expect(rahmenPasst(VOLL, BILD.breite, BILD.hoehe, 0)).toBe(true);
  });

  it('sagt bei geneigtem Bild nein zum vollen Rahmen', () => {
    // Das ist der ganze Grund für dieses Modul: Der volle Rahmen kann nicht
    // bleiben, sobald geneigt wird – die Ecken laufen aus dem Bild.
    expect(rahmenPasst(VOLL, BILD.breite, BILD.hoehe, 5)).toBe(false);
  });

  it('erkennt eine einzelne herausragende Ecke', () => {
    // Ein Rahmen am linken Rand: Bei Neigung schwenkt genau eine Ecke
    // hinaus. Ein Test, der nur die Mitte prüfte, wäre hier grün.
    const amRand: Zuschnitt = { x: 0, y: 100, w: 100, h: 100 };
    expect(rahmenPasst(amRand, BILD.breite, BILD.hoehe, 0)).toBe(true);
    expect(rahmenPasst(amRand, BILD.breite, BILD.hoehe, 10)).toBe(false);
  });

  it('lässt einen kleinen mittigen Rahmen auch stark geneigt durch', () => {
    const klein: Zuschnitt = { x: 180, y: 130, w: 40, h: 40 };
    expect(rahmenPasst(klein, BILD.breite, BILD.hoehe, NEIGUNG_MAX)).toBe(true);
  });
});

describe('groessterRahmen', () => {
  it('ist bei 0° das ganze Bild', () => {
    const r = groessterRahmen(400, 300, 0, 4 / 3);
    expect(r.w).toBeCloseTo(400, 6);
    expect(r.h).toBeCloseTo(300, 6);
  });

  it('schrumpft mit wachsendem Winkel', () => {
    const a = groessterRahmen(400, 300, 5, 4 / 3);
    const b = groessterRahmen(400, 300, 10, 4 / 3);
    expect(b.w).toBeLessThan(a.w);
    expect(a.w).toBeLessThan(400);
  });

  it('ist gegen das Vorzeichen des Winkels unempfindlich', () => {
    const links = groessterRahmen(400, 300, -8, 4 / 3);
    const rechts = groessterRahmen(400, 300, 8, 4 / 3);
    expect(links.w).toBeCloseTo(rechts.w, 10);
  });

  it('hält das verlangte Seitenverhältnis ein', () => {
    const r = groessterRahmen(400, 300, 9, 1);
    expect(r.w / r.h).toBeCloseTo(1, 10);
    const hoch = groessterRahmen(400, 300, 9, 9 / 16);
    expect(hoch.w / hoch.h).toBeCloseTo(9 / 16, 10);
  });

  it('liefert wirklich das GRÖSSTE – ein Prozent mehr passt nicht mehr', () => {
    // Ohne diesen Test wäre jede zu kleine Formel grün: Ein Rahmen, der
    // sicherheitshalber halb so gross ist, passt schliesslich auch.
    for (const seiten of [4 / 3, 1, 9 / 16, 16 / 9]) {
      for (const grad of [3, 7, 12, NEIGUNG_MAX]) {
        const r = groessterRahmen(400, 300, grad, seiten);
        const mittig = (w: number, h: number): Zuschnitt => ({
          x: 200 - w / 2,
          y: 150 - h / 2,
          w,
          h,
        });
        expect(rahmenPasst(mittig(r.w, r.h), 400, 300, grad, 1e-6)).toBe(true);
        expect(rahmenPasst(mittig(r.w * 1.01, r.h * 1.01), 400, 300, grad, 1e-6)).toBe(false);
      }
    }
  });

  it('gibt bei unsinnigen Eingaben null zurück statt NaN', () => {
    expect(groessterRahmen(400, 300, 5, 0)).toEqual({ w: 0, h: 0 });
    expect(groessterRahmen(0, 300, 5, 1)).toEqual({ w: 0, h: 0 });
  });
});

describe('rahmenEinpassen', () => {
  it('lässt einen passenden Rahmen unverändert', () => {
    const klein: Zuschnitt = { x: 180, y: 130, w: 40, h: 40 };
    expect(rahmenEinpassen(klein, BILD.breite, BILD.hoehe, 5)).toEqual(klein);
  });

  it('macht einen herausragenden Rahmen passend', () => {
    const ergebnis = rahmenEinpassen(VOLL, BILD.breite, BILD.hoehe, 8);
    expect(rahmenPasst(ergebnis, BILD.breite, BILD.hoehe, 8)).toBe(true);
  });

  it('behält das Seitenverhältnis', () => {
    // Ein Einpassen, das aus 4:3 ein 5:3 macht, wäre kein Geraderichten
    // mehr, sondern ein heimlicher Zuschnitt.
    const ergebnis = rahmenEinpassen(VOLL, BILD.breite, BILD.hoehe, 11);
    expect(ergebnis.w / ergebnis.h).toBeCloseTo(400 / 300, 8);
  });

  it('behält die Mitte', () => {
    const versetzt: Zuschnitt = { x: 40, y: 30, w: 320, h: 240 };
    const ergebnis = rahmenEinpassen(versetzt, BILD.breite, BILD.hoehe, 10);
    expect(ergebnis.x + ergebnis.w / 2).toBeCloseTo(200, 6);
    expect(ergebnis.y + ergebnis.h / 2).toBeCloseTo(150, 6);
  });

  it('schrumpft nur so weit wie nötig', () => {
    // Der eigentliche Anspruch. Ein Einpassen, das immer auf die Hälfte
    // geht, bestünde jeden anderen Test in dieser Datei.
    const ergebnis = rahmenEinpassen(VOLL, BILD.breite, BILD.hoehe, 6);
    const groesser: Zuschnitt = {
      x: 200 - (ergebnis.w * 1.02) / 2,
      y: 150 - (ergebnis.h * 1.02) / 2,
      w: ergebnis.w * 1.02,
      h: ergebnis.h * 1.02,
    };
    expect(rahmenPasst(groesser, BILD.breite, BILD.hoehe, 6, 1e-6)).toBe(false);
  });

  it('holt eine Mitte weit ausserhalb zurück, OHNE den Rahmen zu verkleinern', () => {
    // Der Fall, an dem die naheliegende Reihenfolge scheitert: Wer die Mitte
    // zuerst klemmt, landet auf der Bildecke (400|300) – und um eine Ecke
    // herum passt nur ein Rahmen der Kantenlänge null. Das Bild verschwände.
    // Ein 100×100-Rahmen passt bei 7° aber problemlos irgendwo hinein, also
    // darf er seine Grösse behalten.
    const daneben: Zuschnitt = { x: 500, y: 400, w: 100, h: 100 };
    const ergebnis = rahmenEinpassen(daneben, BILD.breite, BILD.hoehe, 7);
    expect(ergebnis.w).toBeCloseTo(100, 6);
    expect(ergebnis.h).toBeCloseTo(100, 6);
    expect(rahmenPasst(ergebnis, BILD.breite, BILD.hoehe, 7)).toBe(true);
  });

  it('verschiebt so wenig wie möglich – die Mitte bleibt am Rand kleben', () => {
    // Sonst wäre „hineinholen" auch mit einem Sprung in die Bildmitte
    // erfüllt, und der Ausschnitt liefe beim Reglerziehen davon.
    const daneben: Zuschnitt = { x: 500, y: 100, w: 100, h: 100 };
    const ergebnis = rahmenEinpassen(daneben, BILD.breite, BILD.hoehe, 7);
    const rand = (100 * Math.cos((7 * Math.PI) / 180) + 100 * Math.sin((7 * Math.PI) / 180)) / 2;
    expect(ergebnis.x + ergebnis.w / 2).toBeCloseTo(BILD.breite - rand, 6);
    // In y war die Mitte (150) schon zulässig und darf sich nicht rühren.
    expect(ergebnis.y + ergebnis.h / 2).toBeCloseTo(150, 6);
  });

  it('passt für jeden Winkel und jeden Ausgangsrahmen', () => {
    const faelle: Zuschnitt[] = [
      VOLL,
      { x: 0, y: 0, w: 400, h: 100 },
      { x: 0, y: 0, w: 100, h: 300 },
      { x: 350, y: 250, w: 60, h: 60 },
      { x: -20, y: -20, w: 200, h: 200 },
    ];
    for (const fall of faelle) {
      for (const grad of [-NEIGUNG_MAX, -9, -1, 1, 9, NEIGUNG_MAX]) {
        const ergebnis = rahmenEinpassen(fall, BILD.breite, BILD.hoehe, grad);
        expect(Number.isFinite(ergebnis.x)).toBe(true);
        expect(Number.isFinite(ergebnis.w)).toBe(true);
        expect(ergebnis.w).toBeGreaterThanOrEqual(0);
        expect(rahmenPasst(ergebnis, BILD.breite, BILD.hoehe, grad)).toBe(true);
      }
    }
  });

  it('ist bei 0° die Identität', () => {
    expect(rahmenEinpassen(VOLL, BILD.breite, BILD.hoehe, 0)).toEqual(VOLL);
  });
});
