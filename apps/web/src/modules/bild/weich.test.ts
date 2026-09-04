import { describe, expect, it } from 'vitest';
import { bokehRadius, kastenWeichRgba } from './weich.js';

/**
 * Ein festgelegter Pseudozufall aus einer kleinen Ganzzahl-Streuung.
 *
 * Bewusst kein `Math.random`: Ein Fehlschlag muss beim zweiten Lauf derselbe
 * sein, sonst ist er nicht zu finden – und in manchen Umgebungen hier steht
 * `Math.random` gar nicht bereit.
 */
function streuwert(x: number, y: number, k: number): number {
  const h = (x * 73856093) ^ (y * 19349663) ^ ((k + 1) * 83492791);
  return (h >>> 0) % 256;
}

function feldBauen(breite: number, hoehe: number): Uint8ClampedArray {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      for (let k = 0; k < 4; k += 1) daten[at + k] = streuwert(x, y, k);
    }
  }
  return daten;
}

/**
 * Die geradeheraus gerechnete Fassung: für jeden Bildpunkt das ganze Fenster
 * neu zusammenzählen, Rand auf den Randpunkt geklemmt. O(r) je Bildpunkt und
 * damit als Vorschau unbrauchbar – aber offensichtlich richtig, und genau
 * darum steht sie hier als Massstab.
 */
function langsamWeich(
  daten: Uint8ClampedArray,
  breite: number,
  hoehe: number,
  r: number,
): Float64Array {
  const klemme = (wert: number, max: number) => (wert < 0 ? 0 : wert > max ? max : wert);
  const zwischen = new Float64Array(breite * hoehe * 4);
  const raus = new Float64Array(breite * hoehe * 4);
  const n = 2 * r + 1;
  for (let k = 0; k < 3; k += 1) {
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        let summe = 0;
        for (let d = -r; d <= r; d += 1) {
          summe += daten[(y * breite + klemme(x + d, breite - 1)) * 4 + k];
        }
        zwischen[(y * breite + x) * 4 + k] = summe / n;
      }
    }
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        let summe = 0;
        for (let d = -r; d <= r; d += 1) {
          summe += zwischen[(klemme(y + d, hoehe - 1) * breite + x) * 4 + k];
        }
        raus[(y * breite + x) * 4 + k] = summe / n;
      }
    }
  }
  return raus;
}

describe('kastenWeichRgba', () => {
  it('trifft die geradeheraus gerechnete Fassung auf eine Stufe von 255 genau', () => {
    // Mutation: beim Weiterschieben den austretenden Wert nicht abziehen –
    // die Summe wächst dann über die Zeile hinweg an und die Abweichung geht
    // in die Hunderte statt unter eine Stufe.
    const breite = 17;
    const hoehe = 13;
    const radius = 4;
    const gemessen = feldBauen(breite, hoehe);
    const massstab = langsamWeich(gemessen, breite, hoehe, radius);
    kastenWeichRgba(gemessen, breite, hoehe, radius);
    for (let i = 0; i < gemessen.length; i += 1) {
      if (i % 4 === 3) continue;
      expect(Math.abs(gemessen[i] - massstab[i])).toBeLessThanOrEqual(0.5);
    }
  });

  it('lässt bei Radius 0 und darunter kein einziges Byte anders zurück', () => {
    // Mutation: die Abkürzung für `radius <= 0` weglassen. Bei Radius 0 fiele
    // das nicht auf – das Fenster hat dann genau eine Stützstelle und die
    // Rechnung ist die Eins –, bei Radius −2 aber wird der Teiler negativ und
    // das ganze Feld kippt ins Schwarze. Darum stehen beide Werte hier.
    const original = feldBauen(9, 7);
    for (const radius of [0, -2]) {
      const gemessen = new Uint8ClampedArray(original);
      kastenWeichRgba(gemessen, 9, 7, radius);
      expect(Array.from(gemessen)).toEqual(Array.from(original));
    }
  });

  it('rührt ein gleichmässiges Feld auch am Rand nicht an', () => {
    // Der Radius ist hier grösser als das halbe Bild: Wer am Rand nicht auf
    // den Randpunkt klemmt, sondern die fehlenden Stützstellen als 0 zählt,
    // bekommt einen dunklen Saum – genau das prüfen die Ecken.
    // Mutation: `Math.max(0, ...)` beim austretenden Wert durch den
    // ungeklemmten Index ersetzen.
    const breite = 6;
    const hoehe = 4;
    const daten = new Uint8ClampedArray(breite * hoehe * 4);
    for (let i = 0; i < daten.length; i += 4) {
      daten[i] = 200;
      daten[i + 1] = 200;
      daten[i + 2] = 200;
      daten[i + 3] = 255;
    }
    kastenWeichRgba(daten, breite, hoehe, 5);
    for (let i = 0; i < daten.length; i += 1) {
      if (i % 4 === 3) continue;
      expect(daten[i]).toBe(200);
    }
  });

  it('lässt den Alphakanal in Ruhe', () => {
    // Mutation: die Kanalschleife bis 4 statt bis 3 laufen lassen – dann
    // verschmierte das Bokeh die Maskenkante, unter der es liegt.
    const breite = 11;
    const hoehe = 5;
    const original = feldBauen(breite, hoehe);
    const gemessen = new Uint8ClampedArray(original);
    kastenWeichRgba(gemessen, breite, hoehe, 3);
    for (let i = 3; i < gemessen.length; i += 4) {
      expect(gemessen[i]).toBe(original[i]);
    }
  });
});

describe('bokehRadius', () => {
  it('wächst mit der Bildkante mit', () => {
    // Mutation: den Radius in Bildpunkten festlegen statt als Anteil der
    // Kante – dann wäre das Verhältnis 1, die Ausgabe also nur halb so weich
    // wie die Vorschau, die man eingestellt hat.
    const gross = bokehRadius(0.5, 2560);
    const klein = bokehRadius(0.5, 1200);
    expect(klein).toBe(12);
    expect(gross).toBe(26);
  });

  it('gibt nie einen negativen Radius zurück', () => {
    // Mutation: das `Math.max(0, ...)` weglassen – ein negativer Radius wäre
    // zwar ein Nichtstun, aber `new Float32Array` bekäme vorher eine
    // sinnlose Länge, sobald jemand die Abkürzung umstellt.
    expect(bokehRadius(0, 2560)).toBe(0);
    expect(bokehRadius(-1, 2560)).toBe(0);
  });
});

/*
 * Nachgereicht aus einer Gegenprüfung, die die behaupteten Mutationen wirklich
 * ausgeführt hat: Zwei davon überlebten die ganze Reihe.
 */
describe('nachgereicht', () => {
  it('kommt mit einem Radius zurecht, der breiter ist als das Bild', () => {
    /*
     * Die Klemme im waagerechten Vorlauf war von keiner Prüfung berührt: Alle
     * hatten einen Radius, der im Vorlauf den rechten Rand nie erreichte.
     *
     * Erreichbar ist der Fall aber ohne Weiteres – `bokehRadius(1, 1200)` ist
     * 24, und jeder Ausschnitt, der schmaler als 24 Punkte ist, fällt hinein.
     * Ohne die Klemme greift der Vorlauf in die nächste Zeile und auf der
     * letzten hinter den Puffer: `undefined` wird zu NaN und landet als 0 –
     * aus dem Bild wird stumm ein schwarzer Streifen.
     */
    const w = 4;
    const h = 3;
    const daten = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const at = (y * w + x) * 4;
        daten[at] = y === 0 ? 0 : 255;
        daten[at + 1] = daten[at];
        daten[at + 2] = daten[at];
        daten[at + 3] = 255;
      }
    kastenWeichRgba(daten, w, h, 6);
    // Alles bleibt im gültigen Bereich, nichts wird schwarz, und die Zeilen
    // werden von oben nach unten heller.
    for (let i = 0; i < daten.length; i += 4) expect(daten[i]).toBeGreaterThan(0);
    expect(daten[0]).toBeLessThan(daten[2 * w * 4]);
  });

  it('rührt bei einem unbrauchbaren Radius gar nichts an', () => {
    /*
     * `Math.floor(NaN)` ist NaN, und `NaN <= 0` ist falsch – die Abkürzung
     * griff also nicht. Nachgemessen: Ein Feld aus lauter 200 kam mit
     * `radius = NaN` als reines Schwarz zurück, bei unverändertem Alphakanal.
     * Unter einer Maske wäre das ein schwarzer Fleck ohne Fehlermeldung, und
     * `bokehRadius(NaN, 1200)` liefert genau dieses NaN.
     */
    for (const schlecht of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const daten = new Uint8ClampedArray(4 * 4 * 4).fill(200);
      kastenWeichRgba(daten, 4, 4, schlecht);
      expect(Math.min(...daten)).toBe(200);
    }
  });
});
