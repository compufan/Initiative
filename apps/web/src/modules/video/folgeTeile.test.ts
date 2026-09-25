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
 * Wenn `drift` an ist, liefert das Ersatznetz bei jedem Aufruf einen Block,
 * der ein Stück weiter rechts liegt – so lässt sich prüfen, was zwischen
 * zwei verschiedenen Schlüsselmasken steht.
 */
let drift = false;
let driftAufruf = 0;
const DRIFT_SCHRITT = 5;
// Für die Verschwinde-Prüfung unten: die Aufrufnummern (1-indiziert), bei
// denen der Tipp nichts findet – das angetippte Ding ist gerade nicht da.
let tippNichtsBei = new Set<number>();
// Für die Anker-Prüfung unten: mit welchen Punkten der Tipp bei jedem Lauf
// tatsächlich aufgerufen wurde – zeigt, welche Lage wirklich gezogen hat.
let tippAufrufPunkte: { x: number; y: number }[][] = [];

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
  tippTeilRechnen: async (bild: ImageData, punkte: { x: number; y: number }[]) => {
    tippLaeufe += 1;
    tippAufrufPunkte.push(punkte);
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
/** Der waagrechte Schwerpunkt einer Maske auf 128 × 128. */
function mitte(werte: Uint8Array | undefined): number {
  if (!werte) return -1;
  let sx = 0;
  let summe = 0;
  for (let i = 0; i < werte.length; i += 1) {
    sx += (i % 128) * werte[i];
    summe += werte[i];
  }
  return summe === 0 ? -1 : sx / summe;
}

beforeEach(() => {
  netzlaeufe = 0;
  tippLaeufe = 0;
  tiefeLaeufe = 0;
  sitzungenAuf = 0;
  sitzungenZu = 0;
  drift = false;
  driftAufruf = 0;
  tippNichtsBei = new Set();
  tippAufrufPunkte = [];
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

  it('meldet auch beim Zusammensetzen noch Fortschritt – der Balken steht nicht voll, solange gerechnet wird', async () => {
    const anteile: number[] = [];
    await folgeTeile(folge(9), {
      teile: [NETZ, TIPP],
      schluesselAbstand: 4,
      fortschritt: (anteil) => anteile.push(anteil),
    });
    // Die letzte Meldung ist die volle – und davor stand sie noch nicht dort.
    expect(anteile.at(-1)).toBe(1);
    expect(anteile.filter((a) => a >= 1)).toHaveLength(1);
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

  it('überblendet zwischen den Schlüsselbildern, statt neu zu rechnen', async () => {
    /*
     * Zwei Schlüsselbilder (0 und 7), dazwischen sechs Bilder ohne
     * Modellauf. Das Ersatznetz liefert beim zweiten Aufruf einen um fünf
     * Punkte versetzten Block – die Zwischenbilder müssen von der einen
     * Lage zur anderen wandern, und zwar stetig, nicht in einem Sprung.
     */
    drift = true;
    // Ab dem zweiten Versatz, damit der Block nicht am Bildrand klebt – dort
    // sagt sein Schwerpunkt nichts über seine Lage.
    driftAufruf = 2;
    const { jeBild } = await folgeTeile(stillstand(8), { teile: [NETZ], schluesselAbstand: 8 });
    expect(netzlaeufe).toBe(2);
    const mitten = jeBild.map((karte) => mitte(karte.get('n1')?.werte));
    expect(mitten[0]).toBeCloseTo(25.5, 0);
    expect(mitten[7]).toBeCloseTo(30.5, 0);
    for (let i = 1; i < 8; i += 1) expect(mitten[i]).toBeGreaterThanOrEqual(mitten[i - 1] - 0.01);
    expect(mitten[4]).toBeGreaterThan(26.5);
    expect(mitten[4]).toBeLessThan(29.5);
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

  it('meldet beim Abbruch, wie weit es WIRKLICH war – auch hinter dem ersten Schnitt', async () => {
    /*
     * Die Spur des ersten Stücks ist längst fertig, die des zweiten bei
     * Bild 28. Vorher hielt die fertige Spur die Meldung bei ihrem Ende
     * fest – 20 statt 29 –, und das Angebot „aus den fertigen Bildern einen
     * Film machen" fiel entsprechend zu kurz aus.
     */
    const steuerung = new AbortController();
    const versprechen = folgeTeile(folge(40), {
      teile: [NETZ],
      schluesselAbstand: 4,
      schnitte: [20],
      fortschritt: () => {
        if (netzlaeufe >= 9) steuerung.abort();
      },
      abbruch: steuerung.signal,
    });
    const fehler = await versprechen.catch((f: unknown) => f);
    expect(fehler).toBeInstanceOf(TeileAbbruch);
    expect((fehler as TeileAbbruch).fertig).toBeGreaterThan(20);
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
    // Leer am ersten Bild – höchstens der Nachbar schimmert über das
    // Glätten herein, eine volle Maske steht dort nicht.
    const erste = jeBild[0].get('t1')?.werte ?? new Uint8Array(0);
    expect(Math.max(...erste)).toBeLessThanOrEqual(64);
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

describe('folgeTeile mit Abschnitten', () => {
  const tippBei = (x: number, y: number, id = 't1'): InhaltsTeil => ({
    ...TIPP,
    teil: TIPP.teil.art === 'tipp' ? { ...TIPP.teil, id, punkte: [{ x, y }] } : TIPP.teil,
  });

  it('setzt am Stellbild eines Abschnitts an und verfolgt von dort in beide Richtungen', async () => {
    /*
     * Sechs Bilder mit echter Bewegung (`folge`, drei Punkte je Bild nach
     * rechts). Eingestellt wurde an Bild 3: Dort gelten die Punkte genau so,
     * wie sie angetippt wurden. Von dort geht es rückwärts (2, 0) und dann
     * vorwärts (4, 5), und die Punkte wandern mit dem Muster.
     *
     * Das Ersatzmodell liefert eine volle Maske; der Gegenstand ist damit
     * das ganze Bild, und sein Weg ist der des Musters.
     */
    await folgeTeile(folge(6), {
      abschnitte: [{ von: 0, bis: 5, anker: 3, teile: [tippBei(64, 64)] }],
      schluesselAbstand: 2,
    });
    expect(tippAufrufPunkte.map((p) => Math.round(p[0].x))).toEqual([64, 61, 55, 67, 70]);
    for (const punkte of tippAufrufPunkte) expect(punkte[0].y).toBeCloseTo(64, 0);
  });

  it('setzt ohne Abschnitte am Anfang jedes Stücks an – wie bisher', async () => {
    await folgeTeile(folge(6), { teile: [TIPP], schluesselAbstand: 2 });
    expect(tippAufrufPunkte).toHaveLength(4);
    expect(tippAufrufPunkte[0]).toEqual([{ x: 4, y: 4 }]);
  });

  it('hält zwei Abschnitte mit derselben Teilkennung auseinander', async () => {
    /*
     * So entsteht es beim Teilen: Beide Hälften tragen dasselbe Teil mit
     * derselben Kennung, aber jede ihr eigenes Stellbild. Jede Hälfte
     * bekommt ihre eigene Folge, und keine überschreibt die der anderen.
     */
    const { jeBild } = await folgeTeile(folge(6), {
      abschnitte: [
        { von: 0, bis: 2, anker: 0, teile: [tippBei(20, 64)] },
        { von: 3, bis: 5, anker: 5, teile: [tippBei(100, 64)] },
      ],
      schluesselAbstand: 2,
    });
    for (const karte of jeBild) expect(karte.get('t1')?.werte.length).toBe(128 * 128);
    // Der zweite Abschnitt fängt an SEINEM Stellbild an, dem letzten Bild.
    const erste = tippAufrufPunkte.findIndex((p) => p[0].x === 100);
    expect(erste).toBeGreaterThan(0);
  });

  it('lässt die Bilder eines Abschnitts ohne Teile leer', async () => {
    const { jeBild } = await folgeTeile(folge(6), {
      abschnitte: [
        { von: 0, bis: 2, anker: 0, teile: [NETZ] },
        { von: 3, bis: 5, anker: 3, teile: [] },
      ],
      schluesselAbstand: 2,
    });
    expect(jeBild[1].has('n1')).toBe(true);
    expect(jeBild[4].size).toBe(0);
  });

  it('teilt einen Abschnitt, der über einen Schnitt reicht, an dieser Stelle', async () => {
    const { jeBild } = await folgeTeile(folge(6), {
      abschnitte: [{ von: 0, bis: 5, anker: 4, teile: [TIEFE] }],
      schluesselAbstand: 4,
      schnitte: [3],
    });
    for (const karte of jeBild) expect(karte.has('d1')).toBe(true);
  });
});

describe('folgeTeile gegen Drift', () => {
  it('lässt die Maske nicht unbegrenzt wegdriften, obwohl das Video stillsteht', async () => {
    /*
     * Das Video steht still, aber das Modell liegt bei jedem Schlüsselbild
     * fünf Punkte weiter rechts. Jeder Schritt für sich ist unauffällig (84 %
     * Deckung mit dem vorigen); nach elf Schritten läge der Block ohne
     * Gegenwehr ein Drittel des Bildes weiter. Die Suche im Bild sieht aber
     * keine Bewegung – und die aufsummierte Abweichung davon ist es, die
     * irgendwann nicht mehr gilt.
     */
    drift = true;
    const { jeBild, verworfen } = await folgeTeile(stillstand(12), {
      teile: [NETZ],
      schluesselAbstand: 1,
    });
    const erste = mitte(jeBild[0].get('n1')?.werte);
    const letzte = mitte(jeBild[11].get('n1')?.werte);
    expect(verworfen).toBeGreaterThan(0);
    expect(Math.abs(letzte - erste)).toBeLessThan(20);
  });
});
