import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import { ABSCHNITT_TITEL, BauAbbruch, gifAusVideo, type Abschnitt } from './gifBauen.js';
import type { GueteInfo } from './einstellungen.js';

/**
 * Der ganze Weg vom Video zum GIF – ohne Video und ohne Netz.
 *
 * Beides ist hier ersetzt, und zwar mit Absicht: Ob `currentTime` das richtige
 * Bild trifft, entscheidet der Browser (`e2e/videoGif.spec.ts`), und ob u2netp
 * eine Katze findet, entscheidet u2netp. Was dieses Modul entscheidet, ist die
 * Reihenfolge, der Balken und der Abbruch – und genau das steht hier.
 */

const KANTE = 32;
let netzlaeufe = 0;
let leseAbbruchNach: number | null = null;

vi.mock('../stickers/engines/index.js', async () => {
  const echt = await vi.importActual<typeof import('../stickers/engines/index.js')>(
    '../stickers/engines/index.js',
  );
  return {
    ...echt,
    runEngine: async (_key: string, anfrage: { image: ImageData }) => {
      netzlaeufe += 1;
      await Promise.resolve();
      // Die linke Hälfte bleibt, die rechte fällt weg – daran lässt sich
      // ablesen, ob die Maske überhaupt angelegt wurde.
      const maske = new Uint8Array(anfrage.image.width * anfrage.image.height);
      for (let y = 0; y < anfrage.image.height; y += 1) {
        for (let x = 0; x < anfrage.image.width / 2; x += 1) {
          maske[y * anfrage.image.width + x] = 255;
        }
      }
      return maske;
    },
  };
});

vi.mock('./bilderLesen.js', async () => {
  const echt = await vi.importActual<typeof import('./bilderLesen.js')>('./bilderLesen.js');
  return {
    ...echt,
    videoBilderLesen: async (
      _datei: Blob,
      auftrag: {
        zeitpunkte: readonly number[];
        fortschritt?: (anteil: number, text: string) => void;
        abbruch?: AbortSignal;
      },
    ) => {
      const bilder = [];
      for (let i = 0; i < auftrag.zeitpunkte.length; i += 1) {
        if (auftrag.abbruch?.aborted || leseAbbruchNach === i) {
          throw new echt.LeseAbbruch(bilder);
        }
        const daten = new Uint8ClampedArray(KANTE * KANTE * 4);
        for (let p = 0; p < KANTE * KANTE; p += 1) {
          daten[p * 4] = (p + i * 13) & 0xff;
          daten[p * 4 + 1] = (p * 3 + i) & 0xff;
          daten[p * 4 + 2] = (p ^ i) & 0xff;
          daten[p * 4 + 3] = 255;
        }
        bilder.push({
          zeitMs: auftrag.zeitpunkte[i],
          daten: { data: daten, width: KANTE, height: KANTE, colorSpace: 'srgb' } as ImageData,
        });
        auftrag.fortschritt?.((i + 1) / auftrag.zeitpunkte.length, `Bild ${i + 1}`);
      }
      return { bilder, breite: KANTE, hoehe: KANTE, dauerMs: 3000 };
    },
  };
});

const GUETE: GueteInfo = {
  key: 'genau',
  titel: 'Genau',
  beschreibung: 'Prüfung',
  netz: 'object',
  schluesselAbstand: 4,
  kante: KANTE,
  jeNetzlaufMs: 1600,
  brauchtGrafik: false,
};

function auftrag(mehr: Partial<Parameters<typeof gifAusVideo>[0]> = {}) {
  return {
    datei: new Blob(),
    vonMs: 0,
    bisMs: 800,
    bildrate: 10,
    guete: GUETE,
    freistellen: true,
    ...mehr,
  };
}

beforeEach(() => {
  netzlaeufe = 0;
  leseAbbruchNach = null;
});

describe('gifAusVideo', () => {
  it('liefert eine Datei, die sich als GIF ausweist', async () => {
    const ergebnis = await gifAusVideo(auftrag());
    expect(ergebnis.blob.type).toBe('image/gif');
    const kopf = new Uint8Array(await ergebnis.blob.arrayBuffer()).subarray(0, 6);
    expect(String.fromCharCode(...kopf)).toBe('GIF89a');
  });

  it('rechnet die Laufzeit aus Bildzahl und Standzeit', async () => {
    // Acht Bilder à 100 ms sind 800 ms – dieselbe Zeit, die gewählt wurde.
    const ergebnis = await gifAusVideo(auftrag());
    expect(ergebnis.bilder).toBe(8);
    expect(ergebnis.laufzeitMs).toBe(800);
  });

  it('legt die Maske wirklich an', async () => {
    /*
     * Der Ersatz lässt die linke Hälfte stehen und nimmt die rechte weg. Im
     * GIF muss sich das als durchsichtiger Tafelplatz wiederfinden – und
     * ohne Freistellen darf er FEHLEN.
     */
    const mit = await gifAusVideo(auftrag());
    const ohne = await gifAusVideo(auftrag({ freistellen: false }));
    expect(mit.blob.size).toBeLessThan(ohne.blob.size);
  });

  it('lässt das Netz aus, wenn nicht freigestellt wird', async () => {
    await gifAusVideo(auftrag({ freistellen: false }));
    expect(netzlaeufe).toBe(0);
  });

  it('zählt die Netzläufe und spart sie sich dank Schlüsselabstand', async () => {
    const ergebnis = await gifAusVideo(auftrag());
    // Acht Bilder bei Abstand vier: 0, 4 und das letzte (7).
    expect(ergebnis.netzlaeufe).toBe(3);
    expect(netzlaeufe).toBe(3);
  });

  it('meldet alle drei Abschnitte in der richtigen Reihenfolge', async () => {
    const gesehen: Abschnitt[] = [];
    await gifAusVideo(
      auftrag({
        fortschritt: (_anteil, abschnitt) => {
          if (gesehen.at(-1) !== abschnitt) gesehen.push(abschnitt);
        },
      }),
    );
    expect(gesehen).toEqual(['lesen', 'freistellen', 'schreiben']);
  });

  it('lässt den Balken nur vorwärts laufen und bis ganz nach rechts', async () => {
    /*
     * Ein Balken, der zurückspringt, sieht aus wie ein Fehler. Und einer, der
     * bei 80 % stehen bleibt und dann verschwindet, auch.
     */
    const anteile: number[] = [];
    await gifAusVideo(auftrag({ fortschritt: (anteil) => anteile.push(anteil) }));
    for (let i = 1; i < anteile.length; i += 1) {
      expect(anteile[i], `Schritt ${i}`).toBeGreaterThanOrEqual(anteile[i - 1]);
    }
    expect(anteile.at(-1)).toBeCloseTo(1, 5);
  });

  it('gewichtet die Abschnitte nach ihrer Dauer', async () => {
    /*
     * Bei „Genau" ist das Freistellen der mit Abstand teuerste Abschnitt.
     * Wäre der Balken in Drittel geteilt, stünde er dort minutenlang still –
     * und jeder hielte die App für hängengeblieben.
     */
    const grenzen = new Map<Abschnitt, number>();
    await gifAusVideo(
      auftrag({
        fortschritt: (anteil, abschnitt) => grenzen.set(abschnitt, anteil),
      }),
    );
    const nachLesen = grenzen.get('lesen') ?? 0;
    const nachFrei = grenzen.get('freistellen') ?? 0;
    expect(nachFrei - nachLesen).toBeGreaterThan(0.5);
  });

  it('bricht beim Lesen ab und sagt, wie weit es kam', async () => {
    /*
     * Die Zahl ist der Punkt: Damit lässt sich „Aus den ersten fünf Bildern
     * trotzdem ein GIF?" anbieten, statt die Arbeit wegzuwerfen.
     */
    leseAbbruchNach = 5;
    const ausfall = await gifAusVideo(auftrag()).catch((fehler: unknown) => fehler);
    expect(ausfall).toBeInstanceOf(BauAbbruch);
    expect(ausfall).toBeInstanceOf(AbbruchError);
    const bau = ausfall as BauAbbruch;
    expect(bau.abschnitt).toBe('lesen');
    expect(bau.fertigeBilder).toBe(5);
  });

  it('bricht beim Freistellen ab und behält die fertigen Masken', async () => {
    const steuerung = new AbortController();
    const versprechen = gifAusVideo(
      auftrag({
        abbruch: steuerung.signal,
        fortschritt: (_anteil, abschnitt) => {
          if (abschnitt === 'freistellen') steuerung.abort();
        },
      }),
    );
    const ausfall = (await versprechen.catch((fehler: unknown) => fehler)) as BauAbbruch;
    expect(ausfall).toBeInstanceOf(BauAbbruch);
    expect(ausfall.abschnitt).toBe('freistellen');
    expect(ausfall.fertigeBilder).toBeGreaterThan(0);
  });

  it('bricht ab, bevor irgendetwas anfängt', async () => {
    // Sonst liefe bei „Sehr genau" noch ein Download von 84 MB an.
    await expect(gifAusVideo(auftrag({ abbruch: AbortSignal.abort() }))).rejects.toBeInstanceOf(
      AbbruchError,
    );
    expect(netzlaeufe).toBe(0);
  });

  it('hält für jeden Abschnitt einen Titel bereit', async () => {
    // Der Balken zeigt ihn an; ein fehlender Titel wäre eine Lücke im Bild.
    for (const abschnitt of ['lesen', 'freistellen', 'schreiben'] as const) {
      expect(ABSCHNITT_TITEL[abschnitt].length, abschnitt).toBeGreaterThan(3);
    }
  });
});
