import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { BEREICH_NEUTRAL, type Maskenteil } from '../bild/doc.js';
import { AbbruchError, EngineError } from '../stickers/engines/index.js';
import { filmMarke } from './bildweise.js';
import type { Lesung, LeseOptionen } from './leserDienst.js';
import {
  BAHN,
  ankerFuer,
  bildDocAn,
  kettenSchluessel,
  maskenUmrastern,
  zustandAn,
  type Maske,
  type SpurTeil,
} from './masken.js';
import type { FensterLeser } from './maskenVerfolgen.js';
import { bildIndex } from './raster.js';
import { META_LEER } from './rle.js';
import type { Abschnitt } from './schnitt.js';
import type { Vorrat } from './spurVorrat.js';
import {
  SPEICHER_VOLL,
  Verfolger,
  type Fensterprotokoll,
  type VerfolgerOptionen,
} from './verfolger.js';
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

  it('zeigt nach einem neuen Anker die alte Kette als veraltet, bis die neue da ist', async () => {
    // Neue Anker warten 300 ms – so lange gibt es von ihnen sicher noch nichts.
    const { v } = verfolger({ entprellMs: 300 });
    const film = [abschnitt('a', 0, 30)];
    const alt = spur('t', 5, netz(5));
    v.setzen([maske('A', [alt])], film);
    await v.spurenFertig();
    const neu = spur('t', 5, netz(5));
    v.setzen([maske('A', [neu])], film);
    const bild = v.kette(neu.anker[0], 'vor', 20);
    expect(bild.stand).toBe('veraltet');
    const vorher = v.kette(alt.anker[0], 'vor', 20);
    if (bild.stand === 'veraltet' && vorher.stand === 'fein') expect(bild.marke).toBe(vorher.marke);
    expect(v.maske(neu.anker[0], 'vor', 20)).not.toBeNull();
    // Und der Filmbau wartet auf die neue.
    await v.spurenFertig();
    expect(v.kette(neu.anker[0], 'vor', 20).stand).toBe('fein');
  });

  it('lässt eine Form hinter einem Szenenschnitt vorläufig an ihrem Anker', async () => {
    const { v } = verfolger();
    const form = maske('F', [spur('f', 5, radial())]);
    v.setzen([form], [abschnitt('a', 0, 10), abschnitt('b', 100, 110)]);
    await v.spurenFertig();
    expect(v.lage(5, 8).stand).toBe('fein');
    expect(v.lage(5, 105).stand).toBe('vorlaeufig');
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

/* ---------- Nach der Gegenlesung ---------- */

/** Ein Tipp auf die Scheibe an Bild k – Antippen nach Farbe, ohne Netz. */
function tippTeil(k: number): Maskenteil {
  const m = wo(k);
  return {
    id: `t${filmMarke()}`,
    modus: 'dazu',
    umkehren: false,
    art: 'tipp',
    mitNetz: false,
    punkte: [{ x: m.x, y: m.y }],
    toleranz: 32,
    breite: B,
    hoehe: H,
    alpha: scheibe(k),
    marke: filmMarke(),
  };
}

/** Wartet, bis `bedingung` gilt – höchstens `ms`. */
async function bis(bedingung: () => boolean, ms = 3000): Promise<void> {
  const ende = Date.now() + ms;
  while (!bedingung() && Date.now() < ende) await schlafen(5);
}

/** Der Vorrat eines Verfolgers – für Prüfungen, die in den Speicher sehen. */
function vorratVon(v: Verfolger): Vorrat {
  return (v as unknown as { vorrat: Vorrat }).vorrat;
}

describe('Verfolger – Formen in Masken mit Inhalt', () => {
  it('rechnet das Ankerbild einer Form mit, auch wenn der Film es nicht mehr zeigt', async () => {
    // Inhalt bei 0, Ellipse bei 30 – der Film zeigt nur 0 … 19.
    const { v } = verfolger();
    const m = maske('M', [spur('t', 0, netz(0, 'object')), spur('r', 30, radial())]);
    const film = [abschnitt('a', 0, 20)];
    v.setzen([m], film);
    await v.spurenFertig();
    const rahmen = { abschnitte: film, s: S, b: B, h: H };
    for (let k = 0; k < 20; k += 1) {
      expect(() => bildDocAn(null, [m], v, k, 'bild', rahmen), `Bild ${k}`).not.toThrow();
      expect(bildDocAn(null, [m], v, k, 'editor', rahmen).fehlend, `Bild ${k}`).toEqual([]);
    }
  });

  it('bleibt fertig, wenn der Inhalt danach zwischen seinem Anker und dem der Form neu angetippt wird', async () => {
    const { v } = verfolger();
    const inhalt = spur('t', 0, netz(0, 'object'));
    const form = spur('r', 30, radial());
    const lang = [abschnitt('a', 0, 40)];
    v.setzen([maske('M', [inhalt, form])], lang);
    await v.spurenFertig();
    const kurz = [abschnitt('a', 0, 20)];
    // Nachgetippt bei 10: ein zweiter Anker im selben Teil.
    const zwei: SpurTeil = {
      id: 't',
      anker: [inhalt.anker[0], ankerFuer(10, netz(10, 'object'))],
    };
    const m = maske('M', [zwei, form]);
    v.setzen([m], kurz);
    await v.spurenFertig();
    const rahmen = { abschnitte: kurz, s: S, b: B, h: H };
    for (let k = 0; k < 20; k += 1) {
      expect(() => bildDocAn(null, [m], v, k, 'bild', rahmen), `Bild ${k}`).not.toThrow();
    }
  });
});

describe('Verfolger – eine Geltung, die schrumpft', () => {
  it('behält nach „Ab hier" hinter dem Anker, was schon gerechnet ist – ohne einen Modellauf', async () => {
    const { v, modell: m } = verfolger();
    const film = [abschnitt('a', 0, 120)];
    const a = maske('A', [spur('ta', 5, netz(5, 'object'))]);
    v.setzen([a], film);
    await v.spurenFertig();
    const anker = a.teile[0].anker[0];
    for (const k of [60, 80, 100]) expect(v.kette(anker, 'vor', k).stand).toBe('fein');
    const laeufe = m.aufrufe.length;
    const ab: Maske = { ...a, geltung: { art: 'stuecke', stuecke: [{ vonK: 60, bisK: 120 }] } };
    v.setzen([ab], film);
    await v.spurenFertig();
    for (const k of [60, 80, 100]) expect(v.kette(anker, 'vor', k).stand, `Bild ${k}`).toBe('fein');
    expect(m.aufrufe.length).toBe(laeufe);
    const rahmen = { abschnitte: film, s: S, b: B, h: H };
    const teil = bildDocAn(null, [ab], v, 100, 'bild', rahmen).doc.bereiche[0].teile[0];
    if (teil.art !== 'netz') throw new Error('kein Netzteil');
    expect(teil.alpha.some((wert) => wert > 0)).toBe(true);
  });
});

describe('Verfolger – ein Tipp, der hinausläuft', () => {
  it('ist danach leer, nicht verloren', async () => {
    // Die Scheibe wandert 0,8 Punkte je Bild nach rechts und ist ab Bild 111 ganz draussen.
    const { v } = verfolger();
    const film = [abschnitt('a', 100, 130)];
    const t = maske('T', [spur('tt', 100, tippTeil(100))]);
    v.setzen([t], film);
    await v.spurenFertig();
    const rahmen = { abschnitte: film, s: S, b: B, h: H };
    const anker = t.teile[0].anker[0];
    expect(v.kette(anker, 'vor', 125).stand).toBe('fein');
    expect(zustandAn(t, 125, null, v, rahmen)).toBe(BAHN.leer);
    expect(zustandAn(t, 101, null, v, rahmen)).toBe(BAHN.sichtbar);
  });
});

describe('Verfolger – veraltet nach vielen Nachbesserungen', () => {
  it('zeigt auch nach fünf schnellen Tipps die gerechnete Kette als veraltet', async () => {
    const { v } = verfolger({ entprellMs: 400 });
    const film = [abschnitt('a', 0, 30)];
    const alt = spur('t', 5, netz(5));
    v.setzen([maske('A', [alt])], film);
    await v.spurenFertig();
    let letzter = alt;
    for (let i = 0; i < 6; i += 1) {
      letzter = spur('t', 5, netz(5));
      v.setzen([maske('A', [letzter])], film);
    }
    expect(v.kette(letzter.anker[0], 'vor', 20).stand).toBe('veraltet');
    await v.spurenFertig();
    expect(v.kette(letzter.anker[0], 'vor', 20).stand).toBe('fein');
  });
});

describe('Verfolger – Speicher', () => {
  it('hält über dem Budget an – und ein Reglerschritt gibt nichts frei, erst freier Speicher', async () => {
    const budget = 3_000_000;
    const { v, protokoll } = verfolger({ budget });
    const film = [abschnitt('a', 0, 40)];
    const a = maske('A', [spur('ta', 0, netz(0))]);
    const b = maske('B', [spur('tb', 20, netz(20))]);
    // Die Kette von B ist schon riesig (etwa aus einer früheren Rechnung) – mit Arbeit übrig.
    const riesig = vorratVon(v).kette(kettenSchluessel(b.teile[0].anker[0], S, B, H, 4), 20);
    riesig.ablegen(39, {
      rle: new Uint8Array(budget + 100_000),
      meta: META_LEER,
      marke: filmMarke(),
      guete: 'grob',
    });
    v.setzen([a, b], film);
    await expect(v.spurenFertig()).rejects.toThrow(SPEICHER_VOLL);
    const bytes = vorratVon(v).bytes;
    const fenster = protokoll.length;
    // Jeder Reglerschritt ruft `setzen` – das darf keiner angehaltenen Kette ein Fenster geben.
    for (let i = 0; i < 30; i += 1) {
      v.setzen([a, b], film);
      await schlafen(2);
    }
    await schlafen(50);
    expect(protokoll.length).toBe(fenster);
    expect(vorratVon(v).bytes).toBe(bytes);
    expect(v.stand().jeMaske.get('A')?.fehler).toBe(SPEICHER_VOLL);
    // B gelöscht: Ihre Kette ist ersetzt, wird verdrängt – und A rechnet weiter.
    v.setzen([a], film);
    await v.spurenFertig();
    expect(vorratVon(v).bytes).toBeLessThanOrEqual(budget);
    await bis(() => v.stand().jeMaske.get('A')?.fehler === undefined);
    expect(v.stand().jeMaske.get('A')?.fehler).toBeUndefined();
  });
});

describe('Verfolger – Tiefe nach einem Fehler', () => {
  it('rechnet für einen neuen Tiefenanker wieder – ein Aussetzer sperrt nicht für immer', async () => {
    let versuche = 0;
    const { v } = verfolger({
      tiefeRechnen: async () => {
        versuche += 1;
        if (versuche === 1) throw new Error('Netz kurz weg');
        return { breite: 42, hoehe: 28, werte: new Uint8Array(42 * 28).fill(99) };
      },
    });
    const film = [abschnitt('a', 0, 12)];
    const t1 = maske('T1', [spur('d1', 3, tiefe())]);
    v.setzen([t1], film);
    await expect(v.spurenFertig()).rejects.toThrow('Netz kurz weg');
    // Derselbe Anker: Der Fehler bleibt – kein stilles Wiederholen im Kreis.
    v.setzen([t1], film);
    await expect(v.spurenFertig()).rejects.toThrow('Netz kurz weg');
    expect(versuche).toBe(1);
    // Die Maske gelöscht, eine neue Tiefe angelegt: Sie wird gerechnet.
    v.setzen([], film);
    const neu = maske('T2', [spur('d2', 5, tiefe())]);
    v.setzen([neu], film);
    await v.spurenFertig();
    expect(versuche).toBeGreaterThan(1);
    expect(v.tiefe(7).stand).toBe('fein');
  });
});

describe('Verfolger – Tor, Filmbau, Unterbrechen', () => {
  it("rechnet während des Filmbaus nichts ('bauen') – auch keine abgeschaltete Maske", async () => {
    const { v, leser } = verfolger();
    const film = [abschnitt('a', 0, 60)];
    const an = maske('A', [spur('ta', 0, netz(0))]);
    const aus = maske('B', [spur('tb', 30, netz(30))], false);
    v.setzen([an, aus], film);
    await v.spurenFertig();
    v.verfolgungRuhen('bauen', true);
    await schlafen(30);
    const gelesen = leser.gelesen.length;
    await schlafen(200);
    expect(leser.gelesen.length).toBe(gelesen);
    v.verfolgungRuhen('bauen', false);
    await bis(() => leser.gelesen.length > gelesen);
    expect(leser.gelesen.length).toBeGreaterThan(gelesen);
  });

  it('bricht nach einer Pause am Tor ab, statt noch ein Schlüsselbild zu rechnen', async () => {
    let v: Verfolger | null = null;
    const m = modell();
    const aufrufe: string[] = [];
    let einmal = false;
    const r = verfolger({
      rechnen: async (teil, bild, punkte, abbruch) => {
        aufrufe.push(teil.id);
        const maskeHier = await m.rechnen(teil, bild, punkte, abbruch);
        if (!einmal && aufrufe.filter((id) => id === teil.id).length === 2) {
          einmal = true;
          // Der Anwender wischt, landet bei 55 und lässt los – während das Fenster am Tor wartet.
          v?.verfolgungRuhen('zug', true);
          setTimeout(() => {
            v?.vorziehen(55);
            setTimeout(() => v?.verfolgungRuhen('zug', false), 30);
          }, 30);
        }
        return maskeHier;
      },
    });
    v = r.v;
    const a = maske('A', [spur('ta', 0, netz(0))]);
    const b = maske('B', [spur('tb', 50, netz(50))]);
    v.setzen([a, b], [abschnitt('a', 0, 60)]);
    await v.spurenFertig();
    const idA = a.teile[0].anker[0].teil.id;
    const idB = b.teile[0].anker[0].teil.id;
    const nachPause = aufrufe.slice(aufrufe.findIndex((id, i) => id === idA && i > 0) + 1);
    // Der nächste Modellauf nach der Pause gehört B.
    expect(nachPause[0]).toBe(idB);
  });

  it('lernt die Restzeit ohne die Zeit am Tor', async () => {
    let v: Verfolger | null = null;
    let einmal = false;
    const m = modell();
    const r = verfolger({
      rechnen: async (teil, bild, punkte, abbruch) => {
        if (!einmal && m.aufrufe.length === 3) {
          einmal = true;
          v?.verfolgungRuhen('zug', true);
          setTimeout(() => v?.verfolgungRuhen('zug', false), 800);
        }
        return m.rechnen(teil, bild, punkte, abbruch);
      },
    });
    v = r.v;
    const a = maske('A', [spur('ta', 0, netz(0))]);
    v.setzen([a], [abschnitt('a', 0, 60)]);
    await v.spurenFertig();
    const kosten = (v as unknown as { kosten: Map<string, number> }).kosten.get('person|fein');
    // 800 ms Zug plus 500 ms Ruhe über rund 50 Bilder wären mehr als 25 ms je Bild.
    expect(kosten).toBeLessThan(15);
  });

  it('lässt ein wartendes spurenFertig beim Schliessen scheitern', async () => {
    const { v } = verfolger({ entprellMs: 5000 });
    v.setzen([maske('A', [spur('ta', 0, netz(0))])], [abschnitt('a', 0, 20)]);
    const warten = v.spurenFertig();
    v.schliessen();
    await expect(warten).rejects.toBeInstanceOf(AbbruchError);
  });

  it('wirft ein laufendes Fenster weg, wenn seine Kette verschwindet – und rechnet dafür nichts mehr', async () => {
    let v: Verfolger | null = null;
    const m = modell();
    const r = verfolger({
      rechnen: async (teil, bild, punkte, abbruch) => {
        if (m.aufrufe.length === 1) v?.setzen([], [abschnitt('a', 0, 60)]);
        await schlafen(5);
        return m.rechnen(teil, bild, punkte, abbruch);
      },
    });
    v = r.v;
    v.setzen([maske('A', [spur('ta', 0, netz(0))])], [abschnitt('a', 0, 60)]);
    await bis(() => m.aufrufe.length >= 2);
    await schlafen(100);
    expect(m.aufrufe.length).toBeLessThanOrEqual(3);
    expect(r.protokoll).toHaveLength(1);
  });
});

describe('Verfolger – React StrictMode', () => {
  const global = globalThis as unknown as { window?: { __verfolger?: unknown } };
  afterEach(() => {
    delete global.window;
  });

  it('hat vor dem ersten `setzen` keine Nebenwirkungen – und läuft nach `schliessen` wieder an', async () => {
    global.window = {};
    // Zwei Fabrikaufrufe, wie `useMemo` im StrictMode – React behält den ERSTEN.
    const erster = verfolger();
    const zweiter = verfolger();
    expect(global.window.__verfolger).toBeUndefined();
    const a = maske('A', [spur('ta', 0, netz(0))]);
    const film = [abschnitt('a', 0, 20)];
    erster.v.setzen([a], film);
    expect(global.window.__verfolger).toBe(erster.v.zaehler);
    // StrictMode: Aufräumen, dann der Effekt noch einmal.
    erster.v.schliessen();
    erster.v.setzen([a], film);
    await erster.v.spurenFertig();
    expect(erster.v.zaehler.lesen).toBeGreaterThan(0);
    expect(zweiter.v.zaehler.lesen).toBe(0);
    expect(global.window.__verfolger).toBe(erster.v.zaehler);
  });
});

describe('Verfolger – Seite verborgen, Bildschirmsperre, Verfahrenstreue', () => {
  const global = globalThis as unknown as {
    document?: EventTarget & { hidden: boolean; visibilityState: string };
    navigator: Navigator;
  };
  let wakeLock: PropertyDescriptor | undefined;
  afterEach(() => {
    delete global.document;
    if (wakeLock) Object.defineProperty(global.navigator, 'wakeLock', wakeLock);
    else delete (global.navigator as unknown as { wakeLock?: unknown }).wakeLock;
    wakeLock = undefined;
  });

  function seite(verborgen: boolean) {
    const ziel = new EventTarget() as EventTarget & { hidden: boolean; visibilityState: string };
    ziel.hidden = verborgen;
    ziel.visibilityState = verborgen ? 'hidden' : 'visible';
    global.document = ziel;
    return (jetzt: boolean) => {
      ziel.hidden = jetzt;
      ziel.visibilityState = jetzt ? 'hidden' : 'visible';
      ziel.dispatchEvent(new Event('visibilitychange'));
    };
  }

  it('ruht, solange die Seite verborgen ist – und meldet den Horcher beim Schliessen ab', async () => {
    const umschalten = seite(true);
    const { v, leser } = verfolger();
    v.setzen([maske('A', [spur('ta', 0, netz(0))])], [abschnitt('a', 0, 30)]);
    await schlafen(150);
    expect(leser.gelesen).toHaveLength(0);
    umschalten(false);
    await v.spurenFertig();
    expect(leser.gelesen.length).toBeGreaterThan(0);
    expect(getEventListeners(global.document as EventTarget, 'visibilitychange')).toHaveLength(1);
    v.schliessen();
    expect(getEventListeners(global.document as EventTarget, 'visibilitychange')).toHaveLength(0);
  });

  it('hält den Bildschirm wach, solange gerechnet wird, und gibt ihn beim Schliessen frei', async () => {
    seite(false);
    wakeLock = Object.getOwnPropertyDescriptor(global.navigator, 'wakeLock');
    let angefragt = 0;
    let frei = 0;
    Object.defineProperty(global.navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          angefragt += 1;
          const sperre = new EventTarget() as EventTarget & { release(): Promise<void> };
          sperre.release = async () => {
            frei += 1;
          };
          return sperre;
        },
      },
    });
    const { v } = verfolger();
    v.setzen([maske('A', [spur('ta', 0, netz(0))])], [abschnitt('a', 0, 30)]);
    await v.spurenFertig();
    expect(angefragt).toBe(1);
    expect(frei).toBe(0);
    v.schliessen();
    await schlafen(0);
    expect(frei).toBe(1);
  });

  it('bleibt beim selben Verfahren, solange ein anderes nicht deutlich näher liegt', async () => {
    // Person bei 0, Motiv bei 10: Nach dem ersten Fenster läge das Motiv näher an seinem
    // Anker – aber nicht um zwei Sekunden. Die Person rechnet weiter, statt dass das
    // Modell wechselt.
    const { v, protokoll } = verfolger();
    const person = maske('P', [spur('tp', 0, netz(0, 'person'))]);
    const motiv = maske('O', [spur('to', 10, netz(10, 'object'))]);
    v.setzen([person, motiv], [abschnitt('a', 0, 100)]);
    await v.spurenFertig();
    expect(protokoll[0].masken).toEqual(['P']);
    expect(protokoll[1].masken).toEqual(['P']);
    expect(protokoll.some((e) => e.masken.includes('O'))).toBe(true);
  });
});
