import { afterEach, describe, expect, it } from 'vitest';

import { BEREICH_NEUTRAL, type Maskenteil } from '../bild/doc.js';
import { EngineError } from '../stickers/engines/index.js';
import { filmMarke } from './bildweise.js';
import type { Lesung, LeseOptionen } from './leserDienst.js';
import { ankerFuer, bildDocAn, maskenUmrastern, type Maske, type SpurTeil } from './masken.js';
import type { FensterLeser } from './maskenVerfolgen.js';
import { bildIndex } from './raster.js';
import type { Abschnitt } from './schnitt.js';
import { Verfolger, type Fensterprotokoll, type VerfolgerOptionen } from './verfolger.js';
import { graustufen } from './verfolgung.js';

/**
 * Der Verfolger: was er wann rechnet, was er dabei liest, wann er fertig
 * ist.
 *
 * Mit einem Ersatzleser, der Bilder aus einer Formel malt, und einem
 * Ersatzmodell, das mitzählt. Die Szene: gemusterter Grund, eine helle
 * Scheibe, die wandert. Das Modell liefert genau die Scheibe – geprüft wird
 * die Planung, nicht die Qualität.
 */

const S = 40;
const B = 96;
const H = 64;
const R = 8;
const wo = (k: number) => ({ x: 16 + 0.8 * k, y: 32 });

function malen(k: number): ImageData {
  const data = new Uint8ClampedArray(B * H * 4);
  const m = wo(k);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) {
      let g = 128 + 50 * Math.sin(x / 4.3 + Math.cos(y / 5.1)) * Math.cos(y / 3.7 - x / 9);
      if ((x - m.x) ** 2 + (y - m.y) ** 2 <= R * R) {
        g = 220 + 30 * Math.sin((x - m.x) / 2) * Math.cos((y - m.y) / 3);
      }
      const at = (y * B + x) * 4;
      data[at] = g;
      data[at + 1] = g;
      data[at + 2] = g;
      data[at + 3] = 255;
    }
  }
  return { data, width: B, height: H, colorSpace: 'srgb' } as ImageData;
}

function scheibe(k: number): Uint8Array {
  const maske = new Uint8Array(B * H);
  const m = wo(k);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1)
      if ((x - m.x) ** 2 + (y - m.y) ** 2 <= R * R) maske[y * B + x] = 255;
  }
  return maske;
}

class Ersatzleser implements FensterLeser {
  readonly gelesen: number[] = [];
  async holen(ms: number, _prio: string, optionen: LeseOptionen = {}): Promise<Lesung> {
    const k = bildIndex(ms, S);
    this.gelesen.push(k);
    const bild = malen(k);
    return { voll: optionen.voll ? bild : null, grau: optionen.grau ? graustufen(bild) : null };
  }
}

/** Das Ersatzmodell: die Scheibe, an dem Bild, das es bekommt. */
function modell(fehler?: string) {
  const aufrufe: { teil: string; k: number }[] = [];
  const rechnen: NonNullable<VerfolgerOptionen['rechnen']> = async (teil, bild) => {
    if (fehler) throw new EngineError(fehler, 'object');
    // Welches Bild? Die Scheibe steht im roten Kanal – hier genügt die Zeit des Lesers nicht.
    const k = kVonBild(bild);
    aufrufe.push({ teil: teil.id, k });
    return scheibe(k);
  };
  return { aufrufe, rechnen };
}

/** Das Bild erkennt man an der Lage der Scheibe: ihr hellster Punkt in Zeile 32. */
function kVonBild(bild: ImageData): number {
  let summe = 0;
  let zahl = 0;
  for (let x = 0; x < B; x += 1) {
    if (bild.data[(32 * B + x) * 4] >= 190) {
      summe += x;
      zahl += 1;
    }
  }
  return Math.round((summe / zahl - 16) / 0.8);
}

function netz(k: number, welches: 'person' | 'object' = 'person'): Maskenteil {
  return {
    id: `n${filmMarke()}`,
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz: welches,
    breite: B,
    hoehe: H,
    alpha: scheibe(k),
    marke: filmMarke(),
  };
}

function tiefe(): Maskenteil {
  return {
    id: `d${filmMarke()}`,
    modus: 'dazu',
    umkehren: false,
    art: 'tiefe',
    breite: 42,
    hoehe: 28,
    karte: new Uint8Array(42 * 28),
    fokus: 1,
    spanne: 0.5,
    marke: filmMarke(),
  };
}

function radial(): Maskenteil {
  return {
    id: `r${filmMarke()}`,
    modus: 'dazu',
    umkehren: false,
    art: 'radial',
    mitte: { x: 40, y: 30 },
    rx: 10,
    ry: 10,
    winkel: 0,
    weichheit: 0.3,
  };
}

function spur(id: string, k: number, teil: Maskenteil): SpurTeil {
  return { id, anker: [ankerFuer(k, teil)] };
}

function maske(id: string, teile: SpurTeil[], aktiv = true): Maske {
  return {
    id,
    name: id,
    aktiv,
    anpassung: BEREICH_NEUTRAL,
    geltung: { art: 'ganz' },
    farbe: 0,
    teile,
  };
}

function abschnitt(id: string, vonK: number, bisK: number): Abschnitt {
  return { id, vonMs: vonK * S, bisMs: bisK * S, doc: null, standMs: (vonK + 0.5) * S };
}

const offen: Verfolger[] = [];
function verfolger(mehr: Partial<VerfolgerOptionen> = {}) {
  const leser = new Ersatzleser();
  const m = modell();
  const protokoll: Fensterprotokoll[] = [];
  const v = new Verfolger({
    leser,
    s: S,
    mass: { b: B, h: H },
    rechnen: m.rechnen,
    entprellMs: 0,
    weiterMs: 0,
    meldenMs: 0,
    protokoll: (eintrag) => protokoll.push(eintrag),
    ...mehr,
  });
  offen.push(v);
  return { v, leser, modell: m, protokoll };
}

const schlafen = (ms: number) => new Promise((weiter) => setTimeout(weiter, ms));

afterEach(() => {
  for (const v of offen.splice(0)) v.schliessen();
});

describe('Verfolger – was zuerst dran ist', () => {
  const EINER = [abschnitt('a', 0, 60)];

  it('rechnet eingeschaltete Masken vor abgeschalteten', async () => {
    const { v, protokoll } = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    const b = maske('B', [spur('tb', 40, netz(40))], false);
    v.setzen([b, a], EINER);
    await v.spurenFertig();
    expect(protokoll[0].masken).toEqual(['A']);
    // Die abgeschaltete kommt danach trotzdem dran – nur nicht zuerst.
    for (const eintrag of protokoll.slice(0, 2)) expect(eintrag.masken).toEqual(['A']);
    await schlafen(0);
  });

  it('zieht vor, was am Kopf fehlt – auch eine abgeschaltete Maske', async () => {
    const { v, protokoll } = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    const b = maske('B', [spur('tb', 40, netz(40))], false);
    v.setzen([a, b], EINER);
    v.vorziehen(55);
    await v.spurenFertig();
    for (let i = 0; i < 200 && protokoll.every((e) => !e.masken.includes('B')); i += 1)
      await schlafen(5);
    // Beiden fehlt Bild 55; B setzt bei 40 an und ist näher.
    expect(protokoll[0].masken).toEqual(['B']);
    expect(protokoll[0].richtung).toBe('vor');
  });

  it('beendet ein laufendes Fenster am nächsten Schlüsselbild, wenn anderswo etwas fehlt', async () => {
    let v: Verfolger | null = null;
    const m = modell();
    let gesprungen = false;
    const r = verfolger({
      rechnen: async (teil, bild, punkte, abbruch) => {
        const maskeHier = await m.rechnen(teil, bild, punkte, abbruch);
        if (!gesprungen && m.aufrufe.length === 2) {
          gesprungen = true;
          v?.vorziehen(10);
        }
        return maskeHier;
      },
    });
    v = r.v;
    const a = maske('A', [spur('ta', 30, netz(30))]);
    v.setzen([a], EINER);
    await v.spurenFertig();
    // Das erste Fenster lief vorwärts von 30 – und endete, als Bild 10 gebraucht wurde.
    expect(r.protokoll[0].richtung).toBe('vor');
    expect(r.protokoll[1].richtung).toBe('rueck');
    const vorwaerts = r.protokoll.filter((e) => e.richtung === 'vor');
    expect(vorwaerts.length).toBeGreaterThan(1);
  });
});

describe('Verfolger – was er NICHT neu rechnet', () => {
  it('liest nach Teilen, Kürzen und Umstellen nichts neu – und beim Verlängern nur das Neue', async () => {
    const { v, leser } = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    v.setzen([a], [abschnitt('a', 0, 60)]);
    await v.spurenFertig();
    const gelesen = leser.gelesen.length;
    expect(v.zaehler.lesen).toBe(gelesen);

    v.setzen([a], [abschnitt('a', 0, 30), abschnitt('b', 30, 60)]);
    await v.spurenFertig();
    v.setzen([a], [abschnitt('a', 0, 45)]);
    await v.spurenFertig();
    v.setzen([a], [abschnitt('b', 30, 60), abschnitt('a', 0, 30)]);
    await v.spurenFertig();
    await schlafen(20);
    expect(leser.gelesen.length).toBe(gelesen);

    v.setzen([a], [abschnitt('a', 0, 70)]);
    await v.spurenFertig();
    const neu = leser.gelesen.slice(gelesen);
    expect(new Set(neu)).toEqual(new Set(Array.from({ length: 10 }, (_, i) => 60 + i)));
  });

  it('rechnet nach einem Bildratenwechsel alles neu', async () => {
    const eins = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    eins.v.setzen([a], [abschnitt('a', 0, 30)]);
    await eins.v.spurenFertig();
    expect(eins.v.zaehler.lesen).toBeGreaterThan(0);
    // Neue Bildrate: ein neuer Verfolger (der Lead legt ihn an), die Anker umgerastert.
    const s2 = 1000 / 30;
    const zwei = verfolger({ s: s2 });
    const [a2] = maskenUmrastern([a], S, s2);
    zwei.v.setzen([a2], [{ ...abschnitt('a', 0, 30), vonMs: 0, bisMs: 36 * s2 }]);
    await zwei.v.spurenFertig();
    expect(zwei.v.zaehler.lesen).toBeGreaterThan(30);
  });

  it('macht aus drei schnellen Tipps EINEN Auftrag', async () => {
    const { v, protokoll } = verfolger({ entprellMs: 600 });
    const erster = spur('t', 10, netz(10));
    const zweiter = spur('t', 10, netz(10));
    const dritter = spur('t', 10, netz(10));
    const film = [abschnitt('a', 0, 30)];
    v.setzen([maske('A', [erster])], film);
    await schlafen(150);
    v.setzen([maske('A', [zweiter])], film);
    await schlafen(150);
    v.setzen([maske('A', [dritter])], film);
    await v.spurenFertig();
    const ketten = new Set(protokoll.map((e) => e.kette.split('|')[0]));
    expect(ketten).toEqual(new Set([dritter.anker[0].id]));
  });

  it('füllt eine frühere Brücke mit einem Lückenlauf – ohne die alten Modelläufe', async () => {
    const { v, modell: m } = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    v.setzen([a], [abschnitt('a', 0, 10), abschnitt('b', 40, 50)]);
    await v.spurenFertig();
    const anker = a.teile[0].anker[0];
    expect(v.kette(anker, 'vor', 25).stand).toBe('offen');
    const vorher = m.aufrufe.length;
    v.setzen([a], [abschnitt('a', 0, 10), abschnitt('c', 20, 30), abschnitt('b', 40, 50)]);
    await v.spurenFertig();
    for (let k = 20; k < 30; k += 1)
      expect(v.kette(anker, 'vor', k).stand, `Bild ${k}`).toBe('fein');
    // Neu gerechnet wird nur an den neuen Schlüsselbildern – die alten kommen aus dem Netzvorrat.
    const neu = m.aufrufe.slice(vorher).map((a) => a.k);
    for (const k of neu) expect(k >= 20 && k < 30, `Modell an ${k}`).toBe(true);
  });
});

describe('Verfolger – fertig und nicht fertig', () => {
  it('erfüllt spurenFertig erst, wenn alles fein ist – nach dem Grobpass', async () => {
    const { v, protokoll } = verfolger();
    const a = maske('A', [spur('ta', 0, netz(0, 'object'))]);
    v.setzen([a], [abschnitt('a', 0, 60)]);
    const anteile: number[] = [];
    await v.spurenFertig(undefined, (anteil) => anteile.push(anteil));
    const anker = a.teile[0].anker[0];
    for (let k = 1; k < 60; k += 1)
      expect(v.kette(anker, 'vor', k).stand, `Bild ${k}`).toBe('fein');
    expect(protokoll[0].pass).toBe('grob');
    expect(protokoll.some((e) => e.pass === 'fein')).toBe(true);
    // Und der Filmbau kann jedes Bild zusammensetzen, ohne zu werfen.
    const rahmen = { abschnitte: [abschnitt('a', 0, 60)], s: S, b: B, h: H };
    for (let k = 0; k < 60; k += 1)
      expect(() => bildDocAn(null, [a], v, k, 'bild', rahmen)).not.toThrow();
    expect(v.stand().jeMaske.get('A')?.anteil ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('scheitert mit dem Fehler einer Kette – aber nicht an einer abgeschalteten Maske', async () => {
    const kaputt = modell('Das Modell ist abgeschaltet.');
    const { v } = verfolger({ rechnen: kaputt.rechnen });
    const a = maske('A', [spur('ta', 0, netz(0, 'object'))]);
    v.setzen([a], [abschnitt('a', 0, 20)]);
    await expect(v.spurenFertig()).rejects.toThrow(
      "Die Maske ‚A' liess sich nicht verfolgen: Das Modell ist abgeschaltet.",
    );
    await schlafen(5);
    expect(v.stand().jeMaske.get('A')?.fehler).toBe('Das Modell ist abgeschaltet.');

    const zwei = verfolger({ rechnen: kaputt.rechnen });
    zwei.v.setzen([maske('B', [spur('tb', 0, netz(0, 'object'))], false)], [abschnitt('a', 0, 20)]);
    await expect(zwei.v.spurenFertig()).resolves.toBeUndefined();
  });

  it('nennt hinter einem Szenenschnitt „verloren" – Person setzt dort neu an', async () => {
    const { v } = verfolger();
    const motiv = maske('M', [spur('tm', 0, netz(0, 'object'))]);
    const person = maske('P', [spur('tp', 0, netz(0, 'person'))]);
    const film = [abschnitt('a', 0, 10), abschnitt('b', 100, 110)];
    v.setzen([motiv, person], film);
    await v.spurenFertig();
    expect(v.kette(motiv.teile[0].anker[0], 'vor', 105).stand).toBe('verloren');
    expect(v.kette(person.teile[0].anker[0], 'vor', 105).stand).toBe('fein');
  });

  it('teilt die Tiefenkarten zwischen zwei Masken', async () => {
    let karten = 0;
    const { v } = verfolger({
      tiefeRechnen: async () => {
        karten += 1;
        return { breite: 42, hoehe: 28, werte: new Uint8Array(42 * 28).fill(99) };
      },
    });
    const eins = maske('T1', [spur('d1', 3, tiefe())]);
    const zwei = maske('T2', [spur('d2', 7, tiefe())]);
    v.setzen([eins, zwei], [abschnitt('a', 0, 24)]);
    await v.spurenFertig();
    // Schlüsselbilder 0, 4, … 20 – einmal, nicht zweimal.
    expect(karten).toBe(6);
    for (let k = 0; k < 24; k += 1) {
      const bild = v.tiefe(k);
      expect(bild.stand, `Bild ${k}`).toBe('fein');
      if (bild.stand !== 'offen') expect(bild.daten.breite).toBe(B);
    }
  });

  it('rechnet für eine reine Formmaske den Kamerapfad', async () => {
    const { v } = verfolger();
    const form = maske('F', [spur('f', 12, radial())]);
    v.setzen([form], [abschnitt('a', 0, 30)]);
    await v.spurenFertig();
    for (let k = 0; k < 30; k += 1) expect(v.lage(12, k).stand, `Bild ${k}`).toBe('fein');
    expect(v.zaehler.laeufe).toBe(0);
  });

  it('meldet den Stand über `abonnieren` – und derselbe Stand bleibt dasselbe Objekt', async () => {
    const { v } = verfolger({ meldenMs: 30 });
    let meldungen = 0;
    const ab = v.abonnieren(() => {
      meldungen += 1;
    });
    const a = maske('A', [spur('ta', 0, netz(0))]);
    v.setzen([a], [abschnitt('a', 0, 40)]);
    await v.spurenFertig();
    await schlafen(60);
    const stand = v.stand();
    expect(v.stand()).toBe(stand);
    expect(meldungen).toBeGreaterThan(0);
    expect(stand.jeMaske.get('A')?.anteil).toBe(1);
    expect(stand.jeMaske.get('A')?.laeuft).toBe(false);
    ab();
  });
});
