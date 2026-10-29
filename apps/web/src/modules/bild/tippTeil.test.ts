import { describe, expect, it } from 'vitest';

import { BEREICH_NEUTRAL, TOLERANZ_VORGABE, neuesDoc, type Maskenteil } from './doc.js';
import { teilBauen, teilSchluessel } from './maske.js';
import { REZEPT_GRENZEN, docAusRoh, docNachRoh } from './rezept.js';
import { flutmaske } from '../stickers/engines/flutung.js';
import { istAnfangVon, tippGehoertDazu } from './tippMaske.js';

/**
 * Die Prüfungen zum Antippen in den Bereichen.
 *
 * Was hier NICHT geprüft wird und warum: `tippTeilRechnen` selbst braucht eine
 * Leinwand (`vorlageAus` zeichnet das Bild verkleinert) und beim Netz eine
 * Laufzeit mit 30 MB Modell. Die Prüfungen laufen ohne Browser. Deshalb ist
 * das Prüfbare hier auseinandergezogen: die Flutung als reine Rechnung, das
 * Teil als Raster, sein Schlüssel und der Weg durch eine Datei und zurück.
 */

function bildpunkte(
  breite: number,
  hoehe: number,
  male: (x: number, y: number) => [number, number, number],
) {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const [r, g, b] = male(x, y);
      const at = (y * breite + x) * 4;
      daten[at] = r;
      daten[at + 1] = g;
      daten[at + 2] = b;
      daten[at + 3] = 255;
    }
  }
  return { width: breite, height: hoehe, data: daten } as ImageData;
}

function tippTeil(werte: Partial<Record<string, unknown>> = {}): Maskenteil {
  return {
    id: 't1',
    modus: 'dazu',
    umkehren: false,
    art: 'tipp',
    mitNetz: false,
    punkte: [{ x: 2, y: 1 }],
    toleranz: 40,
    breite: 8,
    hoehe: 4,
    alpha: new Uint8Array(32).fill(200),
    marke: 7,
    ...werte,
  } as Maskenteil;
}

describe('Flutung als Grundlage des Antippens', () => {
  it('nimmt die Farbfläche unter dem Finger und nicht die daneben', () => {
    // Links schwarz, rechts weiss – die Grenze läuft senkrecht durch die Mitte.
    const bild = bildpunkte(16, 8, (x) => (x < 8 ? [10, 10, 10] : [240, 240, 240]));
    const maske = flutmaske(bild, [{ x: 2, y: 4 }], TOLERANZ_VORGABE);
    expect(maske[4 * 16 + 2]).toBeGreaterThan(0);
    /*
     * Die rechte Hälfte muss LEER sein – nicht bloss „weniger“.
     *
     * Und geprüft wird ein Punkt mit Abstand zur Naht: `flutmaske` zieht am
     * Ende eine weiche Kante über das Ergebnis (zwei Punkte Ausweitung, einer
     * Weichzeichner), die zwangsläufig über die Grenze greift. Ein Punkt
     * unmittelbar rechts der Mitte wäre deshalb auch bei völlig richtiger
     * Rechnung nicht null.
     */
    expect(maske[4 * 16 + 14]).toBe(0);
  });

  it('nimmt mehrere Tipps zusammen – jeder Punkt flutet für sich', () => {
    // Drei senkrechte Streifen: dunkel, hell, dunkel.
    const bild = bildpunkte(15, 5, (x) => (x < 5 || x >= 10 ? [20, 20, 20] : [230, 230, 230]));
    const nurLinks = flutmaske(bild, [{ x: 2, y: 2 }], 20);
    const beide = flutmaske(
      bild,
      [
        { x: 2, y: 2 },
        { x: 12, y: 2 },
      ],
      20,
    );
    expect(nurLinks[2 * 15 + 12]).toBe(0);
    expect(beide[2 * 15 + 12]).toBeGreaterThan(0);
    // Der erste Streifen bleibt, wo er war – der zweite Tipp nimmt ihm nichts.
    expect(beide[2 * 15 + 2]).toBeGreaterThan(0);
  });

  it('überspringt einen Minus-Tipp, statt ihn als zweite Saat zu nehmen', () => {
    /*
     * Die Flutung kann kein Wegnehmen – im Fotoeditor entscheidet das
     * Vorzeichen am TEIL (`modus`), nicht am Punkt. Würde sie einen
     * Minus-Punkt als Saat nehmen, käme beim Wegnehmen genau das Gegenteil
     * heraus: Die Fläche würde grösser statt kleiner.
     */
    const bild = bildpunkte(15, 5, (x) => (x < 5 || x >= 10 ? [20, 20, 20] : [230, 230, 230]));
    const maske = flutmaske(bild, [{ x: 2, y: 2, mode: 'weg' }], 20);
    expect(maske.every((wert) => wert === 0)).toBe(true);
  });
});

describe('Tippteil als Maskenteil', () => {
  it('wird gerastert wie ein Netzteil', () => {
    const teil = tippTeil({
      breite: 2,
      hoehe: 2,
      alpha: Uint8Array.from([255, 0, 0, 255]),
    });
    const feld = teilBauen(teil, { breite: 2, hoehe: 2, faktor: 1 });
    expect(Array.from(feld)).toEqual([255, 0, 0, 255]);
  });

  it('kehrt sich um, wenn `umkehren` steht', () => {
    const teil = tippTeil({
      breite: 2,
      hoehe: 2,
      alpha: Uint8Array.from([255, 0, 0, 255]),
      umkehren: true,
    });
    expect(Array.from(teilBauen(teil, { breite: 2, hoehe: 2, faktor: 1 }))).toEqual([
      0, 255, 255, 0,
    ]);
  });

  it('nimmt die Marke in den Schlüssel und nie die Maske selbst', () => {
    const schluessel = teilSchluessel(tippTeil());
    expect(schluessel).toContain('|7');
    // `[object Uint8Array]` wäre der Fehler, den es beim Netzteil einmal gab:
    // zwei verschiedene Masken bekämen denselben Schlüssel.
    expect(schluessel).not.toContain('object');
  });

  it('unterscheidet zwei Teile, die sich nur in der Marke unterscheiden', () => {
    // Genau das ist der Fall nach einem weiteren Tipp: dieselbe Kennung,
    // dieselben Masse, eine andere Maske.
    expect(teilSchluessel(tippTeil({ marke: 7 }))).not.toBe(teilSchluessel(tippTeil({ marke: 8 })));
  });

  it('unterscheidet Netz und Farbe – zwei Teile, ein Bereich', () => {
    expect(teilSchluessel(tippTeil({ mitNetz: false }))).not.toBe(
      teilSchluessel(tippTeil({ mitNetz: true })),
    );
  });
});

describe('Tippteil in einer Datei', () => {
  it('übersteht den Weg in eine Datei und zurück', () => {
    const doc = neuesDoc(1200, 900);
    doc.bereiche = [
      { id: 'b', name: 'B', aktiv: true, teile: [tippTeil()], anpassung: BEREICH_NEUTRAL },
    ];
    const zurueck = docAusRoh(docNachRoh(doc), 1200, 900);
    const teil = zurueck.bereiche[0].teile[0];
    expect(teil.art).toBe('tipp');
    if (teil.art !== 'tipp') return;
    expect(teil.mitNetz).toBe(false);
    expect(teil.toleranz).toBe(40);
    expect(teil.punkte).toEqual([{ x: 2, y: 1 }]);
    expect(Array.from(teil.alpha)).toEqual(Array.from(new Uint8Array(32).fill(200)));
  });

  it('verwirft ein Tippteil ohne Punkte, obwohl seine Maske heil ist', () => {
    /*
     * Die Maske allein liesse sich zeigen – aber nicht zurücknehmen und nicht
     * nachjustieren. Ein Teil, das aussieht wie die anderen und sich nicht wie
     * sie bedienen lässt, ist schlimmer als eines, das fehlt.
     */
    const doc = docAusRoh(
      {
        bereiche: [
          {
            id: 'b',
            teile: [
              {
                art: 'tipp',
                breite: 8,
                hoehe: 4,
                alpha: btoa('x'.repeat(32)),
                punkte: [],
              },
            ],
          },
        ],
      },
      1200,
      900,
    );
    expect(doc.bereiche[0].teile).toHaveLength(0);
  });

  it('begrenzt die Zahl der Stellen', () => {
    const zuViele = Array.from({ length: REZEPT_GRENZEN.tippPunkte + 20 }, (_, i) => [i, i]);
    const doc = docAusRoh(
      {
        bereiche: [
          {
            id: 'b',
            teile: [
              { art: 'tipp', breite: 8, hoehe: 4, alpha: btoa('x'.repeat(32)), punkte: zuViele },
            ],
          },
        ],
      },
      1200,
      900,
    );
    const teil = doc.bereiche[0].teile[0];
    expect(teil.art).toBe('tipp');
    if (teil.art !== 'tipp') return;
    expect(teil.punkte).toHaveLength(REZEPT_GRENZEN.tippPunkte);
  });

  it('klemmt Stellen ausserhalb der Maske an ihren Rand', () => {
    /*
     * Gegen das Raster begrenzt, nicht gegen das Original: Die Punkte liegen
     * in der Vorlage. Eine Stelle weit ausserhalb wäre eine Saat, die
     * `flutmaske` wortlos überspringt – und beim nächsten Neurechnen fehlte
     * ein Stück Maske ohne jede Meldung.
     */
    const doc = docAusRoh(
      {
        bereiche: [
          {
            id: 'b',
            teile: [
              {
                art: 'tipp',
                breite: 8,
                hoehe: 4,
                alpha: btoa('x'.repeat(32)),
                punkte: [[9999, -5]],
              },
            ],
          },
        ],
      },
      1200,
      900,
    );
    const teil = doc.bereiche[0].teile[0];
    expect(teil.art).toBe('tipp');
    if (teil.art !== 'tipp') return;
    expect(teil.punkte).toEqual([{ x: 8, y: 0 }]);
  });
});

describe('Abkürzung beim Weiterrechnen', () => {
  it('sieht eine echte Fortsetzung als solche', () => {
    expect(
      istAnfangVon(
        [{ x: 1, y: 2 }],
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      ),
    ).toBe(true);
    expect(istAnfangVon([], [{ x: 1, y: 2 }])).toBe(true);
    expect(istAnfangVon([{ x: 1, y: 2 }], [{ x: 1, y: 2 }])).toBe(true);
  });

  it('erkennt ein Zurücknehmen – auch bei gleicher Länge', () => {
    /*
     * Der stille Fall. Wer nur die Längen vergliche, hielte „einen Punkt
     * zurückgenommen und einen anderen gesetzt" für eine Fortsetzung. Die
     * Maske behielte dann die Fläche des zurückgenommenen Tipps – sichtbar,
     * ohne Meldung, und ohne einen Punkt in der Liste, der schuld wäre.
     */
    expect(istAnfangVon([{ x: 9, y: 9 }], [{ x: 1, y: 2 }])).toBe(false);
    expect(
      istAnfangVon(
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        [{ x: 1, y: 2 }],
      ),
    ).toBe(false);
    expect(
      istAnfangVon(
        [
          { x: 1, y: 2 },
          { x: 9, y: 9 },
        ],
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      ),
    ).toBe(false);
  });
});

describe('Gehört ein Tipp zu einem Teil? – ein Teil je Gegenstand im Film', () => {
  /** Ein 10 × 6 Raster, in dem die Spalten 2 bis 4 gedeckt sind. */
  function teilMitSaeule() {
    const alpha = new Uint8Array(10 * 6);
    for (let y = 0; y < 6; y += 1) for (let x = 2; x <= 4; x += 1) alpha[y * 10 + x] = 255;
    return { alpha, breite: 10, hoehe: 6 };
  }

  it('sagt ja für eine Stelle in der Maske', () => {
    expect(tippGehoertDazu(teilMitSaeule(), { x: 3, y: 3 })).toBe(true);
  });

  it('sagt nein für eine Stelle weit daneben – das ist ein anderer Gegenstand', () => {
    expect(tippGehoertDazu(teilMitSaeule(), { x: 8, y: 3 })).toBe(false);
  });

  it('lässt einen Punkt Nachbarschaft gelten und keinen mehr', () => {
    const teil = teilMitSaeule();
    expect(tippGehoertDazu(teil, { x: 5, y: 3 })).toBe(true);
    expect(tippGehoertDazu(teil, { x: 6, y: 3 })).toBe(false);
    expect(tippGehoertDazu(teil, { x: 1, y: 3 })).toBe(true);
    expect(tippGehoertDazu(teil, { x: 0, y: 3 })).toBe(false);
  });

  it('rechnet mit einer Stelle zwischen zwei Bildpunkten', () => {
    expect(tippGehoertDazu(teilMitSaeule(), { x: 4.6, y: 2.4 })).toBe(true);
  });

  it('bleibt am Rand des Rasters im Raster', () => {
    const teil = teilMitSaeule();
    expect(tippGehoertDazu(teil, { x: 2, y: 0 })).toBe(true);
    expect(tippGehoertDazu(teil, { x: 2, y: 5 })).toBe(true);
    expect(tippGehoertDazu(teil, { x: -3, y: 3 })).toBe(false);
    expect(tippGehoertDazu(teil, { x: 3, y: 40 })).toBe(false);
  });

  it('zählt eine halb durchsichtige Kante nicht als Deckung', () => {
    const teil = { alpha: new Uint8Array(30).fill(100), breite: 5, hoehe: 6 };
    expect(tippGehoertDazu(teil, { x: 2, y: 2 })).toBe(false);
    teil.alpha[2 * 5 + 2] = 128;
    expect(tippGehoertDazu(teil, { x: 2, y: 2 })).toBe(true);
  });
});
