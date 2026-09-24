import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError, NichtsGefunden } from '../stickers/engines/index.js';
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
/*
 * Für die Drift-Prüfung unten: Wenn `drift` an ist, wandert der gelieferte
 * Block bei jedem Aufruf ein Stück nach rechts – nicht weil sich das Motiv
 * bewegt (die Bilder sind identisch), sondern weil das Modell selbst bei
 * jedem Lauf ein wenig danebenliegt. Genau dieses Verhalten hat den
 * gemeldeten Fehler ausgelöst: Das Video stand still, die Maske wanderte.
 */
let drift = false;
let driftAufruf = 0;
const DRIFT_SCHRITT = 5;
// Für die Verschwinde-Prüfung unten: die Aufrufnummern (1-indiziert), bei
// denen der Tipp nichts findet – das angetippte Ding ist gerade nicht da.
let tippNichtsBei = new Set<number>();

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
      const versatz = drift ? driftAufruf * DRIFT_SCHRITT : 0;
      if (drift) driftAufruf += 1;
      // Ein Block links – etwas, das sich schieben lässt (oder, im
      // Driftfall, ein Block, der bei jedem Aufruf weiter rechts liegt).
      const breiteViertel = anfrage.image.width / 4;
      for (let y = 0; y < anfrage.image.height; y += 1) {
        for (let x = versatz; x < versatz + breiteViertel && x < anfrage.image.width; x += 1)
          maske[y * anfrage.image.width + x] = 255;
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
    if (tippNichtsBei.has(tippLaeufe)) {
      throw new NichtsGefunden('An dieser Stelle wurde nichts gefunden.', 'tippen');
    }
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

/*
 * 128 und nicht mehr 32.
 *
 * `lageSchaetzen` verlangt mindestens fünf sichere Blöcke, sonst gibt es die
 * Ruhe zurück – aus vier Punkten lässt sich zwar rechnen, aber nichts
 * glauben. Bei 32 Punkten Kante und Blöcken von 24 gibt es nur vier Blöcke
 * überhaupt, und die Prüfung prüfte damit nur noch, dass nichts geschieht.
 */
function bild(nummer: number, kante = 128): GelesenesBild {
  const daten = new Uint8ClampedArray(kante * kante * 4);
  for (let y = 0; y < kante; y += 1) {
    for (let x = 0; x < kante; x += 1) {
      const at = (y * kante + x) * 4;
      const wert = 128 + 90 * Math.sin((x - nummer * 3) / 3.7) * Math.cos(y / 5.3);
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
    breite: 128,
    hoehe: 128,
    alpha: new Uint8Array(128 * 128),
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
    breite: 128,
    hoehe: 128,
    karte: new Uint8Array(128 * 128),
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
    breite: 128,
    hoehe: 128,
    alpha: new Uint8Array(128 * 128),
    marke: 1,
  },
};

const folge = (anzahl: number) => Array.from({ length: anzahl }, (_, i) => bild(i));
// Lauter identische Bilder – ein Video, das wirklich stillsteht, statt eins,
// dessen Inhalt sich (wie bei `folge`) von Bild zu Bild verschiebt.
const stillstand = (anzahl: number) => Array.from({ length: anzahl }, () => bild(0));

beforeEach(() => {
  netzlaeufe = 0;
  tippLaeufe = 0;
  tiefeLaeufe = 0;
  sitzungenAuf = 0;
  sitzungenZu = 0;
  drift = false;
  driftAufruf = 0;
  tippNichtsBei = new Set();
});

describe('folgeTeile', () => {
  it('gibt für jedes Bild eine Zuordnung zurück', async () => {
    const { jeBild } = await folgeTeile(folge(6), { teile: [NETZ], schluesselAbstand: 4 });
    expect(jeBild).toHaveLength(6);
    for (const karte of jeBild) expect(karte.get('n1')?.werte.length).toBe(128 * 128);
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
    const erwartet = Array.from({ length: 128 * 128 }, (_, i) => (i * 7) % 256);
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
        sx += (i % 128) * werte[i];
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

describe('folgeTeile an einer Schnittkante', () => {
  it('rechnet die Maske an der Kante frisch, statt sie über den Schnitt zu ziehen', async () => {
    /*
     * Ohne die Schnittstellen wäre Bild 4 ein gewöhnliches Zwischenbild: Es
     * bekäme die Maske des letzten Schlüsselbildes, geschoben um eine
     * Bewegung, die zwischen zwei völlig verschiedenen Szenen geschätzt
     * wurde. Mit dem Schnitt ist es selbst ein Schlüsselbild.
     */
    const { laeufe } = await folgeTeile(folge(8), {
      teile: [NETZ],
      schluesselAbstand: 4,
      schnitte: [4],
    });
    const ohne = netzlaeufe;
    netzlaeufe = 0;
    const gleich = await folgeTeile(folge(8), { teile: [NETZ], schluesselAbstand: 4 });
    expect(laeufe).toBeGreaterThanOrEqual(gleich.laeufe);
    // An der Kante kommt ein Schlüsselbild dazu: das letzte des alten Stücks.
    expect(ohne).toBeGreaterThan(netzlaeufe);
  });

  it('trägt die Lage nicht über den Schnitt hinweg', async () => {
    // Die Lage jedes Bildes ist auf das ERSTE bezogen und summiert sich auf.
    // An einer Kante muss sie neu bei der Ruhe anfangen, sonst wandert der
    // Unfug von dort durch den ganzen Rest.
    const { lagen } = await folgeTeile(folge(8), {
      teile: [NETZ],
      schluesselAbstand: 4,
      schnitte: [4],
    });
    expect(lagen).toHaveLength(8);
    expect(lagen[4]).toEqual({ s: 1, w: 0, tx: 0, ty: 0, sicher: 0 });
  });

  it('kommt ohne Schnittangabe genauso durch wie bisher', async () => {
    const { jeBild } = await folgeTeile(folge(6), { teile: [NETZ], schluesselAbstand: 4 });
    expect(jeBild).toHaveLength(6);
  });
});

describe('folgeTeile bei einem Modell, das bei jedem Aufruf ein Stück danebenliegt', () => {
  const mitte = (werte: Uint8Array | undefined) => {
    if (!werte) return -1;
    let sx = 0;
    let summe = 0;
    for (let i = 0; i < werte.length; i += 1) {
      sx += (i % 128) * werte[i];
      summe += werte[i];
    }
    return summe === 0 ? -1 : sx / summe;
  };

  it('lässt die Maske nicht unbegrenzt wegdriften, obwohl das Video stillsteht', async () => {
    /*
     * Der gemeldete Fehler: Das Video steht still (`stillstand` – jedes Bild
     * ist dasselbe, `lagen[i]` bleibt also `LAGE_RUHE`), aber die Maske
     * wandert trotzdem, weil das Erkennungsmodell bei jedem Schlüsselbild ein
     * kleines Stück danebenliegt. Verglichen mit dem VORIGEN Schlüsselbild
     * ist jeder einzelne Schritt (5 von 32 Bildpunkten, 84 % Deckung) für
     * sich genommen unauffällig – nach elf Schlüsselbildern läge der Block
     * bei 55 Bildpunkten Versatz, ein Drittel des Bildes weiter rechts, ohne
     * dass eine einzige Prüfung angeschlagen hätte.
     *
     * Verglichen mit dem STÜCKANFANG (dem Fix) reisst die Deckung dagegen ab
     * 23 Bildpunkten Versatz unter 30 % – die Prüfung verwirft ab da JEDEN
     * weiteren Lauf und hält an der ursprünglichen Stelle fest, weil
     * `erwartet` immer wieder aus genau derselben Vorlage gezogen wird.
     */
    drift = true;
    const { jeBild, lagen, verworfen } = await folgeTeile(stillstand(12), {
      teile: [NETZ],
      schluesselAbstand: 1,
    });

    // Die Grundannahme des Tests: Ein Video ohne echte Bewegung liefert auch
    // keine – sonst könnte auch das Nachziehen den Versatz erklären.
    for (const lage of lagen) expect(lage).toEqual({ s: 1, w: 0, tx: 0, ty: 0, sicher: 0 });

    const erste = mitte(jeBild[0].get('n1')?.werte);
    const letzte = mitte(jeBild[11].get('n1')?.werte);

    // Die Prüfung muss tatsächlich angeschlagen haben – sonst bewiese der
    // Test nur, dass nichts geprüft wurde.
    expect(verworfen).toBeGreaterThan(0);
    // Gebunden an die Vorlage, nicht am halben Bild vorbei: Ohne den Fix
    // läge `letzte` bei rund 70 (55 Versatz + 15,5 Blockmitte).
    expect(Math.abs(letzte - erste)).toBeLessThan(20);
  });
});

describe('folgeTeile, wenn ein angetipptes Objekt verschwindet', () => {
  it('bricht nicht ab, wenn der Tipp von Anfang an nichts trägt', async () => {
    /*
     * Am allerersten Schlüsselbild gibt es noch keine Vorlage, gegen die
     * `maskePasst` prüfen könnte (`erwartet` ist `null`) – eine leere Maske
     * geht hier also unverändert durch. Vor dem Fix hätte `tippTeilRechnen`
     * hier `NichtsGefunden` geworfen, und nichts in `folgeTeile` fing das
     * ab: der ganze Filmbau wäre abgebrochen, nur weil das angetippte Ding
     * im allerersten Bild nicht (mehr) zu finden war.
     */
    tippNichtsBei = new Set([1]);
    const { jeBild } = await folgeTeile(folge(4), { teile: [TIPP], schluesselAbstand: 2 });
    expect(Array.from(jeBild[0].get('t1')?.werte ?? [])).toEqual(new Array(128 * 128).fill(0));
  });

  it('bricht den Filmbau nicht ab, wenn das Objekt mittendrin verschwindet und später wiederkehrt', async () => {
    // Acht Bilder, Abstand zwei: Schlüsselbilder bei 0, 2, 4, 6 und 7 (das
    // letzte immer) – fünf Tipp-Läufe. Der dritte (Bild 4) findet nichts.
    tippNichtsBei = new Set([3]);
    const { jeBild, verworfen } = await folgeTeile(folge(8), {
      teile: [TIPP],
      schluesselAbstand: 2,
    });
    // Jedes Bild bekommt weiterhin eine vollständige, richtig grosse Maske –
    // kein Loch, kein Rest eines abgebrochenen Laufs. Vor dem Fix wäre die
    // Zusicherung oben (`await folgeTeile(...)`) schon mit `NichtsGefunden`
    // fehlgeschlagen, statt hierher zu kommen.
    for (const karte of jeBild) expect(karte.get('t1')?.werte.length).toBe(128 * 128);
    // Die leere Kandidatin an Bild 4 hat eine Vorlage (Bild 0 trägt voll) und
    // fällt damit durch `maskePasst` – genau die Prüfung, die eine Maske
    // schützt, die nur kurz und fälschlich als leer gemeldet wurde.
    expect(verworfen).toBeGreaterThan(0);
  });
});
