import { describe, expect, it } from 'vitest';

import { neuesDoc, type BildDoc } from '../bild/doc.js';
import { pufferGruppen } from './videoBauen.js';

/** Ein Dokument mit einem Tipp – eine Maske, die am Bildinhalt hängt. */
function mitTipp(): BildDoc {
  return {
    ...neuesDoc(64, 36),
    bereiche: [
      {
        id: 'b1',
        name: 'Motiv',
        aktiv: true,
        teile: [
          {
            id: 't1',
            modus: 'dazu' as const,
            umkehren: false,
            art: 'tipp' as const,
            mitNetz: false,
            punkte: [{ x: 1, y: 1 }],
            toleranz: 32,
            breite: 64,
            hoehe: 36,
            alpha: new Uint8Array(64 * 36),
            marke: 1,
          },
        ],
        anpassung: { ...neuesDoc(1, 1).anpassung, unschaerfe: 0 },
      },
    ],
  };
}

describe('pufferGruppen', () => {
  it('sammelt nur, wo eine Maske oder Form hängt', () => {
    const maske = mitTipp();
    const schlicht = {
      ...neuesDoc(64, 36),
      anpassung: { ...neuesDoc(1, 1).anpassung, waerme: 20 },
    };
    expect(
      pufferGruppen([
        { vonMs: 0, bisMs: 1000, doc: schlicht, standMs: 0 },
        { vonMs: 1000, bisMs: 2000, doc: maske, standMs: 1000 },
        { vonMs: 2000, bisMs: 3000, doc: null, standMs: 2000 },
      ]),
    ).toEqual([null, 1, null]);
  });

  it('trennt Abschnitte mit eigenem Stellbild, auch bei demselben Dokument', () => {
    // Nach einem Teilen tragen beide Hälften dasselbe Dokument, aber jede
    // hat ihr Stellbild – beim Bauen sind das zwei Gruppen mit zwei Ankern.
    const maske = mitTipp();
    expect(
      pufferGruppen([
        { vonMs: 0, bisMs: 1000, doc: maske, standMs: 500 },
        { vonMs: 1000, bisMs: 2000, doc: maske, standMs: 1500 },
      ]),
    ).toEqual([0, 1]);
  });

  it('hält nahtlose Stücke mit demselben Dokument und ohne Stellbild zusammen', () => {
    const maske = mitTipp();
    expect(
      pufferGruppen(
        [
          { vonMs: 0, bisMs: 1000 },
          { vonMs: 1000, bisMs: 2000 },
        ],
        maske,
      ),
    ).toEqual([0, 0]);
  });
});
