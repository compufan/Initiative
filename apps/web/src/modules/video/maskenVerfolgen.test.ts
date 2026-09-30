import { describe, expect, it } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import type { Lesung, LeseOptionen } from './leserDienst.js';
import { kettenPlan, type Lauf } from './masken.js';
import {
  fensterRechnen,
  inhaltFensterSuchen,
  kameraFensterSuchen,
  tiefeBereit,
  tiefenFensterSuchen,
  tiefenLaeufe,
  type FensterLeser,
  type InhaltsFenster,
  type Tor,
  type Umgebung,
} from './maskenVerfolgen.js';
import { bildIndex } from './raster.js';
import { rleDekodieren } from './rle.js';
import { Kette, SPUR_BUDGET, Vorrat } from './spurVorrat.js';
import { graustufen, punktZurueck } from './verfolgung.js';

/**
 * Ein Fenster der Verfolgung, mit einem Ersatzleser, der Bilder aus einer
 * Formel malt, und einem Ersatzmodell, das mitzählt.
 *
 * Die Szene: gemusterter, ruhender Grund, eine helle gemusterte Scheibe, die
 * einen Punkt je Bild nach rechts wandert. Das Ersatzmodell liefert genau
 * diese Scheibe – geprüft wird, was dieses Modul entscheidet: was gelesen
 * wird, wann ein Modell läuft, was abgelegt wird, und wo es weitergeht.
 */

const S = 40;
const B = 96;
const H = 64;
const R = 8;
const wo = (k: number) => ({ x: 20 + k, y: 32 });

function grund(x: number, y: number): number {
  return 128 + 50 * Math.sin(x / 4.3 + Math.cos(y / 5.1)) * Math.cos(y / 3.7 - x / 9);
}

function malen(k: number, schwenk = 0): ImageData {
  const data = new Uint8ClampedArray(B * H * 4);
  const m = wo(k);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) {
      let g = grund(x + schwenk * k, y);
      if (schwenk === 0 && (x - m.x) ** 2 + (y - m.y) ** 2 <= R * R) {
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

function scheibe(k: number, r = R): Uint8Array {
  const maske = new Uint8Array(B * H);
  const m = wo(k);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1)
      if ((x - m.x) ** 2 + (y - m.y) ** 2 <= r * r) maske[y * B + x] = 255;
  }
  return maske;
}

class Ersatzleser implements FensterLeser {
  readonly gelesen: number[] = [];
  readonly voll: number[] = [];
  constructor(private readonly schwenk = 0) {}
  async holen(ms: number, _prio: string, optionen: LeseOptionen = {}): Promise<Lesung> {
    const k = bildIndex(ms, S);
    this.gelesen.push(k);
    if (optionen.voll) this.voll.push(k);
    const bild = malen(k, this.schwenk);
    return {
      voll: optionen.voll ? bild : null,
      grau: optionen.grau ? graustufen(bild) : null,
    };
  }
}

/** `wechselnd`: jedes zweite Schlüsselbild eine etwas grössere Scheibe – wie ein Modell, das an der Kante schwankt. */
function modell(wechselnd = false) {
  const aufrufe: number[] = [];
  return {
    aufrufe,
    rechnen: async (k: number) => {
      aufrufe.push(k);
      return scheibe(k, wechselnd && k % 8 === 0 ? R + 2 : R);
    },
  };
}

const bis = (von: number, bisEinschl: number) =>
  Array.from({ length: bisEinschl - von + 1 }, (_, i) => von + i);

function umgebung(leser: FensterLeser, vorrat: Vorrat, mehr: Partial<Umgebung> = {}): Umgebung {
  return { leser, vorrat, s: S, b: B, h: H, luft: async () => {}, ...mehr };
}

/** Alle Fenster eines Laufs nacheinander, wie der Verfolger sie wählt. */
async function laufRechnen(
  lauf: Lauf,
  kette: Kette,
  u: Umgebung,
  rechnen: InhaltsFenster['rechnen'],
  groesse: number,
  pass: 'grob' | 'fein' = 'fein',
): Promise<number> {
  let fenster = 0;
  for (;;) {
    const plan = inhaltFensterSuchen(lauf, pass, 'vor', kette, groesse);
    if (!plan) return fenster;
    fenster += 1;
    await fensterRechnen(
      {
        art: 'inhalt',
        kette,
        richtung: 'vor',
        pass,
        pfad: plan.pfad,
        ziele: new Set(lauf.ziele),
        schluessel: new Set(pass === 'grob' ? lauf.grob : lauf.schluessel),
        laufStart: lauf.start,
        start: plan.rand
          ? { art: 'rand', zustand: plan.rand }
          : { art: 'anker', maske: scheibe(lauf.start), punkte: null },
        tipp: false,
        brauchtBild: () => true,
        rechnen,
      },
      u,
    );
  }
}

function planVor(ziele: number[], fenster: number, kGrob?: number): Lauf {
  const plan = kettenPlan({
    anker: 0,
    ziele,
    K: 4,
    fenster,
    jenseits: 'verloren',
    ...(kGrob ? { kGrob } : {}),
  });
  return plan.vor.laeufe[0];
}

describe('Ein Fenster für Inhalt', () => {
  it('liest aufsteigend, auch rückwärts – und rechnet nur an Schlüsselbildern', async () => {
    const leser = new Ersatzleser();
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const kette = vorrat.kette('k', 40);
    const m = modell();
    const ergebnis = await fensterRechnen(
      {
        art: 'inhalt',
        kette,
        richtung: 'rueck',
        pass: 'fein',
        pfad: bis(20, 40).reverse(),
        ziele: new Set(bis(20, 39)),
        schluessel: new Set([36, 32, 28, 24, 20]),
        laufStart: 40,
        start: { art: 'anker', maske: scheibe(40), punkte: null },
        tipp: false,
        brauchtBild: () => true,
        rechnen: m.rechnen,
      },
      umgebung(leser, vorrat),
    );
    expect(leser.gelesen).toEqual(bis(20, 40));
    // Am Anker nicht: Dort gilt die Maske, die der Anwender gesehen hat.
    expect(leser.voll).toEqual([20, 24, 28, 32, 36]);
    expect([...m.aufrufe].sort((a, b) => a - b)).toEqual([20, 24, 28, 32, 36]);
    expect(ergebnis).toEqual({ bis: 20, unterbrochen: false, gespeichert: 20 });
    for (const k of bis(20, 39)) expect(kette.bild(k), `Bild ${k}`).toBeDefined();
    expect(kette.bild(40)).toBeUndefined();
    // Die Maske sitzt auf der Scheibe – geglättet, aber am richtigen Ort.
    const bild = kette.bild(26);
    expect(bild && !bild.verloren && bild.meta.mx).toBeCloseTo(wo(26).x, 0);
    expect(kette.rand('rueck', 'fein', 20)?.k).toBe(20);
  });

  it('ruft über einer Brücke nie ein Modell und legt dort nichts ab', async () => {
    const leser = new Ersatzleser();
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const kette = vorrat.kette('k', 0);
    const m = modell();
    const lauf = planVor([...bis(0, 9), ...bis(30, 39)], 16);
    await laufRechnen(lauf, kette, umgebung(leser, vorrat), m.rechnen, 16);
    const schluessel = new Set(lauf.schluessel);
    for (const k of m.aufrufe) {
      expect(schluessel.has(k), `Modell an ${k}`).toBe(true);
      expect(k < 10 || k >= 30, `Modell an ${k}`).toBe(true);
    }
    for (const k of bis(10, 29)) expect(kette.bild(k), `Brücke ${k}`).toBeUndefined();
    for (const k of lauf.ziele) expect(kette.bild(k), `Ziel ${k}`).toBeDefined();
    // Gelesen wird die Brücke aber – die Spur sucht den Gegenstand Bild für Bild.
    expect(new Set(leser.gelesen)).toEqual(new Set(bis(0, 39)));
  });

  it('lässt nach einem Abbruch mitten im Fenster den Rand, wie er war', async () => {
    const lauf = planVor(bis(0, 40), 16);
    // Zum Vergleich ohne Abbruch.
    const vergleich = new Vorrat(SPUR_BUDGET, B * H).kette('k', 0);
    await laufRechnen(
      lauf,
      vergleich,
      umgebung(new Ersatzleser(), new Vorrat(SPUR_BUDGET, B * H)),
      modell().rechnen,
      16,
    );

    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const kette = vorrat.kette('k', 0);
    const leser = new Ersatzleser();
    const m = modell();
    const erstes = inhaltFensterSuchen(lauf, 'fein', 'vor', kette, 16);
    expect(erstes?.pfad.at(-1)).toBe(16);
    await laufRechnen(
      { ...lauf, ziele: lauf.ziele.filter((k) => k <= 16) },
      kette,
      umgebung(leser, vorrat),
      m.rechnen,
      16,
    );
    const zweites = inhaltFensterSuchen(lauf, 'fein', 'vor', kette, 16);
    expect(zweites?.rand?.k).toBe(16);
    if (!zweites?.rand) throw new Error('Kein Rand nach dem ersten Fenster');
    const randZustand = zweites.rand;
    const steuer = new AbortController();
    let aufrufe = 0;
    const abbrechend: InhaltsFenster['rechnen'] = async (k) => {
      aufrufe += 1;
      if (aufrufe === 2) steuer.abort();
      return scheibe(k);
    };
    const versprechen = fensterRechnen(
      {
        art: 'inhalt',
        kette,
        richtung: 'vor',
        pass: 'fein',
        pfad: zweites.pfad,
        ziele: new Set(lauf.ziele),
        schluessel: new Set(lauf.schluessel),
        laufStart: 0,
        start: { art: 'rand', zustand: randZustand },
        tipp: false,
        brauchtBild: () => true,
        rechnen: abbrechend,
      },
      umgebung(leser, vorrat, { abbruch: steuer.signal }),
    );
    await expect(versprechen).rejects.toBeInstanceOf(AbbruchError);
    // Nichts vom abgebrochenen Fenster ist abgelegt – der Rand ist noch der alte.
    for (const k of bis(17, 40)) expect(kette.bild(k)).toBeUndefined();
    expect(inhaltFensterSuchen(lauf, 'fein', 'vor', kette, 16)?.rand?.k).toBe(16);

    // Weiter ab demselben Rand: dasselbe Ergebnis wie ohne Abbruch.
    await laufRechnen(lauf, kette, umgebung(leser, vorrat), m.rechnen, 16);
    for (const k of lauf.ziele) {
      const a = kette.bild(k);
      const b = vergleich.bild(k);
      expect(a && !a.verloren && Array.from(a.rle), `Bild ${k}`).toEqual(
        b && !b.verloren && Array.from(b.rle),
      );
    }
  });

  it('liest nichts, solange das Tor zu ist', async () => {
    const leser = new Ersatzleser();
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    let oeffnen: () => void = () => {};
    let zu = true;
    const tor: Tor = {
      offen: () =>
        zu
          ? new Promise<void>((weiter) => {
              oeffnen = () => {
                zu = false;
                weiter();
              };
            })
          : Promise.resolve(),
    };
    const lauf = planVor(bis(0, 12), 16);
    const fertig = laufRechnen(
      lauf,
      vorrat.kette('k', 0),
      umgebung(leser, vorrat, { tor }),
      modell().rechnen,
      16,
    );
    for (let i = 0; i < 20; i += 1) await new Promise((weiter) => setTimeout(weiter, 0));
    expect(leser.gelesen).toEqual([]);
    oeffnen();
    await fertig;
    expect(leser.gelesen.length).toBeGreaterThan(0);
  });

  it('glättet das Randbild neu, sobald sein Nachbar im nächsten Fenster bekannt ist', async () => {
    /*
     * Am Ende eines Fensters hat das letzte Bild nur einen Nachbarn. Das
     * nächste Fenster glättet es mit beiden neu und legt es noch einmal ab –
     * danach unterscheidet sich die Folge in Fenstern von der am Stück nur
     * um die Rundung der Lauflängen (höchstens zwei Stufen).
     */
    const lauf = planVor(bis(0, 40), 16);
    const amStueck = new Vorrat(SPUR_BUDGET, B * H).kette('k', 0);
    await laufRechnen(
      lauf,
      amStueck,
      umgebung(new Ersatzleser(), new Vorrat(SPUR_BUDGET, B * H)),
      modell(true).rechnen,
      1000,
    );

    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const kette = vorrat.kette('k', 0);
    const u = umgebung(new Ersatzleser(), vorrat);
    const erstes = { ...lauf, ziele: lauf.ziele.filter((k) => k <= 16) };
    await laufRechnen(erstes, kette, u, modell(true).rechnen, 16);
    const vorNaht = kette.bild(16);
    await laufRechnen(lauf, kette, u, modell(true).rechnen, 16);
    const nachNaht = kette.bild(16);
    expect(vorNaht && !vorNaht.verloren && nachNaht && !nachNaht.verloren).toBe(true);
    if (!vorNaht || vorNaht.verloren || !nachNaht || nachNaht.verloren) return;
    expect(nachNaht.marke).not.toBe(vorNaht.marke);
    expect(Array.from(nachNaht.rle)).not.toEqual(Array.from(vorNaht.rle));
    for (const k of lauf.ziele) {
      const a = kette.bild(k);
      const b = amStueck.bild(k);
      if (!a || a.verloren || !b || b.verloren) throw new Error(`Bild ${k} fehlt`);
      const ma = rleDekodieren(a.rle, B * H);
      const mb = rleDekodieren(b.rle, B * H);
      let groesste = 0;
      for (let i = 0; i < ma.length; i += 1) groesste = Math.max(groesste, Math.abs(ma[i] - mb[i]));
      expect(groesste, `Bild ${k}`).toBeLessThanOrEqual(2);
    }
  });

  it('rechnet im Grobpass nur an den groben Schlüsselbildern, und der Feinpass überschreibt', async () => {
    const leser = new Ersatzleser();
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const kette = vorrat.kette('k', 0);
    const lauf = planVor(bis(0, 40), 20, 12);
    const grob = modell();
    await laufRechnen(lauf, kette, umgebung(leser, vorrat), grob.rechnen, 20, 'grob');
    const grobeSchluessel = new Set(lauf.grob);
    for (const k of grob.aufrufe) expect(grobeSchluessel.has(k), `grob an ${k}`).toBe(true);
    expect(grob.aufrufe.length).toBeLessThan(lauf.schluessel.length);
    for (const k of lauf.ziele) expect(kette.bild(k)?.guete).toBe('grob');
    const fein = modell();
    await laufRechnen(lauf, kette, umgebung(leser, vorrat), fein.rechnen, 20, 'fein');
    for (const k of lauf.ziele) expect(kette.bild(k)?.guete).toBe('fein');
  });
});

describe('Kamera und Tiefe', () => {
  it('rechnet für eine Formmaske nur Graustufen und Kameraschritte', async () => {
    const leser = new Ersatzleser(2);
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const lauf = planVor(bis(0, 24), 16);
    let fenster = 0;
    for (;;) {
      const pfad = kameraFensterSuchen(lauf, vorrat.kamera, 16);
      if (!pfad) break;
      fenster += 1;
      await fensterRechnen({ art: 'kamera', pfad }, umgebung(leser, vorrat));
      expect(fenster).toBeLessThan(10);
    }
    expect(leser.voll).toEqual([]);
    const lage = vorrat.kamera.lage(0, 24);
    expect(lage).not.toBeNull();
    // Der Grund wandert zwei Punkte je Bild nach links: Bild 24 liegt in Bild 0 um 48 weiter rechts.
    const p = punktZurueck(lage ?? { s: 1, w: 0, tx: 0, ty: 0, sicher: 0 }, 1, 40, 30);
    expect(Math.abs(p.x - 88)).toBeLessThan(1.5);
  });

  it('rechnet Tiefenkarten nur an den Schlüsselbildern des Rasters, in Graugrösse', async () => {
    const leser = new Ersatzleser(1);
    const vorrat = new Vorrat(SPUR_BUDGET, B * H);
    const karten: number[] = [];
    const tiefeRechnen = async (k: number) => {
      karten.push(k);
      return { breite: 42, hoehe: 28, werte: new Uint8Array(42 * 28).fill(k) };
    };
    const ziele = [...bis(5, 14), ...bis(30, 33)];
    const laeufe = tiefenLaeufe(ziele, 4);
    expect(laeufe.map((l) => [l.pfad[0], l.pfad.at(-1)])).toEqual([
      [4, 14],
      [28, 33],
    ]);
    for (;;) {
      const fenster = tiefenFensterSuchen(laeufe, 4, vorrat, 16);
      if (!fenster) break;
      await fensterRechnen({ art: 'tiefe', ...fenster, tiefeRechnen }, umgebung(leser, vorrat));
    }
    expect(karten.sort((a, b) => a - b)).toEqual([4, 8, 12, 28, 32]);
    for (const k of ziele) expect(tiefeBereit(k, 4, vorrat), `Bild ${k}`).toBe(true);
    const karte = vorrat.tiefe.holen(8);
    expect(karte?.daten.breite).toBe(B);
    expect(karte?.daten.hoehe).toBe(H);
    expect(karte?.daten.werte[0]).toBe(8);
    // Gelesen voll nur an den Schlüsselbildern.
    expect(leser.voll.sort((a, b) => a - b)).toEqual([4, 8, 12, 28, 32]);
  });
});
