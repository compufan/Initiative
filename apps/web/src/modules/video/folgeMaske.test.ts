import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import { folgeMasken } from './folgeMaske.js';
import type { GueteInfo } from './einstellungen.js';
import type { GelesenesBild } from './bilderLesen.js';

/**
 * Das Zusammenspiel aus Netz, Schieben und Glätten.
 *
 * Das Netz selbst ist hier ein Ersatz – es soll ja gerade NICHT geprüft
 * werden, ob u2netp eine Katze findet. Geprüft wird, was dieses Modul
 * entscheidet: wann das Netz läuft, dass es nie zweimal zugleich läuft, und
 * dass zwischen den Läufen wirklich geschoben statt wiederholt wird.
 */

/** Ob das Netz je zweimal zugleich lief. */
let gleichzeitig = 0;
let hoechstens = 0;
/** Die Punkte, mit denen `tippTeilRechnen` gerufen wurde – je Aufruf eine Liste. */
let letzteSaaten: { x: number; y: number }[][] = [];
let mitNetzGesehen: boolean[] = [];

vi.mock('../stickers/engines/index.js', async () => {
  const echt = await vi.importActual<typeof import('../stickers/engines/index.js')>(
    '../stickers/engines/index.js',
  );
  return {
    ...echt,
    runEngine: async (_key: string, anfrage: { image: ImageData }) => {
      gleichzeitig += 1;
      hoechstens = Math.max(hoechstens, gleichzeitig);
      // Eine Umdrehung des Mikroaufgabenrades: Ohne sie liefe der Ersatz
      // synchron durch, und zwei gleichzeitige Läufe wären gar nicht möglich.
      await Promise.resolve();
      const maske = new Uint8Array(anfrage.image.width * anfrage.image.height);
      // Ein Kreis um die Mitte – etwas, das sich verschieben lässt.
      const b = anfrage.image.width;
      const h = anfrage.image.height;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < b; x += 1) {
          const d = (x - b / 2) ** 2 + (y - h / 2) ** 2;
          maske[y * b + x] = d < (b / 4) ** 2 ? 255 : 0;
        }
      }
      gleichzeitig -= 1;
      return maske;
    },
  };
});

vi.mock('../bild/tippMaske.js', async () => {
  const echt = await vi.importActual<typeof import('../bild/tippMaske.js')>('../bild/tippMaske.js');
  return {
    ...echt,
    tippNetzVerfuegbar: () => true,
    tippTeilRechnen: async (
      bild: ImageData,
      punkte: readonly { x: number; y: number }[],
      wahl: { mitNetz: boolean },
    ) => {
      letzteSaaten.push(punkte.map(({ x, y }) => ({ x, y })));
      mitNetzGesehen.push(wahl.mitNetz);
      return {
        id: 't1',
        modus: 'dazu' as const,
        umkehren: false,
        art: 'tipp' as const,
        mitNetz: wahl.mitNetz,
        punkte: [...punkte],
        toleranz: 32,
        breite: bild.width,
        hoehe: bild.height,
        alpha: new Uint8Array(bild.width * bild.height),
        marke: 1,
      };
    },
  };
});

const GUETE: GueteInfo = {
  key: 'genau',
  titel: 'Genau',
  beschreibung: 'Prüfung',
  netz: 'object',
  schluesselAbstand: 4,
  kante: 64,
  jeNetzlaufMs: 1600,
  brauchtGrafik: false,
};

/** Ein Bild mit Struktur, verschoben um (vx, 0). */
function bild(zeitMs: number, vx: number, kante = 64): GelesenesBild {
  const daten = new Uint8ClampedArray(kante * kante * 4);
  for (let y = 0; y < kante; y += 1) {
    for (let x = 0; x < kante; x += 1) {
      const at = (y * kante + x) * 4;
      const wert = 128 + 90 * Math.sin((x - vx) / 3.7) * Math.cos(y / 5.3);
      daten[at] = wert;
      daten[at + 1] = wert;
      daten[at + 2] = wert;
      daten[at + 3] = 255;
    }
  }
  return {
    zeitMs,
    daten: { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData,
  };
}

/** Eine Folge, in der sich das Motiv Bild für Bild um zwei Punkte bewegt. */
function folge(anzahl: number, schritt = 2): GelesenesBild[] {
  return Array.from({ length: anzahl }, (_, i) => bild(i * 100, i * schritt));
}

beforeEach(() => {
  letzteSaaten = [];
  mitNetzGesehen = [];
  gleichzeitig = 0;
  hoechstens = 0;
});

describe('folgeMasken', () => {
  it('lässt das Netz nur auf jedem n-ten Bild laufen', async () => {
    /*
     * Der ganze Grund für dieses Modul. Dreizehn Bilder bei Abstand vier sind
     * vier Netzläufe statt dreizehn – bei gemessenen 1,6 s je Lauf also 6,4 s
     * statt 20,8 s.
     */
    const { netzlaeufe } = await folgeMasken(folge(13), { guete: GUETE });
    expect(netzlaeufe).toBe(4);
  });

  it('macht das LETZTE Bild immer zum Schlüsselbild', async () => {
    /*
     * Ein GIF läuft in einer Schleife; sein Ende sieht man besonders oft. Bei
     * zehn Bildern und Abstand vier wären ohne diese Regel die letzten beiden
     * geschoben, und genau dort sitzt der Rand am schlechtesten.
     */
    const { netzlaeufe } = await folgeMasken(folge(10), { guete: GUETE });
    // 0, 4, 8 und zusätzlich 9.
    expect(netzlaeufe).toBe(4);
  });

  it('lässt das Netz nie zweimal zugleich laufen', async () => {
    /*
     * Dahinter steht EIN Arbeiter mit EINEM Modell. `birefnetKanal` weist
     * einen zweiten Auftrag ab, und zwei Modelle nebeneinander sind auf einem
     * Telefon der sicherste Weg, den Arbeiter zu verlieren.
     */
    await folgeMasken(folge(12), { guete: GUETE });
    expect(hoechstens).toBe(1);
  });

  it('gibt für jedes Bild genau eine Maske', async () => {
    const { masken } = await folgeMasken(folge(7), { guete: GUETE });
    expect(masken).toHaveLength(7);
    for (const maske of masken) expect(maske.length).toBe(64 * 64);
  });

  it('schiebt zwischen den Netzläufen, statt zu wiederholen', async () => {
    /*
     * Ohne Schieben wäre die Maske zwischen zwei Schlüsselbildern identisch –
     * und das Motiv liefe darunter weg. Geprüft wird über den Schwerpunkt:
     * Er muss wandern.
     */
    const { masken } = await folgeMasken(folge(9, 3), { guete: GUETE });
    const mitte = (maske: Uint8Array) => {
      let sx = 0;
      let summe = 0;
      for (let i = 0; i < maske.length; i += 1) {
        sx += (i % 64) * maske[i];
        summe += maske[i];
      }
      return sx / summe;
    };
    expect(mitte(masken[2])).toBeGreaterThan(mitte(masken[1]));
    expect(mitte(masken[1])).toBeGreaterThan(mitte(masken[0]));
  });

  it('schiebt die Tipps mit, statt sie liegen zu lassen', async () => {
    /*
     * Ein Tipp auf eine Person muss auch drei Bilder später auf der Person
     * liegen. Bleibt er stehen, sagt er beim nächsten Schlüsselbild
     * „Hintergrund" – und die Maske springt auf etwas anderes.
     */
    await folgeMasken(folge(9, 3), {
      guete: GUETE,
      tipps: [{ x: 20, y: 32, dazu: true }],
    });
    expect(letzteSaaten.length).toBeGreaterThanOrEqual(3);
    expect(letzteSaaten[0][0].x).toBe(20);
    expect(letzteSaaten[1][0].x).toBeGreaterThan(letzteSaaten[0][0].x);
  });

  it('gibt die Tipps an das TIPPVERFAHREN, nicht an das Motivnetz', async () => {
    /*
     * Hier stand einmal ein `seeds` am Aufruf des Motivnetzes, und das war
     * wirkungslos: „Person", „Niedrige Qualität" und „Hohe Qualität" nehmen
     * gar keine Saatpunkte entgegen – sie suchen das auffälligste Motiv und
     * sonst nichts. Die Tipps verschwanden lautlos, und in der Oberfläche
     * stand trotzdem ein Punkt.
     */
    await folgeMasken(folge(5), { guete: GUETE, tipps: [{ x: 8, y: 8, dazu: true }] });
    expect(letzteSaaten.length).toBeGreaterThan(0);
  });

  it('macht je Vorzeichen EINEN Aufruf, nicht einen je Punkt', async () => {
    /*
     * `tippTeilRechnen` behandelt alle Saatpunkte zusammen: Beim Tippnetz
     * teilen sie sich die Einbettung des Bildes, bei der Farbflutung einen
     * einzigen Durchgang. Ein Aufruf je Punkt wäre dasselbe Ergebnis für das
     * Dreifache an Arbeit.
     */
    await folgeMasken(folge(1), {
      guete: GUETE,
      tipps: [
        { x: 4, y: 4, dazu: true },
        { x: 8, y: 8, dazu: true },
        { x: 12, y: 12, dazu: false },
      ],
    });
    expect(letzteSaaten).toHaveLength(2);
    expect(letzteSaaten[0]).toHaveLength(2);
    expect(letzteSaaten[1]).toHaveLength(1);
  });

  it('reicht die Wahl „mit Netz“ durch', async () => {
    // Ohne Netz wird nach Farbe getippt – der einzige Weg, der auch an einem
    // Ding funktioniert, für das kein Modell je trainiert wurde.
    await folgeMasken(folge(1), {
      guete: GUETE,
      mitNetz: false,
      tipps: [{ x: 4, y: 4, dazu: true }],
    });
    expect(mitNetzGesehen).toEqual([false]);
  });

  it('bricht ab, wenn das Signal schon gesetzt ist', async () => {
    // Ohne diese Prüfung liefe der erste Netzlauf noch an – bei „Sehr genau"
    // wären das 84 MB für ein Ergebnis, das niemand mehr will.
    const abbruch = AbortSignal.abort();
    await expect(folgeMasken(folge(8), { guete: GUETE, abbruch })).rejects.toBeInstanceOf(
      AbbruchError,
    );
  });

  it('bricht mittendrin ab', async () => {
    const steuerung = new AbortController();
    const versprechen = folgeMasken(folge(20), {
      guete: GUETE,
      abbruch: steuerung.signal,
      fortschritt: (anteil) => {
        if (anteil > 0.2) steuerung.abort();
      },
    });
    await expect(versprechen).rejects.toBeInstanceOf(AbbruchError);
  });

  it('meldet den Fortschritt für jedes Bild', async () => {
    // Bei „Genau" dauert das Minuten. Ohne Rückmeldung steht der Anwender vor
    // einem Knopf, der nichts tut.
    const anteile: number[] = [];
    await folgeMasken(folge(8), { guete: GUETE, fortschritt: (a) => anteile.push(a) });
    expect(anteile).toHaveLength(8);
    expect(anteile[7]).toBe(1);
    for (let i = 1; i < anteile.length; i += 1) expect(anteile[i]).toBeGreaterThan(anteile[i - 1]);
  });

  it('kommt mit einem einzigen Bild zurecht', async () => {
    const { masken, netzlaeufe } = await folgeMasken(folge(1), { guete: GUETE });
    expect(netzlaeufe).toBe(1);
    expect(masken).toHaveLength(1);
  });

  it('kommt mit gar keinem Bild zurecht', async () => {
    const leer = await folgeMasken([], { guete: GUETE });
    expect(leer.masken).toEqual([]);
    expect(leer.netzlaeufe).toBe(0);
  });

  it('lässt bei Abstand eins jedes Bild durchs Netz', async () => {
    // „Schnell" kostet 36 ms je Lauf – da ist Schieben kaum billiger, und
    // jedes Bild frisch gerechnet sitzt genauer.
    const { netzlaeufe } = await folgeMasken(folge(6), {
      guete: { ...GUETE, schluesselAbstand: 1 },
    });
    expect(netzlaeufe).toBe(6);
  });
});
