/**
 * Plus- und Minus-Tipps.
 *
 * Ein Minus-Tipp ist die einzige Art zu sagen „das ausdruecklich nicht“. Zwei
 * Wege koennen ihn missverstehen, und beide waeren im Alltag schwer zu
 * bemerken:
 *
 * 1. Die Farbflutung (`keepAtSeeds`) kennt kein Wegnehmen. Reicht man ihr
 *    einen Minus-Tipp durch, waechst dort ein Bereich – also genau das
 *    Gegenteil des Gemeinten.
 * 2. Die Umrechnung fuer das Netz muss das Vorzeichen mitnehmen. Faellt es
 *    weg, wird aus „das nicht“ ein zweites „das auch“.
 */
import { describe, expect, it } from 'vitest';
import { keepAtSeeds, type KeepSeed } from '../render.js';

/** Ein Bild mit zwei klar getrennten Farbfeldern. */
function zweiFelder(): ImageData {
  const w = 40;
  const h = 20;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const at = (y * w + x) * 4;
      const links = x < 20;
      data[at] = links ? 230 : 20;
      data[at + 1] = links ? 40 : 200;
      data[at + 2] = 40;
      data[at + 3] = 255;
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

/** Wie viele Punkte im rechten Feld noch sichtbar sind. */
function rechtsSichtbar(bild: ImageData): number {
  let n = 0;
  for (let y = 0; y < bild.height; y += 1) {
    for (let x = 20; x < bild.width; x += 1) {
      if (bild.data[(y * bild.width + x) * 4 + 3] > 8) n += 1;
    }
  }
  return n;
}

describe('keepAtSeeds mit Vorzeichen', () => {
  it('nimmt einen Plus-Tipp als Saat', () => {
    const bild = zweiFelder();
    keepAtSeeds(bild, [{ x: 30, y: 10 }], 40);
    // Rechts angetippt: rechts bleibt stehen.
    expect(rechtsSichtbar(bild)).toBeGreaterThan(300);
  });

  it('ueberspringt einen Minus-Tipp, statt dort wachsen zu lassen', () => {
    // Die genaue Behauptung: Ein Minus-Tipp aendert an der Flutung GAR NICHTS.
    // Ohne die Sonderbehandlung waere er eine zweite Saat, und das rechte Feld
    // bliebe stehen – das genaue Gegenteil von „das nicht“.
    const ohne = zweiFelder();
    const mit = zweiFelder();
    const seeds: KeepSeed[] = [
      { x: 5, y: 10 },
      { x: 30, y: 10, mode: 'weg' },
    ];
    keepAtSeeds(ohne, [{ x: 5, y: 10 }], 40);
    keepAtSeeds(mit, seeds, 40);
    expect(Array.from(mit.data)).toEqual(Array.from(ohne.data));

    // Und zur Gegenprobe, dass der Test ueberhaupt etwas misst: Als PLUS-Tipp
    // an derselben Stelle bliebe das rechte Feld deutlich stehen.
    const alsPlus = zweiFelder();
    keepAtSeeds(alsPlus, [{ x: 5, y: 10 }, { x: 30, y: 10 }], 40);
    expect(rechtsSichtbar(alsPlus)).toBeGreaterThan(rechtsSichtbar(mit) + 200);
  });

  it('behandelt einen Tipp ohne Angabe wie „dazu“ – alte Sticker bleiben gueltig', () => {
    const ohne = zweiFelder();
    const mit = zweiFelder();
    keepAtSeeds(ohne, [{ x: 30, y: 10 }], 40);
    keepAtSeeds(mit, [{ x: 30, y: 10, mode: 'dazu' }], 40);
    expect(Array.from(ohne.data)).toEqual(Array.from(mit.data));
  });

  it('laesst bei nur Minus-Tipps alles verschwinden, nicht alles stehen', () => {
    const bild = zweiFelder();
    keepAtSeeds(bild, [{ x: 30, y: 10, mode: 'weg' }], 40);
    // Keine gueltige Saat heisst: nichts wird behalten. Das Netz lehnt
    // denselben Fall mit einer Meldung ab; die Flutung hat keine, also muss
    // es wenigstens vorhersagbar sein – und vor allem nicht das Gegenteil.
    let sichtbar = 0;
    for (let i = 3; i < bild.data.length; i += 4) if (bild.data[i] > 8) sichtbar += 1;
    expect(sichtbar).toBe(0);
  });
});
