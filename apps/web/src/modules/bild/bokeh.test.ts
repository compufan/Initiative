import { describe, expect, it } from 'vitest';
import { bokehRgba } from './bokeh.js';
import { kastenWeichRgba } from './weich.js';

function feld(breite: number, hoehe: number, farbe: (x: number, y: number) => number) {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      const v = farbe(x, y);
      daten[at] = v;
      daten[at + 1] = v;
      daten[at + 2] = v;
      daten[at + 3] = 255;
    }
  }
  return daten;
}

const lies = (daten: Uint8ClampedArray, breite: number, x: number, y: number) =>
  daten[(y * breite + x) * 4];

describe('Bokeh statt Weichzeichner', () => {
  /*
   * Der Grundtest für jede laufende Summe: Ein gleichmässiges Feld muss
   * gleichmässig bleiben. Driftet der Zähler am Rand, sieht man es hier
   * zuerst – und sonst erst an einem hellen Saum um das ganze Bild.
   */
  it('lässt ein gleichmässiges Feld gleichmässig', () => {
    const daten = feld(40, 40, () => 128);
    bokehRgba(daten, 40, 40, 6);
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        expect(Math.abs(lies(daten, 40, x, y) - 128)).toBeLessThanOrEqual(2);
      }
    }
  });

  /*
   * Der Kern der Sache. Ein Lichtpunkt auf dunklem Grund: Im Anzeigeraum
   * gemittelt bleibt ein matter Schleier, im linearen Licht ein Fleck, den
   * man als Licht erkennt.
   */
  it('hält ein Glanzlicht hell, wo der Kastenweichzeichner es verwischt', () => {
    const mitte = (x: number, y: number) => (x === 20 && y === 20 ? 255 : 10);
    const alsBokeh = feld(41, 41, mitte);
    const alsKasten = feld(41, 41, mitte);

    bokehRgba(alsBokeh, 41, 41, 6);
    kastenWeichRgba(alsKasten, 41, 41, 6);

    const hellBokeh = lies(alsBokeh, 41, 20, 20);
    const hellKasten = lies(alsKasten, 41, 20, 20);
    expect(hellBokeh).toBeGreaterThan(hellKasten * 2);
  });

  /*
   * Die Form. Ein Kasten aus zwei rechtwinkligen Durchgängen hat in der
   * Diagonale dieselbe Reichweite wie auf der Achse – ein Quadrat eben. Eine
   * Blende hat das nicht: In der Ecke ist sie näher an der Mitte.
   */
  it('wirft keinen quadratischen Fleck', () => {
    const mitte = (x: number, y: number) => (x === 30 && y === 30 ? 255 : 0);
    const alsBokeh = feld(61, 61, mitte);
    const alsKasten = feld(61, 61, mitte);
    bokehRgba(alsBokeh, 61, 61, 10);
    kastenWeichRgba(alsKasten, 61, 61, 10);

    /** Wie weit reicht der Fleck in eine Richtung? */
    const reichweite = (daten: Uint8ClampedArray, dx: number, dy: number) => {
      for (let s = 1; s < 30; s += 1) {
        const v = lies(daten, 61, 30 + Math.round(dx * s), 30 + Math.round(dy * s));
        if (v <= 0) return s - 1;
      }
      return 29;
    };

    const r = Math.SQRT1_2;
    // Beim Kasten reicht die Ecke genauso weit wie die Achse (Quadrat).
    const kastenAchse = reichweite(alsKasten, 1, 0);
    const kastenEcke = reichweite(alsKasten, r, r);
    expect(kastenEcke).toBeGreaterThanOrEqual(kastenAchse - 1);

    // Beim Bokeh nicht: Die Ecke ist deutlich näher.
    const bokehAchse = reichweite(alsBokeh, 1, 0);
    const bokehEcke = reichweite(alsBokeh, r, r);
    expect(bokehAchse).toBeGreaterThan(0);
    expect(bokehEcke).toBeLessThan(bokehAchse);
  });

  it('lässt Alpha in Ruhe – die Maskenkante darf nicht mitverwischen', () => {
    const daten = feld(20, 20, () => 200);
    for (let i = 0; i < 20 * 20; i += 1) daten[i * 4 + 3] = i % 2 === 0 ? 0 : 255;
    const vorher = Array.from({ length: 400 }, (_, i) => daten[i * 4 + 3]);
    bokehRgba(daten, 20, 20, 4);
    for (let i = 0; i < 400; i += 1) expect(daten[i * 4 + 3]).toBe(vorher[i]);
  });

  it('tut bei Radius 0 nichts', () => {
    const daten = feld(10, 10, (x) => x * 20);
    const vorher = Array.from(daten);
    bokehRgba(daten, 10, 10, 0);
    expect(Array.from(daten)).toEqual(vorher);
  });
});
