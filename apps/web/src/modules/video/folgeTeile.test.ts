import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import { TeileAbbruch, folgeTeile } from './folgeTeile.js';
import type { InhaltsTeil } from './bildweise.js';
import type { GelesenesBild } from './bilderLesen.js';

/**
 * Die inhaltsabhängigen Maskenteile über einen ganzen Film.
 *
 * Netz, Tiefe und Antippen sind hier ersetzt – geprüft wird nicht, ob u2netp
 * eine Katze findet, sondern was dieses Modul entscheidet: Wann läuft ein
 * Modell überhaupt? Wird die Tiefensitzung EINMAL geöffnet oder je Bild? Und
 * wird die Tiefenkarte am Ende geglättet – was sie nicht darf?
 */

let netzlaeufe = 0;
let tippLaeufe = 0;
let tiefeLaeufe = 0;
let sitzungenAuf = 0;
let sitzungenZu = 0;

vi.mock('../stickers/engines/index.js', async () => {
  const echt = await vi.importActual<typeof import('../stickers/engines/index.js')>(
    '../stickers/engines/index.js',
  );
  return {
    ...echt,
    runEngine: async (_key: string, anfrage: { image: ImageData }) => {
      netzlaeufe += 1;
      await Promise.resolve();
      const maske = new Uint8Array(anfrage.image.width * anfrage.image.height);
      // Ein Block links – etwas, das sich schieben lässt.
      for (let y = 0; y < anfrage.image.height; y += 1) {
        for (let x = 0; x < 8; x += 1) maske[y * anfrage.image.width + x] = 255;
      }
      return maske;
    },
  };
});

vi.mock('../stickers/engines/prepare.js', async () => {
  const echt = await vi.importActual<typeof import('../stickers/engines/prepare.js')>(
    '../stickers/engines/prepare.js',
  );
  return { ...echt, kanteWeichzeichnen: (alpha: Uint8Array) => alpha };
});

vi.mock('../bild/tippMaske.js', () => ({
  tippTeilRechnen: async (bild: ImageData) => {
    tippLaeufe += 1;
    return {
      id: 't1',
      modus: 'dazu' as const,
      umkehren: false,
      art: 'tipp' as const,
      mitNetz: false,
      punkte: [],
      toleranz: 32,
      breite: bild.width,
      hoehe: bild.height,
      alpha: new Uint8Array(bild.width * bild.height).fill(128),
      marke: 1,
    };
  },
}));

vi.mock('../bild/tiefeNetz.js', () => ({
  tiefensitzungOeffnen: async () => {
    sitzungenAuf += 1;
    return {
      karteFuer: async (bild: ImageData) => {
        tiefeLaeufe += 1;
        return {
          breite: bild.width,
          hoehe: bild.height,
          // Ein Verlauf, kein Volltreffer: Daran lässt sich sehen, ob am Ende
          // geglättet wurde.
          feld: new Uint8Array(bild.width * bild.height).map((_, i) => (i * 7) % 256),
        };
      },
      schliessen: async () => {
        sitzungenZu += 1;
      },
    };
  },
}));

function bild(nummer: number, kante = 32): GelesenesBild {
  const daten = new Uint8ClampedArray(kante * kante * 4);
  for (let y = 0; y < kante; y += 1) {
    for (let x = 0; x < kante; x += 1) {
      const at = (y * kante + x) * 4;
      const wert = 128 + 90 * Math.sin((x - nummer * 2) / 3.7) * Math.cos(y / 5.3);
      daten[at] = wert;
      daten[at + 1] = wert;
      daten[at + 2] = wert;
      daten[at + 3] = 255;
    }
  }
  return {
    zeitMs: nummer * 100,
    daten: { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData,
  };
}

const NETZ: InhaltsTeil = {
  bereich: 'b1',
  art: 'netz',
  teil: {
    id: 'n1',
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz: 'person',
    breite: 32,
    hoehe: 32,
    alpha: new Uint8Array(1024),
    marke: 1,
  },
};

const TIEFE: InhaltsTeil = {
  bereich: 'b1',
  art: 'tiefe',
  teil: {
    id: 'd1',
    modus: 'dazu',
    umkehren: false,
    art: 'tiefe',
    breite: 32,
    hoehe: 32,
    karte: new Uint8Array(1024),
    fokus: 1,
    spanne: 0.5,
    marke: 1,
  },
};

const TIPP: InhaltsTeil = {
  bereich: 'b1',
  art: 'tipp',
  teil: {
    id: 't1',
    modus: 'dazu',
    umkehren: false,
    art: 'tipp',
    mitNetz: false,
    punkte: [{ x: 4, y: 4 }],
    toleranz: 32,
    breite: 32,
    hoehe: 32,
    alpha: new Uint8Array(1024),
    marke: 1,
  },
};

const folge = (anzahl: number) => Array.from({ length: anzahl }, (_, i) => bild(i));

beforeEach(() => {
  netzlaeufe = 0;
  tippLaeufe = 0;
  tiefeLaeufe = 0;
  sitzungenAuf = 0;
  sitzungenZu = 0;
});

describe('folgeTeile', () => {
  it('gibt für jedes Bild eine Zuordnung zurück', async () => {
    const { jeBild } = await folgeTeile(folge(6), { teile: [NETZ], schluesselAbstand: 4 });
    expect(jeBild).toHaveLength(6);
    for (const karte of jeBild) expect(karte.get('n1')?.werte.length).toBe(1024);
  });

  it('lässt die Modelle nur auf den Schlüsselbildern laufen', async () => {
    /*
     * Der ganze Grund für dieses Modul. Neun Bilder bei Abstand vier sind
     * drei Läufe (0, 4 und das letzte) statt neun – bei der Tiefe also
     * siebeneinhalb Sekunden statt zweiundzwanzig.
     */
    const { laeufe } = await folgeTeile(folge(9), { teile: [NETZ], schluesselAbstand: 4 });
    expect(laeufe).toBe(3);
    expect(netzlaeufe).toBe(3);
  });

  it('rechnet mehrere Teile im selben Durchgang', async () => {
    // Drei Teile heissen drei Modelle je Schlüsselbild – aber nur EINEN
    // Durchgang durch die Bilder und eine Bewegungsschätzung.
    await folgeTeile(folge(5), { teile: [NETZ, TIEFE, TIPP], schluesselAbstand: 4 });
    expect(netzlaeufe).toBe(2);
    expect(tiefeLaeufe).toBe(2);
    expect(tippLaeufe).toBe(2);
  });

  it('öffnet die Tiefensitzung EINMAL und schliesst sie wieder', async () => {
    /*
     * Die Sitzung kostet gemessen 0,8 s zum Öffnen und 230 MB. Je Bild neu
     * wären das bei fünfzig Bildern vierzig verschenkte Sekunden – und
     * fünfzig Mal 230 MB, die der Einsammler hinterherräumen muss.
     */
    await folgeTeile(folge(12), { teile: [TIEFE], schluesselAbstand: 4 });
    expect(sitzungenAuf).toBe(1);
    expect(sitzungenZu).toBe(1);
  });

  it('öffnet gar keine Sitzung, wenn keine Tiefe gebraucht wird', async () => {
    // 27 MB Modell für ein Dokument ohne Tiefenteil wären reine Wartezeit.
    await folgeTeile(folge(6), { teile: [NETZ], schluesselAbstand: 4 });
    expect(sitzungenAuf).toBe(0);
  });

  it('schliesst die Sitzung auch nach einem Abbruch', async () => {
    const steuerung = new AbortController();
    const versprechen = folgeTeile(folge(20), {
      teile: [TIEFE],
      schluesselAbstand: 4,
      fortschritt: (anteil) => {
        if (anteil > 0.2) steuerung.abort();
      },
      abbruch: steuerung.signal,
    });
    await expect(versprechen).rejects.toBeInstanceOf(TeileAbbruch);
    expect(sitzungenZu).toBe(1);
  });

  it('glättet die Maske, aber NICHT die Tiefenkarte', async () => {
    /*
     * Bei einer Maske nimmt das Mitteln über drei Bilder das Flimmern an der
     * Kante heraus. Eine Tiefenkarte besteht dagegen überall aus
     * Zwischenwerten; über drei Bilder gemittelt zöge sie jede bewegte Kante
     * zu einem Verlauf auseinander, und die Unschärfe bekäme an jeder
     * Silhouette einen Hof.
     *
     * Der Ersatz liefert für die Tiefe immer dasselbe Muster – kommt es
     * unverändert zurück, wurde nicht geglättet.
     */
    const { jeBild } = await folgeTeile(folge(6), {
      teile: [TIEFE],
      schluesselAbstand: 1,
    });
    const erwartet = Array.from({ length: 1024 }, (_, i) => (i * 7) % 256);
    expect(Array.from(jeBild[2].get('d1')?.werte ?? [])).toEqual(erwartet);
  });

  it('schiebt zwischen den Schlüsselbildern, statt neu zu rechnen', async () => {
    /*
     * Geprüft am Schwerpunkt: Der Block sitzt links, das Bild wandert nach
     * rechts, also muss der Block mitwandern. Bliebe er stehen, wäre der
     * ganze Umweg über `verfolgung.ts` wirkungslos – und das sähe man am
     * fertigen Film als Maske, die hinter dem Motiv zurückbleibt.
     */
    const { jeBild } = await folgeTeile(folge(8), { teile: [NETZ], schluesselAbstand: 8 });
    const mitte = (werte: Uint8Array) => {
      let sx = 0;
      let summe = 0;
      for (let i = 0; i < werte.length; i += 1) {
        sx += (i % 32) * werte[i];
        summe += werte[i];
      }
      return summe === 0 ? -1 : sx / summe;
    };
    const erste = mitte(jeBild[0].get('n1')?.werte ?? new Uint8Array());
    const spaeter = mitte(jeBild[5].get('n1')?.werte ?? new Uint8Array());
    expect(spaeter).toBeGreaterThan(erste);
  });

  it('kommt ohne Teile und ohne Bilder zurecht', async () => {
    expect((await folgeTeile([], { teile: [NETZ], schluesselAbstand: 4 })).jeBild).toEqual([]);
    const ohne = await folgeTeile(folge(3), { teile: [], schluesselAbstand: 4 });
    expect(ohne.laeufe).toBe(0);
    expect(ohne.jeBild).toHaveLength(3);
    expect(netzlaeufe).toBe(0);
  });

  it('bricht ab, bevor irgendein Modell anläuft', async () => {
    await expect(
      folgeTeile(folge(6), { teile: [TIEFE], schluesselAbstand: 4, abbruch: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(AbbruchError);
    expect(sitzungenAuf).toBe(0);
  });
});
