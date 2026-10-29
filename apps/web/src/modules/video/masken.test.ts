import { describe, expect, it } from 'vitest';

import { BEREICH_NEUTRAL, docKopie, neuesDoc, type BildDoc, type Maskenteil } from '../bild/doc.js';
import { filmMarke } from './bildweise.js';
import {
  BAHN,
  BRUECKE_MAX,
  Kompositspeicher,
  MASKEN_MAX,
  ankerEntfernen,
  ankerFuer,
  ankerKetten,
  bahnZustand,
  bereichePlatz,
  bereicheUmwandeln,
  bildDocAn,
  editorAenderung,
  feldArt,
  filmStandAn,
  geltungNachTeilen,
  geltungAbHier,
  geltungBisHier,
  geltungLeer,
  geltungNurAbschnitt,
  geltungStuecke,
  giltAn,
  grenzeVerletzt,
  griffLage,
  griffZiehen,
  hoechstJeBild,
  imFilm,
  jenseitsFuer,
  kettenAuftrag,
  kettenBedarf,
  kettenPlan,
  kettenSchluessel,
  maskeTrennen,
  maskenUmrastern,
  maskenZiele,
  sichtbarAn,
  stueckeNormal,
  stueckeOhne,
  stueckeSchnitt,
  teilUnterschied,
  zustandAn,
  zuvielAn,
  type Anker,
  type Geltung,
  type Gezeigt,
  type KettenAuftrag,
  type KettenBild,
  type LageAntwort,
  type Maske,
  type Rahmen,
  type Richtung,
  type SpurQuelle,
  type SpurTeil,
  type TiefenBild,
  type TippPunkte,
} from './masken.js';
import { filmRaster } from './raster.js';
import { metaMessen } from './rle.js';
import { abschnittKuerzen, abschnittTeilen, type Abschnitt } from './schnitt.js';

/**
 * Masken über den ganzen Film: Geltung, Ketten, Zusammensetzen, Bahnen und
 * der Weg vom Editor zurück.
 *
 * Alles ohne Video und ohne Modell. Die Verfolgung spielt ein Stapel Karten
 * (`Karten`): je Anker, Richtung und Bild eine Maske, von Hand gelegt. Das
 * ist Absicht – geprüft wird hier, was mit den Spuren GESCHIEHT, nicht wie
 * sie entstehen.
 */

/* ---------- Werkzeug ---------- */

const B = 40;
const H = 30;
const S = 40;

/** Eine harte Scheibe in 40 × 30. */
function scheibe(mx: number, my: number, r = 4): Uint8Array {
  const alpha = new Uint8Array(B * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) if (Math.hypot(x - mx, y - my) <= r) alpha[y * B + x] = 255;
  }
  return alpha;
}

function tipp(id: string, alpha: Uint8Array, punkte = [{ x: 9, y: 9 }], toleranz = 32): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'tipp',
    mitNetz: false,
    punkte,
    toleranz,
    breite: B,
    hoehe: H,
    alpha,
    marke: filmMarke(),
  };
}

function netz(id: string, alpha: Uint8Array, welches: 'person' | 'object' = 'object'): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz: welches,
    breite: B,
    hoehe: H,
    alpha,
    marke: filmMarke(),
  };
}

function radial(id: string, x: number, y: number, r = 3): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'radial',
    mitte: { x, y },
    rx: r,
    ry: r,
    winkel: 0,
    weichheit: 0.3,
  };
}

function pinsel(id: string, punkte: number[]): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'pinsel',
    striche: [{ punkte, breite: 2, haerte: 1, abziehen: false }],
  };
}

function verlauf(id: string): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'verlauf',
    von: { x: 0, y: 0 },
    bis: { x: 0, y: 30 },
  };
}

function spur(id: string, ...anker: [number, Maskenteil][]): SpurTeil {
  return { id, anker: anker.map(([k, teil]) => ankerFuer(k, teil)) };
}

function maske(id: string, teile: SpurTeil[], extra: Partial<Maske> = {}): Maske {
  return {
    id,
    name: id,
    aktiv: true,
    anpassung: BEREICH_NEUTRAL,
    geltung: { art: 'ganz' },
    farbe: 0,
    teile,
    ...extra,
  };
}

function abschnitt(id: string, vonK: number, bisK: number, doc: BildDoc | null = null): Abschnitt {
  return { id, vonMs: vonK * S, bisMs: bisK * S, doc, standMs: (vonK + 0.5) * S };
}

/** Ein Film aus einem Abschnitt, Quellbilder 0 … 99. */
const EINER: readonly Abschnitt[] = [abschnitt('a', 0, 100)];
const RAHMEN: Rahmen = { abschnitte: EINER, s: S, b: B, h: H };

/** Die Verfolgung – von Hand gelegt. */
class Karten implements SpurQuelle {
  private readonly ketten = new Map<
    string,
    { stand: KettenBild['stand']; alpha?: Uint8Array; punkte?: TippPunkte; marke: number }
  >();
  readonly lagen = new Map<string, LageAntwort>();
  lageSonst: LageAntwort = { stand: 'offen' };
  readonly tiefen = new Map<number, TiefenBild>();
  /** Wie oft eine Maske ausgepackt wurde. */
  ausgepackt = 0;

  legen(
    anker: Anker,
    richtung: Richtung,
    k: number,
    stand: KettenBild['stand'],
    alpha?: Uint8Array,
    punkte?: TippPunkte,
  ): void {
    this.ketten.set(`${anker.id}|${richtung}|${k}`, { stand, alpha, punkte, marke: filmMarke() });
  }

  kette(anker: Anker, richtung: Richtung, k: number): KettenBild {
    const eintrag = this.ketten.get(`${anker.id}|${richtung}|${k}`);
    if (!eintrag) return { stand: 'offen' };
    if (eintrag.stand === 'offen' || eintrag.stand === 'verloren') return { stand: eintrag.stand };
    return {
      stand: eintrag.stand,
      meta: metaMessen(eintrag.alpha ?? new Uint8Array(B * H), B, H),
      marke: eintrag.marke,
      ...(eintrag.punkte ? { punkte: eintrag.punkte } : {}),
    };
  }

  maske(anker: Anker, richtung: Richtung, k: number): Uint8Array | null {
    this.ausgepackt += 1;
    return this.ketten.get(`${anker.id}|${richtung}|${k}`)?.alpha ?? null;
  }

  lage(a: number, k: number): LageAntwort {
    return this.lagen.get(`${a}|${k}`) ?? this.lageSonst;
  }

  tiefe(k: number): TiefenBild {
    return this.tiefen.get(k) ?? { stand: 'offen' };
  }
}

function alphaVon(teil: Maskenteil): Uint8Array {
  if (teil.art !== 'tipp' && teil.art !== 'netz') throw new Error(`kein Maskenteil: ${teil.art}`);
  return teil.alpha;
}

/* ---------- Geltung ---------- */

describe('Geltung', () => {
  it('ist halboffen', () => {
    const g: Geltung = { art: 'stuecke', stuecke: [{ vonK: 10, bisK: 20 }] };
    expect(giltAn(g, 9, RAHMEN)).toBe(false);
    expect(giltAn(g, 10, RAHMEN)).toBe(true);
    expect(giltAn(g, 19, RAHMEN)).toBe(true);
    expect(giltAn(g, 20, RAHMEN)).toBe(false);
    expect(giltAn({ art: 'ganz' }, 12345, RAHMEN)).toBe(true);
  });

  it('verschmilzt, schneidet und zieht Stücke ab', () => {
    const a = stueckeNormal([
      { vonK: 20, bisK: 30 },
      { vonK: 0, bisK: 5 },
      { vonK: 5, bisK: 8 },
      { vonK: 25, bisK: 40 },
      { vonK: 50, bisK: 50 },
    ]);
    expect(a).toEqual([
      { vonK: 0, bisK: 8 },
      { vonK: 20, bisK: 40 },
    ]);
    expect(stueckeSchnitt(a, [{ vonK: 6, bisK: 25 }])).toEqual([
      { vonK: 6, bisK: 8 },
      { vonK: 20, bisK: 25 },
    ]);
    expect(stueckeOhne(a, [{ vonK: 2, bisK: 30 }])).toEqual([
      { vonK: 0, bisK: 2 },
      { vonK: 30, bisK: 40 },
    ]);
  });

  it('folgt bei „Nur Abschnitt" dem Abschnitt – auch wenn er verlängert wird', () => {
    const g = geltungNurAbschnitt('b');
    const vorher = [abschnitt('a', 0, 10), abschnitt('b', 50, 60)];
    const nachher = [abschnitt('a', 0, 10), abschnitt('b', 50, 70)];
    expect(giltAn(g, 65, { abschnitte: vorher, s: S })).toBe(false);
    expect(giltAn(g, 65, { abschnitte: nachher, s: S })).toBe(true);
    expect(geltungStuecke(g, { abschnitte: nachher, s: S })).toEqual([{ vonK: 50, bisK: 70 }]);
  });

  it('gilt nirgends mehr, wenn der Abschnitt gelöscht ist', () => {
    const g = geltungNurAbschnitt('b');
    const bezug = { abschnitte: [abschnitt('a', 0, 10)], s: S };
    expect(giltAn(g, 5, bezug)).toBe(false);
    expect(geltungLeer(g, bezug)).toBe(true);
    expect(geltungLeer({ art: 'ganz' }, bezug)).toBe(false);
  });

  it('gilt nach dem Teilen in beiden Hälften, wenn der Aufrufer die Geltung nachführt', () => {
    const liste = [abschnitt('a', 0, 100), abschnitt('z', 200, 250)];
    const nur = maske('m', [spur('r', [10, radial('r', 5, 5)])], {
      geltung: geltungNurAbschnitt('a'),
      zuletzt: { art: 'abschnitte', ids: ['a'] },
    });
    const andere = maske('o', [spur('q', [10, radial('q', 5, 5)])], {
      geltung: geltungNurAbschnitt('z'),
    });
    const geteilt = abschnittTeilen(liste, 0, 50 * S, S, 'neu');
    if (!geteilt) throw new Error('nicht geteilt');
    const bezug = { abschnitte: geteilt.abschnitte, s: S };
    // Ohne Nachführen fehlt die Maske in der Hälfte mit der neuen Kennung.
    expect([10, 70].map((k) => giltAn(nur.geltung, k, bezug))).toEqual([true, false]);
    const masken = geltungNachTeilen([nur, andere], 'a', 'neu');
    expect(masken[0].geltung).toEqual({ art: 'abschnitte', ids: ['a', 'neu'] });
    expect(masken[0].zuletzt).toEqual({ art: 'abschnitte', ids: ['a', 'neu'] });
    expect([10, 70].map((k) => giltAn(masken[0].geltung, k, bezug))).toEqual([true, true]);
    expect(masken[1]).toBe(andere);
    // Keine betroffen: dieselbe Liste.
    expect(geltungNachTeilen([andere], 'a', 'neu')).toEqual([andere]);
    const liste2 = [andere];
    expect(geltungNachTeilen(liste2, 'a', 'neu')).toBe(liste2);
  });

  it('nimmt „Ab hier" in FILMreihenfolge – auch bei umgestellten Abschnitten', () => {
    // B (Quelle 1500 … 1625) steht vor A (0 … 125); der Kopf steht in B bei 1550.
    const bezug = { abschnitte: [abschnitt('B', 1500, 1625), abschnitt('A', 0, 125)], s: S };
    const kopf = 50 * S + 1;
    expect(geltungAbHier({ art: 'ganz' }, bezug, kopf)).toEqual({
      art: 'stuecke',
      stuecke: [
        { vonK: 0, bisK: 125 },
        { vonK: 1550, bisK: 1625 },
      ],
    });
    // „Bis hier" – A liegt im Film DAHINTER und gehört nicht dazu.
    expect(geltungBisHier({ art: 'ganz' }, bezug, kopf)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 1500, bisK: 1551 }],
    });
  });

  it('behält bei „Ab hier" das bisherige Ende – und wenigstens das Bild unter dem Kopf', () => {
    const bezug = { abschnitte: EINER, s: S };
    const g: Geltung = { art: 'stuecke', stuecke: [{ vonK: 40, bisK: 60 }] };
    expect(geltungAbHier(g, bezug, 20 * S)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 20, bisK: 60 }],
    });
    expect(geltungAbHier(g, bezug, 80 * S)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 80, bisK: 81 }],
    });
    expect(geltungBisHier(g, bezug, 70 * S)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 40, bisK: 71 }],
    });
  });
});

describe('Grenzen: je Bild und im Film', () => {
  const ganz = (id: string) => maske(id, [spur(`t${id}`, [0, radial(`t${id}`, 5, 5)])]);
  const stueck = (id: string, von: number, bis: number) =>
    maske(id, [spur(`t${id}`, [von, radial(`t${id}`, 5, 5)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: von, bisK: bis }] },
    });
  const bezug = { abschnitte: EINER, s: S };

  it('erlaubt vier Masken an einem Bild, nicht fünf', () => {
    const vier = [ganz('a'), ganz('b'), ganz('c'), ganz('d')];
    expect(grenzeVerletzt(vier, bezug)).toBeNull();
    expect(hoechstJeBild(vier, bezug).anzahl).toBe(4);
    const fuenf = [...vier, stueck('e', 30, 40)];
    expect(grenzeVerletzt(fuenf, bezug)).toMatch(/höchstens 4/);
    expect(hoechstJeBild(fuenf, bezug)).toEqual({ anzahl: 5, k: 30 });
  });

  it('erlaubt acht Masken im Film, solange nie mehr als vier zugleich gelten', () => {
    const acht = Array.from({ length: 8 }, (_, i) => stueck(`m${i}`, i * 10, i * 10 + 10));
    expect(grenzeVerletzt(acht, bezug)).toBeNull();
    // Aneinanderstossende Stücke überlappen nicht – halboffen.
    expect(hoechstJeBild(acht, bezug).anzahl).toBe(1);
    expect(grenzeVerletzt([...acht, stueck('x', 90, 95)], bezug)).toMatch(/Höchstens 8/);
  });

  it('zählt abgeschaltete Masken mit', () => {
    const vier = [ganz('a'), ganz('b'), ganz('c'), { ...ganz('d'), aktiv: false }];
    expect(grenzeVerletzt([...vier, ganz('e')], bezug)).not.toBeNull();
  });
});

/* ---------- Ketten ---------- */

describe('kettenPlan', () => {
  const alle = (von: number, bis: number) =>
    Array.from({ length: bis - von + 1 }, (_, i) => von + i);
  const auftrag = (extra: Partial<KettenAuftrag>): KettenAuftrag => ({
    anker: 10,
    ziele: alle(0, 40),
    K: 4,
    fenster: 8,
    jenseits: 'verloren',
    ...extra,
  });

  it('läuft vom Anker in beide Richtungen, mit Schlüsseln alle K und an Laufenden', () => {
    const plan = kettenPlan(auftrag({}));
    const [vor] = plan.vor.laeufe;
    expect(vor.pfad).toEqual(alle(10, 40));
    expect(vor.ziele).toEqual(alle(11, 40));
    expect(vor.schluessel).toEqual([10, 14, 18, 22, 26, 30, 34, 38, 40]);
    const [rueck] = plan.rueck.laeufe;
    expect(rueck.pfad).toEqual(alle(0, 10).reverse());
    expect(rueck.schluessel).toEqual([10, 6, 2, 0]);
  });

  it('liest Brücken Bild für Bild, prüft und speichert sie aber nicht', () => {
    const ziele = [...alle(0, 20), ...alle(40, 60)];
    const [vor] = kettenPlan(auftrag({ ziele })).vor.laeufe;
    expect(vor.pfad).toEqual(alle(10, 60));
    expect(vor.ziele).toEqual([...alle(11, 20), ...alle(40, 60)]);
    // Letztes Bild vor und erstes nach der Brücke sind Schlüssel, keine Brücke ist einer.
    expect(vor.schluessel).toEqual([10, 14, 18, 20, 40, 42, 46, 50, 54, 58, 60]);
    for (let k = 21; k < 40; k += 1) expect(vor.schluessel).not.toContain(k);
  });

  it('endet an einem Szenenschnitt – dahinter „verloren" oder neu angesetzt', () => {
    const ziele = [...alle(0, 20), ...alle(21 + BRUECKE_MAX + 1, 21 + BRUECKE_MAX + 10)];
    const verloren = kettenPlan(auftrag({ ziele })).vor;
    expect(verloren.laeufe).toHaveLength(1);
    expect(verloren.laeufe[0].pfad[verloren.laeufe[0].pfad.length - 1]).toBe(20);
    expect(verloren.ohne).toEqual(alle(70, 79));

    const neu = kettenPlan(auftrag({ ziele, jenseits: 'neustart' })).vor;
    expect(neu.ohne).toEqual([]);
    expect(neu.laeufe).toHaveLength(2);
    expect(neu.laeufe[1]).toMatchObject({ start: 70, neustart: true });
    expect(neu.laeufe[1].pfad).toEqual(alle(70, 79));
    expect(neu.laeufe[1].ziele[0]).toBe(70);
    expect(neu.laeufe[1].schluessel[0]).toBe(70);

    // Genau BRUECKE_MAX Bilder Lücke ist noch eine Brücke.
    const knapp = [...alle(0, 20), ...alle(21 + BRUECKE_MAX, 21 + BRUECKE_MAX + 5)];
    expect(kettenPlan(auftrag({ ziele: knapp })).vor.laeufe).toHaveLength(1);
    expect(kettenPlan(auftrag({ ziele: knapp })).vor.ohne).toEqual([]);
  });

  it('misst einen Szenenschnitt am Film, nicht an der Geltung', () => {
    /*
     * „Nur Abschnitt 1 und 3" mit einem langen Abschnitt 2 dazwischen – der
     * Film läuft dort lückenlos weiter. Gemessen an den Zielen war das ein
     * Schnitt, und alles in Abschnitt 3 hiess „hier neu antippen".
     */
    const ziele = [...alle(0, 49), ...alle(120, 199)];
    const plan = kettenPlan(auftrag({ ziele, film: alle(0, 199) })).vor;
    expect(plan.ohne).toEqual([]);
    expect(plan.laeufe).toHaveLength(1);
    const [vor] = plan.laeufe;
    expect(vor.ziele).toEqual([...alle(11, 49), ...alle(120, 199)]);
    // Die Strecke dazwischen wird geprüft (alle K ab dem Anker), aber nicht abgelegt.
    for (let k = 50; k < 120; k += 1) {
      expect(vor.schluessel.includes(k), `Bild ${k}`).toBe((k - 10) % 4 === 0);
    }
    // In Laufrichtung, der Start zuerst.
    expect(vor.schluessel[0]).toBe(10);
    expect([...vor.schluessel].sort((x, y) => x - y)).toEqual(vor.schluessel);
    // Ohne Film zählt die Lücke der Ziele – wie bisher ein Schnitt.
    expect(kettenPlan(auftrag({ ziele })).vor.ohne).toEqual(alle(120, 199));
    // Fehlen die Bilder dazwischen auch im Film, bleibt es ein Schnitt.
    const zerschnitten = [...alle(0, 49), ...alle(120, 199)];
    expect(kettenPlan(auftrag({ ziele, film: zerschnitten })).vor.ohne).toEqual(alle(120, 199));
  });

  it('prüft eine kurze Strecke im Film ohne Ziel nicht – wie eine Brücke', () => {
    const ziele = [...alle(0, 20), ...alle(40, 60)];
    const [vor] = kettenPlan(auftrag({ ziele, film: alle(0, 60) })).vor.laeufe;
    for (let k = 21; k < 40; k += 1) expect(vor.schluessel).not.toContain(k);
  });

  it('bleibt nach „Ab hier" hinter dem Anker bei derselben Kette – ohne Schnitt', () => {
    // Anker bei 5, dann gilt die Maske erst ab 60 – 54 Filmbilder dahinter.
    const plan = kettenPlan(auftrag({ anker: 5, ziele: alle(60, 119), film: alle(0, 119) })).vor;
    expect(plan.ohne).toEqual([]);
    expect(plan.laeufe[0].ziele).toEqual(alle(60, 119));
    expect(plan.laeufe[0].schluessel).toContain(9);
  });

  it('setzt auch an einem Anker ausserhalb des Films an – über eine Brücke', () => {
    const plan = kettenPlan(auftrag({ anker: 60, ziele: alle(0, 20) }));
    expect(plan.vor.laeufe).toEqual([]);
    const [rueck] = plan.rueck.laeufe;
    expect(rueck.pfad[0]).toBe(60);
    expect(rueck.pfad[rueck.pfad.length - 1]).toBe(0);
    // 20 ist das erste Ziel nach der Brücke – ein Schlüssel.
    expect(rueck.schluessel.slice(0, 2)).toEqual([60, 20]);
    // Zu weit weg: dann ist schon das erste Ziel jenseits eines Schnitts.
    const fern = kettenPlan(auftrag({ anker: 200, ziele: alle(0, 20) }));
    expect(fern.rueck.laeufe).toEqual([]);
    expect(fern.rueck.ohne).toHaveLength(21);
  });

  it('bleibt zwischen seinen Nachbarankern', () => {
    const teil = spur(
      't',
      [10, radial('t', 1, 1)],
      [30, radial('t', 1, 1)],
      [50, radial('t', 1, 1)],
    );
    const grenzen = ankerKetten(teil);
    expect(grenzen.map((g) => [g.lo, g.hi])).toEqual([
      [Number.NEGATIVE_INFINITY, 29],
      [11, 49],
      [31, Number.POSITIVE_INFINITY],
    ]);
    const plan = kettenPlan(auftrag({ anker: 30, lo: 11, hi: 49, ziele: alle(0, 99) }));
    expect(plan.vor.laeufe[0].ziele).toEqual(alle(31, 49));
    expect(plan.rueck.laeufe[0].ziele).toEqual(alle(11, 29).reverse());
  });

  it('teilt in Fenster, die auf Schlüsseln enden', () => {
    const ziele = [...alle(0, 30), ...alle(70, 99)];
    const [vor] = kettenPlan(auftrag({ anker: 2, ziele, fenster: 8 })).vor.laeufe;
    const schluessel = new Set(vor.schluessel);
    let von = 0;
    for (const f of vor.fenster) {
      expect(f.von).toBe(von);
      expect(schluessel.has(vor.pfad[f.bis])).toBe(true);
      // Nur eine Brücke darf ein Fenster länger machen.
      const bruecke = vor.pfad.slice(f.von, f.bis + 1).some((k) => !ziele.includes(k));
      if (!bruecke) expect(f.bis - f.von).toBeLessThanOrEqual(8);
      von = f.bis;
    }
    expect(von).toBe(vor.pfad.length - 1);
  });

  it('legt die Schlüssel des Grobpasses unter die feinen', () => {
    const [vor] = kettenPlan(auftrag({ ziele: alle(0, 99), kGrob: 24 })).vor.laeufe;
    expect(vor.grob).toEqual([10, 34, 58, 82, 99]);
    for (const k of vor.grob) expect(vor.schluessel).toContain(k);
    expect(vor.grobFenster[vor.grobFenster.length - 1].bis).toBe(vor.pfad.length - 1);
  });

  it('rechnet nur die Bilder des Films in der Geltung – höchstens 600', () => {
    const lang = [abschnitt('a', 0, 1000)];
    const F = filmRaster(lang, S, 600).menge;
    const m = maske('m', [spur('t', [5, netz('t', scheibe(10, 10))])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 500, bisK: 700 }] },
    });
    const Z = maskenZiele(m, F, { abschnitte: lang, s: S });
    expect(Z).toEqual(alle(500, 599));
    const [bedarf] = kettenBedarf(m, F, { abschnitte: lang, s: S });
    expect(bedarf.ziele).toEqual(Z);
    expect(bedarf.jenseits).toBe('verloren');
  });

  it('rechnet einen Anker mit neuRechnen selbst – und legt seine Maske vorwärts ab', () => {
    const plan = kettenPlan(auftrag({ ankerNeu: true }));
    const [vor] = plan.vor.laeufe;
    expect(vor.startRechnen).toBe(true);
    expect(vor.ziele[0]).toBe(10);
    expect(vor.schluessel[0]).toBe(10);
    // Rückwärts braucht die Kette dieselbe Maske als Saat, legt sie aber nicht ab.
    const [rueck] = plan.rueck.laeufe;
    expect(rueck.startRechnen).toBe(true);
    expect(rueck.ziele).not.toContain(10);
    // Ohne neuRechnen läuft am Anker kein Modell – seine Maske ist bekannt.
    expect(kettenPlan(auftrag({})).vor.laeufe[0].startRechnen).toBe(false);
    // Auch ohne ein Ziel dahinter entsteht ein Lauf, der ihn rechnet.
    const allein = kettenPlan(auftrag({ ankerNeu: true, ziele: alle(0, 10) })).vor.laeufe;
    expect(allein).toHaveLength(1);
    expect(allein[0]).toMatchObject({ pfad: [10], ziele: [10], fenster: [{ von: 0, bis: 0 }] });
  });

  it('gibt auch einem Neustart aus nur einem Bild ein Fenster', () => {
    const ziele = [...alle(0, 20), 21 + BRUECKE_MAX + 1];
    const [, neu] = kettenPlan(auftrag({ ziele, jenseits: 'neustart' })).vor.laeufe;
    expect(neu).toMatchObject({ start: 70, startRechnen: true, pfad: [70], ziele: [70] });
    expect(neu.fenster).toEqual([{ von: 0, bis: 0 }]);
  });

  it('baut den Auftrag aus dem Bedarf – mit Grenzen und neuRechnen', () => {
    const teil = spur('t', [10, tipp('t', scheibe(10, 10))], [30, tipp('t', scheibe(12, 10))]);
    const neuAnker: Anker = { ...teil.anker[1], neuRechnen: true };
    const m = maske('m', [{ ...teil, anker: [teil.anker[0], neuAnker] }]);
    const [erste, zweite] = kettenBedarf(m, alle(0, 50), { abschnitte: EINER, s: S });
    expect(erste.art).toBe('inhalt');
    const a1 = kettenAuftrag(erste, { K: 4, fenster: 8, kGrob: 24 });
    expect(a1).toMatchObject({ anker: 10, hi: 29, K: 4, kGrob: 24, fenster: 8 });
    expect(a1.jenseits).toBe('verloren');
    expect(a1.lo).toBeUndefined();
    expect(a1.ankerNeu).toBeUndefined();
    const a2 = kettenAuftrag(zweite, { K: 4, fenster: 8 });
    expect(a2).toMatchObject({ anker: 30, lo: 11, ankerNeu: true });
    expect(a2.hi).toBeUndefined();
    expect(kettenPlan(a2).vor.laeufe[0].ziele[0]).toBe(30);
  });

  it('verlangt den Kamerapfad nur für reine Formmasken', () => {
    const bezug = { abschnitte: EINER, s: S };
    const nurFormen = maske('f', [
      spur('r', [10, radial('r', 5, 5)]),
      spur('v', [10, verlauf('v')]),
    ]);
    expect(kettenBedarf(nurFormen, alle(0, 50), bezug).map((b) => [b.teil.id, b.art])).toEqual([
      ['r', 'kamera'],
      ['v', 'kamera'],
    ]);
    // Mit Inhalt folgen die Formen ihm – nur die Kette des Inhalts wird gerechnet.
    const mitInhalt = maske('m', [
      spur('t', [10, tipp('t', scheibe(10, 10))]),
      spur('p', [12, pinsel('p', [1, 1, 2, 2])]),
    ]);
    expect(kettenBedarf(mitInhalt, alle(0, 50), bezug).map((b) => [b.teil.id, b.art])).toEqual([
      ['t', 'inhalt'],
    ]);
  });

  it('weiss, was jenseits eines Schnitts mit welchem Teil geschieht', () => {
    expect(jenseitsFuer(netz('a', scheibe(1, 1), 'person'))).toBe('neustart');
    expect(jenseitsFuer(netz('a', scheibe(1, 1), 'object'))).toBe('verloren');
    expect(jenseitsFuer(tipp('a', scheibe(1, 1)))).toBe('verloren');
    expect(jenseitsFuer(radial('a', 1, 1))).toBe('vorlaeufig');
  });

  it('schreibt keine Masken- oder Teilkennung in den Kettenschlüssel', () => {
    const anker = ankerFuer(10, radial('t', 1, 1));
    expect(kettenSchluessel(anker, S, 960, 540, 4)).toBe(`${anker.id}|40|960x540|K4`);
  });
});

/* ---------- Zusammensetzen ---------- */

describe('bildDocAn', () => {
  it('gibt am Ankerbild das Teil des Ankers SELBST aus', () => {
    const t = tipp('t1', scheibe(10, 10));
    const m = maske('m1', [spur('t1', [10, t])]);
    const z = bildDocAn(null, [m], new Karten(), 10, 'editor', RAHMEN);
    expect(z.doc.bereiche).toHaveLength(1);
    expect(z.doc.bereiche[0].teile[0]).toBe(t);
    expect(z.enthalten.get('m1')).toBe(z.doc.bereiche[0].teile);
  });

  it('lässt die Bereiche des Abschnittsdokuments weg', () => {
    const clip = {
      ...neuesDoc(B, H),
      bereiche: [
        {
          id: 'alt',
          name: 'Alt',
          aktiv: true,
          teile: [radial('r', 1, 1)],
          anpassung: BEREICH_NEUTRAL,
        },
      ],
    };
    const z = bildDocAn(clip, [], new Karten(), 10, 'editor', RAHMEN);
    expect(z.doc.bereiche).toEqual([]);
    expect(z.doc.anpassung).toBe(clip.anpassung);
  });

  it('setzt an anderen Bildern die Maske der Kette ein – und merkt sie sich', () => {
    const t = tipp('t1', scheibe(10, 10));
    const m = maske('m1', [spur('t1', [10, t])]);
    const karten = new Karten();
    const alpha = scheibe(14, 10);
    karten.legen(m.teile[0].anker[0], 'vor', 14, 'fein', alpha);
    const speicher = new Kompositspeicher();
    const z1 = bildDocAn(null, [m], karten, 14, 'vorschau', RAHMEN, speicher);
    const teil = z1.doc.bereiche[0].teile[0];
    expect(alphaVon(teil)).toBe(alpha);
    expect(teil.id).toBe('t1');
    // Noch einmal: dasselbe Feld, dieselbe Marke, nicht noch einmal ausgepackt.
    const z2 = bildDocAn(null, [m], karten, 14, 'vorschau', RAHMEN, speicher);
    expect(z2.doc.bereiche[0].teile).toBe(z1.doc.bereiche[0].teile);
    expect(karten.ausgepackt).toBe(1);
    expect(speicher.bytes).toBeGreaterThan(0);
  });

  it('gibt Tipps nur im Editor Punkte – mit der Maske verschoben', () => {
    const t = tipp('t1', scheibe(10, 10), [{ x: 9, y: 9 }]);
    const m = maske('m1', [spur('t1', [10, t])]);
    const karten = new Karten();
    karten.legen(m.teile[0].anker[0], 'vor', 16, 'fein', scheibe(16, 10), {
      liste: [{ x: 10, y: 10 }],
      mx: 10,
      my: 10,
    });
    const editor = bildDocAn(null, [m], karten, 16, 'editor', RAHMEN).doc.bereiche[0].teile[0];
    const vorschau = bildDocAn(null, [m], karten, 16, 'vorschau', RAHMEN).doc.bereiche[0].teile[0];
    if (editor.art !== 'tipp' || vorschau.art !== 'tipp') throw new Error('kein Tipp');
    expect(editor.punkte).toHaveLength(1);
    expect(editor.punkte[0].x).toBeCloseTo(16, 0);
    expect(editor.punkte[0].y).toBeCloseTo(10, 0);
    expect(vorschau.punkte).toEqual([{ x: 9, y: 9 }]);
  });

  it('lässt eine Maske ohne Daten im Editor weg – und wirft beim Filmbau', () => {
    const m = maske('m1', [spur('t1', [10, tipp('t1', scheibe(10, 10))])], { name: 'Motiv' });
    const karten = new Karten();
    const z = bildDocAn(null, [m], karten, 20, 'editor', RAHMEN);
    expect(z.doc.bereiche).toEqual([]);
    expect(z.fehlend).toEqual(['m1']);
    expect(() => bildDocAn(null, [m], karten, 20, 'bild', RAHMEN)).toThrow(
      /‚Motiv' ist bei 0:00,82 noch nicht fertig/,
    );
    // Grob reicht dem Editor, nicht dem Filmbau.
    karten.legen(m.teile[0].anker[0], 'vor', 20, 'grob', scheibe(12, 10));
    const grob = bildDocAn(null, [m], karten, 20, 'editor', RAHMEN);
    expect(grob.doc.bereiche).toHaveLength(1);
    expect(grob.grob).toEqual(['m1']);
    expect(() => bildDocAn(null, [m], karten, 20, 'bild', RAHMEN)).toThrow();
    karten.legen(m.teile[0].anker[0], 'vor', 20, 'fein', scheibe(12, 10));
    expect(bildDocAn(null, [m], karten, 20, 'bild', RAHMEN).doc.bereiche).toHaveLength(1);
  });

  it('lässt beim Filmbau abgeschaltete Masken weg, statt auf sie zu warten', () => {
    const m = maske('m1', [spur('t1', [10, tipp('t1', scheibe(10, 10))])], { aktiv: false });
    const z = bildDocAn(null, [m], new Karten(), 20, 'bild', RAHMEN);
    expect(z.doc.bereiche).toEqual([]);
    // Im Editor steht sie da – sonst liesse sich der Haken nicht setzen.
    const karten = new Karten();
    karten.legen(m.teile[0].anker[0], 'vor', 20, 'fein', scheibe(12, 10));
    expect(bildDocAn(null, [m], karten, 20, 'editor', RAHMEN).doc.bereiche[0].aktiv).toBe(false);
  });

  it('nimmt nur, was an diesem Bild gilt', () => {
    const m = maske('m1', [spur('t1', [10, radial('t1', 5, 5)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 0, bisK: 15 }] },
    });
    expect(bildDocAn(null, [m], new Karten(), 10, 'editor', RAHMEN).doc.bereiche).toHaveLength(1);
    expect(bildDocAn(null, [m], new Karten(), 15, 'editor', RAHMEN).doc.bereiche).toHaveLength(0);
  });

  describe('Anwesenheit gewinnt – zwei Anker', () => {
    const a = tipp('t', scheibe(10, 10));
    const b = tipp('t', scheibe(30, 10));
    const m = maske('m', [spur('t', [10, a], [30, b])]);
    const [ankerA, ankerB] = m.teile[0].anker;
    const an = (karten: Karten, k: number, art: 'editor' | 'vorschau' = 'editor') =>
      bildDocAn(null, [m], karten, k, art, RAHMEN);

    it('nimmt den näheren Anker, wenn beide den Gegenstand sehen', () => {
      const karten = new Karten();
      const vonA = scheibe(15, 10);
      karten.legen(ankerA, 'vor', 15, 'fein', vonA);
      karten.legen(ankerB, 'rueck', 15, 'fein', scheibe(16, 10));
      expect(alphaVon(an(karten, 15).doc.bereiche[0].teile[0])).toBe(vonA);
    });

    it('nimmt die Seite, die ihn sieht – auch die fernere', () => {
      const karten = new Karten();
      const vonB = scheibe(16, 10);
      karten.legen(ankerA, 'vor', 15, 'fein', new Uint8Array(B * H));
      karten.legen(ankerB, 'rueck', 15, 'fein', vonB);
      expect(alphaVon(an(karten, 15).doc.bereiche[0].teile[0])).toBe(vonB);
    });

    it('blendet um die Mitte über vier Bilder über', () => {
      const karten = new Karten();
      for (const k of [19, 20]) {
        karten.legen(ankerA, 'vor', k, 'fein', scheibe(15, 10));
        karten.legen(ankerB, 'rueck', k, 'fein', scheibe(25, 10));
      }
      const mitte = alphaVon(an(karten, 20).doc.bereiche[0].teile[0]);
      expect(mitte[10 * B + 15]).toBe(128);
      expect(mitte[10 * B + 25]).toBe(128);
      const davor = alphaVon(an(karten, 19).doc.bereiche[0].teile[0]);
      expect(davor[10 * B + 15]).toBe(191);
      expect(davor[10 * B + 25]).toBe(64);
    });

    it('ist leer, wenn keine Seite ihn sieht, und verloren, wenn keine rechnen kann', () => {
      const karten = new Karten();
      karten.legen(ankerA, 'vor', 15, 'fein', new Uint8Array(B * H));
      karten.legen(ankerB, 'rueck', 15, 'verloren');
      const leer = an(karten, 15).doc.bereiche[0].teile[0];
      expect(alphaVon(leer).every((wert) => wert === 0)).toBe(true);
      expect(zustandAn(m, 15, null, karten, RAHMEN)).toBe(BAHN.leer);
      karten.legen(ankerA, 'vor', 15, 'verloren');
      expect(an(karten, 15).doc.bereiche).toHaveLength(1);
      expect(zustandAn(m, 15, null, karten, RAHMEN)).toBe(BAHN.verloren);
      // Verloren ist endgültig – auch der Filmbau nimmt es (als leere Maske).
      expect(bildDocAn(null, [m], karten, 15, 'bild', RAHMEN).doc.bereiche).toHaveLength(1);
    });

    it('nimmt die Seite mit Daten, wenn die andere verloren ist', () => {
      const karten = new Karten();
      const vonA = scheibe(15, 10);
      karten.legen(ankerA, 'vor', 25, 'fein', vonA);
      karten.legen(ankerB, 'rueck', 25, 'verloren');
      expect(alphaVon(an(karten, 25).doc.bereiche[0].teile[0])).toBe(vonA);
      expect(zustandAn(m, 25, null, karten, RAHMEN)).toBe(BAHN.sichtbar);
    });

    it('wartet auf beide Seiten – nur die Vorschau nimmt die eine als veraltet', () => {
      const karten = new Karten();
      karten.legen(ankerA, 'vor', 15, 'fein', scheibe(15, 10));
      expect(an(karten, 15).fehlend).toEqual(['m']);
      const vorschau = an(karten, 15, 'vorschau');
      expect(vorschau.veraltet).toEqual(['m']);
      expect(vorschau.doc.bereiche).toHaveLength(1);
    });
  });

  it('fragt bei drei Ankern nur die beiden Nachbarn', () => {
    const drei = maske('m', [
      spur(
        't',
        [10, tipp('t', scheibe(10, 10))],
        [20, tipp('t', scheibe(20, 10))],
        [40, tipp('t', scheibe(30, 10))],
      ),
    ]);
    const [a1, a2, a3] = drei.teile[0].anker;
    const karten = new Karten();
    // Die erste Kette reicht nur bis vor den zweiten Anker; was sie jenseits davon
    // wüsste, zählt nicht.
    karten.legen(a1, 'vor', 25, 'fein', scheibe(1, 1));
    const vonA2 = scheibe(22, 10);
    karten.legen(a2, 'vor', 25, 'fein', vonA2);
    karten.legen(a3, 'rueck', 25, 'fein', new Uint8Array(B * H));
    expect(
      alphaVon(bildDocAn(null, [drei], karten, 25, 'editor', RAHMEN).doc.bereiche[0].teile[0]),
    ).toBe(vonA2);
    // Vor dem ersten Anker gilt allein seine Rückwärtskette.
    const vorn = scheibe(8, 10);
    karten.legen(a1, 'rueck', 5, 'fein', vorn);
    expect(
      alphaVon(bildDocAn(null, [drei], karten, 5, 'editor', RAHMEN).doc.bereiche[0].teile[0]),
    ).toBe(vorn);
  });

  it('zeigt dem Editor nie Veraltetes – die Vorschau schon', () => {
    const m = maske('m1', [spur('t1', [10, tipp('t1', scheibe(10, 10))])], { name: 'Motiv' });
    const karten = new Karten();
    karten.legen(m.teile[0].anker[0], 'vor', 20, 'veraltet', scheibe(12, 10));
    const editor = bildDocAn(null, [m], karten, 20, 'editor', RAHMEN);
    expect(editor.doc.bereiche).toEqual([]);
    expect(editor.fehlend).toEqual(['m1']);
    const vorschau = bildDocAn(null, [m], karten, 20, 'vorschau', RAHMEN);
    expect(vorschau.doc.bereiche).toHaveLength(1);
    expect(vorschau.veraltet).toEqual(['m1']);
    expect(() => bildDocAn(null, [m], karten, 20, 'bild', RAHMEN)).toThrow(/noch nicht fertig/);
    // Die Bahn zeigt es – gestreift.
    expect(zustandAn(m, 20, null, karten, RAHMEN)).toBe(BAHN.veraltet);
  });

  it('löst jede Art von Geltung beim Zusammensetzen auf', () => {
    const film = [abschnitt('a', 0, 20), abschnitt('b', 50, 60)];
    const rahmen: Rahmen = { abschnitte: film, s: S, b: B, h: H };
    const r = radial('r', 5, 5);
    const mit = (geltung: Geltung) => maske('m', [spur('r', [10, r])], { geltung });
    const an = (g: Geltung, k: number, r2 = rahmen) =>
      bildDocAn(null, [mit(g)], new Karten(), k, 'editor', r2).doc.bereiche.length;
    expect(an({ art: 'ganz' }, 10)).toBe(1);
    expect(an({ art: 'stuecke', stuecke: [{ vonK: 0, bisK: 10 }] }, 10)).toBe(0);
    expect(an({ art: 'stuecke', stuecke: [{ vonK: 0, bisK: 11 }] }, 10)).toBe(1);
    // „Nur Abschnitt a" – und nach dem Löschen von a gilt sie nirgends mehr.
    expect(an(geltungNurAbschnitt('a'), 10)).toBe(1);
    expect(an(geltungNurAbschnitt('b'), 10)).toBe(0);
    expect(an(geltungNurAbschnitt('a'), 10, { ...rahmen, abschnitte: [film[1]] })).toBe(0);
  });

  describe('Formen', () => {
    it('folgen in einer reinen Formmaske der Kamera', () => {
      const r = radial('r', 10, 10);
      const m = maske('m', [spur('r', [10, r])]);
      const karten = new Karten();
      karten.lagen.set('10|12', {
        stand: 'fein',
        lage: { s: 1, w: 0, tx: -3, ty: 0, sicher: 9 },
        faktor: 2,
      });
      const teil = bildDocAn(null, [m], karten, 12, 'editor', RAHMEN).doc.bereiche[0].teile[0];
      if (teil.art !== 'radial') throw new Error('keine Ellipse');
      expect(teil.mitte.x).toBeCloseTo(16, 9);
      expect(teil.mitte.y).toBeCloseTo(10, 9);
      expect(teil.id).toBe('r');
    });

    it('bleiben ohne Kamera am Anker – vorläufig hinter einem Schnitt, veraltet in der Vorschau', () => {
      const r = radial('r', 10, 10);
      const m = maske('m', [spur('r', [10, r])]);
      const karten = new Karten();
      expect(bildDocAn(null, [m], karten, 12, 'editor', RAHMEN).fehlend).toEqual(['m']);
      const vorschau = bildDocAn(null, [m], karten, 12, 'vorschau', RAHMEN);
      expect(vorschau.doc.bereiche[0].teile[0]).toBe(r);
      expect(vorschau.veraltet).toEqual(['m']);
      karten.lageSonst = { stand: 'vorlaeufig' };
      expect(bildDocAn(null, [m], karten, 12, 'bild', RAHMEN).doc.bereiche[0].teile[0]).toBe(r);
      expect(zustandAn(m, 12, null, karten, RAHMEN)).toBe(BAHN.vorlaeufig);
    });

    it('bleiben stehen, wo am Ankerbild der Form vom Inhalt nichts zu sehen war', () => {
      const t = tipp('t', scheibe(10, 10));
      const p = pinsel('p', [20, 20, 22, 20]);
      const m = maske('m', [spur('t', [10, t]), spur('p', [14, p])]);
      const karten = new Karten();
      const ankerT = m.teile[0].anker[0];
      karten.legen(ankerT, 'vor', 14, 'fein', new Uint8Array(B * H));
      karten.legen(ankerT, 'vor', 16, 'fein', scheibe(18, 10));
      // Keine Kamera – und keine wird gefragt: Die Form bleibt, wo sie gemalt wurde.
      karten.lageSonst = { stand: 'offen' };
      const z = bildDocAn(null, [m], karten, 16, 'bild', RAHMEN);
      expect(z.doc.bereiche[0].teile[1]).toBe(p);
    });

    it('bestellen ihr Ankerbild beim Inhalt – auch wenn es kein Bild des Films mehr ist', () => {
      /*
       * Tipp bei 10, Pinsel bei 40, der Film zeigt nur 0 … 29 (gekürzt). Die
       * Form fragt den Inhalt an 40 – das muss die Kette rechnen, sonst fehlt
       * die Maske an JEDEM Bild, und der Fortschritt meldete trotzdem fertig.
       */
      const t = tipp('t', scheibe(10, 10));
      const p = pinsel('p', [20, 20, 22, 20]);
      const m = maske('m', [spur('t', [10, t]), spur('p', [40, p])]);
      const F = Array.from({ length: 30 }, (_, i) => i);
      const bezug = { abschnitte: [abschnitt('a', 0, 30)], s: S };
      const [bedarf] = kettenBedarf(m, F, bezug);
      expect(bedarf.teil.id).toBe('t');
      expect(bedarf.ziele).toContain(40);
      expect(bedarf.ziele.filter((k) => k !== 40)).toEqual(F);
      // Zwei Anker am Inhalt: Die Kette, deren Bereich 40 enthält, bekommt es.
      const zwei = maske('m', [spur('t', [10, t], [20, tipp('t', scheibe(12, 10))]), m.teile[1]]);
      const [erste, zweite] = kettenBedarf(zwei, F, bezug);
      expect(erste.ziele).not.toContain(40);
      expect(zweite.ziele).toContain(40);

      // Fortschritt und Filmbau fragen dieselbe Regel.
      const rahmen = { ...bezug, b: B, h: H };
      const karten = new Karten();
      const ankerT = m.teile[0].anker[0];
      karten.legen(ankerT, 'vor', 20, 'fein', scheibe(14, 10));
      expect(filmStandAn(m, 20, karten, rahmen)).toBe('offen');
      expect(() => bildDocAn(null, [m], karten, 20, 'bild', rahmen)).toThrow(/noch nicht fertig/);
      karten.legen(ankerT, 'vor', 40, 'grob', scheibe(16, 10));
      expect(filmStandAn(m, 20, karten, rahmen)).toBe('grob');
      karten.legen(ankerT, 'vor', 40, 'fein', scheibe(16, 10));
      expect(filmStandAn(m, 20, karten, rahmen)).toBe('fein');
      const teil = bildDocAn(null, [m], karten, 20, 'bild', rahmen).doc.bereiche[0].teile[1];
      if (teil.art !== 'pinsel') throw new Error('kein Pinsel');
      // Der Inhalt wanderte von 16 (bei 40) nach 14 (bei 20): der Pinsel mit.
      expect(teil.striche[0].punkte[0]).toBeCloseTo(18, 6);
    });

    it('folgen in einer Maske mit Inhalt dem INHALT – und verschwinden mit ihm', () => {
      const t = tipp('t', scheibe(10, 10));
      const p = pinsel('p', [10, 10, 12, 10]);
      const m = maske('m', [spur('t', [10, t]), spur('p', [10, p])]);
      const karten = new Karten();
      const ankerT = m.teile[0].anker[0];
      karten.legen(ankerT, 'vor', 12, 'fein', scheibe(15, 10));
      karten.legen(ankerT, 'vor', 13, 'fein', new Uint8Array(B * H));
      // Die Kamera stünde still – trotzdem wandert der Pinsel mit dem Inhalt.
      karten.lageSonst = {
        stand: 'fein',
        lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 },
        faktor: 1,
      };
      const bei12 = bildDocAn(null, [m], karten, 12, 'editor', RAHMEN).doc.bereiche[0].teile[1];
      if (bei12.art !== 'pinsel') throw new Error('kein Pinsel');
      expect(bei12.striche[0].punkte[0]).toBeCloseTo(15, 6);
      expect(bei12.striche[0].punkte[2]).toBeCloseTo(17, 6);
      const bei13 = bildDocAn(null, [m], karten, 13, 'editor', RAHMEN).doc.bereiche[0].teile[1];
      if (bei13.art !== 'pinsel') throw new Error('kein Pinsel');
      expect(bei13.striche).toEqual([]);
      expect(zustandAn(m, 13, null, karten, RAHMEN)).toBe(BAHN.leer);
      expect(zustandAn(m, 12, null, karten, RAHMEN)).toBe(BAHN.sichtbar);
    });
  });

  it('setzt eine Tiefe aus der geteilten Karte zusammen – in deren Grösse', () => {
    const tiefe: Maskenteil = {
      id: 'd',
      modus: 'dazu',
      umkehren: false,
      art: 'tiefe',
      breite: B,
      hoehe: H,
      karte: new Uint8Array(B * H),
      fokus: 0.7,
      spanne: 0.2,
      marke: filmMarke(),
    };
    const m = maske('m', [spur('d', [10, tiefe])]);
    const karten = new Karten();
    karten.tiefen.set(12, {
      stand: 'fein',
      daten: { breite: 20, hoehe: 15, werte: new Uint8Array(300) },
      marke: 7,
    });
    const teil = bildDocAn(null, [m], karten, 12, 'bild', RAHMEN).doc.bereiche[0].teile[0];
    expect(teil).toMatchObject({ art: 'tiefe', breite: 20, hoehe: 15, fokus: 0.7, marke: 7 });
    expect(bildDocAn(null, [m], karten, 13, 'editor', RAHMEN).fehlend).toEqual(['m']);
  });

  it('gibt nie mehr als vier Masken aus', () => {
    const masken = Array.from({ length: 5 }, (_, i) =>
      maske(`m${i}`, [spur(`r${i}`, [10, radial(`r${i}`, 5, 5)])]),
    );
    const z = bildDocAn(null, masken, new Karten(), 10, 'editor', RAHMEN);
    expect(z.doc.bereiche).toHaveLength(4);
    expect(z.ueberzaehlig).toEqual(['m4']);
  });

  it('lässt im Filmbau keine fünfte Maske still weg, die ein Verlängern ins Bild holte', () => {
    /*
     * Vier Masken bis Bild 49, eine fünfte „nur in Abschnitt b" (ab 60).
     * Verlängert man b nach vorn bis 30, gilt sie dort mit – eine Änderung
     * der Geltung, an der `grenzeVerletzt` nicht gefragt war.
     */
    const vorher = [abschnitt('a', 0, 50), abschnitt('b', 60, 100)];
    const vier = Array.from({ length: 4 }, (_, i) =>
      maske(`v${i}`, [spur(`r${i}`, [10, radial(`r${i}`, 5, 5)])], {
        geltung: { art: 'stuecke', stuecke: [{ vonK: 0, bisK: 50 }] },
      }),
    );
    const fuenfte = maske('f', [spur('rf', [70, radial('rf', 5, 5)])], {
      geltung: geltungNurAbschnitt('b'),
    });
    const masken = [...vier, fuenfte];
    expect(grenzeVerletzt(masken, { abschnitte: vorher, s: S })).toBeNull();
    const nachher = abschnittKuerzen(vorher, 1, 30 * S, 100 * S, 10000, S).abschnitte;
    const bezug = { abschnitte: nachher, s: S };
    // Die Prüfung, die nach jedem Kürzen gehört, sieht es …
    expect(grenzeVerletzt(masken, bezug)).toMatch(/5 Masken/);
    // … die Bahn kann es zeigen …
    expect(zuvielAn(masken, bezug)).toEqual([{ vonK: 30, bisK: 50 }]);
    // … und der Filmbau wirft, statt eine Maske still wegzulassen.
    const quelle = new Karten();
    quelle.lageSonst = { stand: 'fein', lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 }, faktor: 1 };
    const rahmen = { ...bezug, b: B, h: H };
    expect(() => bildDocAn(null, masken, quelle, 40, 'bild', rahmen)).toThrow(/5 Masken/);
    expect(bildDocAn(null, masken, quelle, 40, 'editor', rahmen).ueberzaehlig).toEqual(['f']);
    // Wo es nur vier sind, geht es.
    expect(bildDocAn(null, masken, quelle, 70, 'bild', rahmen).doc.bereiche).toHaveLength(1);
    expect(zuvielAn(vier, bezug)).toEqual([]);
  });

  it('sagt hinter der Obergrenze des Films „nicht im Film" statt „wird noch verfolgt"', () => {
    const t = tipp('t', scheibe(10, 10));
    const m = maske('m', [spur('t', [5, t])]);
    const rahmen: Rahmen = { ...RAHMEN, maxBilder: 60 };
    expect(imFilm(59, rahmen, 60)).toBe(true);
    expect(imFilm(60, rahmen, 60)).toBe(false);
    const quelle = new Karten();
    const drin = bildDocAn(null, [m], quelle, 50, 'editor', rahmen);
    expect(drin.fehlend).toEqual(['m']);
    expect(drin.jenseits).toEqual([]);
    const draussen = bildDocAn(null, [m], quelle, 70, 'editor', rahmen);
    expect(draussen.fehlend).toEqual([]);
    expect(draussen.jenseits).toEqual(['m']);
    expect(zustandAn(m, 70, null, quelle, rahmen)).toBe(BAHN.jenseits);
    expect(zustandAn(m, 50, null, quelle, rahmen)).toBe(BAHN.offen);
    // Umgestellt: Bild 5 steht im Film vorn – drin, auch wenn es hinten noch einmal käme.
    const umgestellt = { abschnitte: [abschnitt('x', 0, 10), abschnitt('y', 0, 100)], s: S };
    expect(imFilm(5, umgestellt, 60)).toBe(true);
    expect(imFilm(55, umgestellt, 60)).toBe(false);
  });
});

/* ---------- Bahnen ---------- */

describe('bahnZustand', () => {
  const karten = () => {
    const k = new Karten();
    return k;
  };

  it('zeichnet umgestellte und doppelte Abschnitte dort, wo sie im Film stehen', () => {
    // Film: Quelle 20 … 30, dann 0 … 10, dann noch einmal 20 … 30.
    const abschnitte = [abschnitt('x', 20, 30), abschnitt('y', 0, 10), abschnitt('z', 20, 30)];
    const r = radial('r', 10, 10);
    const m = maske('m', [spur('r', [25, r])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 20, bisK: 30 }] },
    });
    const quelle = karten();
    quelle.lageSonst = { stand: 'fein', lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 }, faktor: 1 };
    // 30 Bilder Film, eine Spalte je Bild.
    const bahn = bahnZustand(abschnitte, m, quelle, S, { b: B, h: H }, 30, 30 * S);
    expect(Array.from(bahn.slice(0, 10))).toEqual(Array(10).fill(BAHN.sichtbar));
    expect(Array.from(bahn.slice(10, 20))).toEqual(Array(10).fill(BAHN.aus));
    expect(Array.from(bahn.slice(20, 30))).toEqual(Array(10).fill(BAHN.sichtbar));
  });

  it('zeigt, was noch offen, grob oder veraltet ist', () => {
    const t = tipp('t', scheibe(10, 10));
    const m = maske('m', [spur('t', [0, t])]);
    const quelle = karten();
    const [anker] = m.teile[0].anker;
    quelle.legen(anker, 'vor', 1, 'fein', scheibe(11, 10));
    quelle.legen(anker, 'vor', 2, 'grob', scheibe(12, 10));
    quelle.legen(anker, 'vor', 3, 'veraltet', scheibe(13, 10));
    const bahn = bahnZustand([abschnitt('a', 0, 5)], m, quelle, S, { b: B, h: H }, 5, 5 * S);
    expect(Array.from(bahn)).toEqual([
      BAHN.sichtbar,
      BAHN.sichtbar,
      BAHN.grob,
      BAHN.veraltet,
      BAHN.offen,
    ]);
  });

  it('macht eine Maske unsichtbar, die der Zuschnitt abschneidet', () => {
    const t = tipp('t', scheibe(5, 5, 3));
    const m = maske('m', [spur('t', [0, t])]);
    const zugeschnitten = { ...neuesDoc(B, H), zuschnitt: { x: 20, y: 0, w: 20, h: 30 } };
    expect(zustandAn(m, 0, null, karten(), RAHMEN)).toBe(BAHN.sichtbar);
    expect(zustandAn(m, 0, zugeschnitten, karten(), RAHMEN)).toBe(BAHN.leer);
    expect(sichtbarAn(m, 0, zugeschnitten, karten(), RAHMEN)).toBe(false);
  });

  it('hält Umgekehrtes und Verläufe immer für sichtbar', () => {
    const t = { ...tipp('t', scheibe(5, 5, 3)), umkehren: true };
    const m = maske('m', [spur('t', [0, t])]);
    const zugeschnitten = { ...neuesDoc(B, H), zuschnitt: { x: 20, y: 0, w: 20, h: 30 } };
    expect(zustandAn(m, 0, zugeschnitten, karten(), RAHMEN)).toBe(BAHN.sichtbar);
    const v = maske('v', [spur('v', [0, verlauf('v')])]);
    const quelle = karten();
    quelle.lageSonst = { stand: 'fein', lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 }, faktor: 1 };
    expect(zustandAn(v, 50, null, quelle, RAHMEN)).toBe(BAHN.sichtbar);
  });

  it('sagt „offen", wo die Vorschau nur einen Ersatz hätte', () => {
    // Eine Form ohne Kamerapfad: Die Vorschau zeigt sie am Anker, die Bahn nicht.
    const r = maske('r', [spur('r', [0, radial('r', 10, 10)])]);
    expect(zustandAn(r, 3, null, karten(), RAHMEN)).toBe(BAHN.offen);
    // Zwei Anker, nur eine Seite gerechnet.
    const t = maske('t', [
      spur('t', [0, tipp('t', scheibe(10, 10))], [10, tipp('t', scheibe(20, 10))]),
    ]);
    const quelle = karten();
    quelle.legen(t.teile[0].anker[0], 'vor', 3, 'fein', scheibe(12, 10));
    expect(zustandAn(t, 3, null, quelle, RAHMEN)).toBe(BAHN.offen);
    expect(bildDocAn(null, [t], quelle, 3, 'vorschau', RAHMEN).veraltet).toEqual(['t']);
  });

  it('baut für eine Bahn keine Tiefe und zieht keine Pinselpunkte', () => {
    /*
     * Die Bahn wird bei jeder Standmeldung neu gezeichnet. Für jedes Bild die
     * Tiefenkarte zu ziehen kostete je Bahn eine halbe Sekunde, jeden
     * Pinselpunkt zu ziehen bei 20 000 Punkten ebenso viel.
     */
    const tiefe: Maskenteil = {
      id: 'd',
      modus: 'dazu',
      umkehren: false,
      art: 'tiefe',
      breite: B,
      hoehe: H,
      karte: new Uint8Array(B * H),
      fokus: 0.7,
      spanne: 0.2,
      marke: filmMarke(),
    };
    const punkte: number[] = [];
    for (let i = 0; i < 20_000; i += 1) punkte.push(5 + (i % 20), 5 + ((i * 7) % 20));
    const m = maske('m', [spur('d', [0, tiefe])]);
    const p = maske('p', [spur('p', [0, pinsel('p', punkte)])]);
    let gebaut = 0;
    const quelle = new Karten();
    quelle.lageSonst = { stand: 'fein', lage: { s: 1, w: 0, tx: -1, ty: 0, sicher: 9 }, faktor: 1 };
    quelle.tiefe = () => ({
      stand: 'fein',
      marke: 3,
      get daten() {
        gebaut += 1;
        return { breite: 20, hoehe: 15, werte: new Uint8Array(300) };
      },
    });
    const abschnitte = [abschnitt('a', 0, 600)];
    const beginn = performance.now();
    const bahnT = bahnZustand(abschnitte, m, quelle, S, { b: B, h: H }, 300, 600 * S);
    const bahnP = bahnZustand(abschnitte, p, quelle, S, { b: B, h: H }, 300, 600 * S);
    const dauer = performance.now() - beginn;
    expect(gebaut).toBe(0);
    expect(Math.min(...bahnT)).toBe(BAHN.sichtbar);
    expect(Math.min(...bahnP)).toBe(BAHN.sichtbar);
    expect(dauer).toBeLessThan(150);
    // Der Pinsel wandert trotzdem richtig: 40 Punkte nach rechts geschoben, liegt er ausserhalb.
    quelle.lageSonst = {
      stand: 'fein',
      lage: { s: 1, w: 0, tx: -40, ty: 0, sicher: 9 },
      faktor: 1,
    };
    expect(zustandAn(p, 10, null, quelle, RAHMEN)).toBe(BAHN.leer);
  });

  it('markiert, was hinter der Obergrenze des Films liegt', () => {
    const r = radial('r', 10, 10);
    const m = maske('m', [spur('r', [0, r])]);
    const quelle = karten();
    quelle.lageSonst = { stand: 'fein', lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 }, faktor: 1 };
    const bahn = bahnZustand([abschnitt('a', 0, 10)], m, quelle, S, { b: B, h: H }, 10, 10 * S, 6);
    expect(Array.from(bahn)).toEqual([
      ...Array(6).fill(BAHN.sichtbar),
      ...Array(4).fill(BAHN.jenseits),
    ]);
  });
});

/* ---------- Griffe ---------- */

describe('Griffe', () => {
  // Film: B (Quelle 50 … 60) vor A (0 … 10).
  const bezug = { abschnitte: [abschnitt('B', 50, 60), abschnitt('A', 0, 10)], s: S };

  it('sitzen im ersten Abschnitt, der ihre Grenze zeigt – auch bei umgestellten Abschnitten', () => {
    const g: Geltung = {
      art: 'stuecke',
      stuecke: [
        { vonK: 5, bisK: 8 },
        { vonK: 52, bisK: 58 },
      ],
    };
    expect(griffLage(g, bezug)).toEqual([
      { stueck: 0, art: 'anfang', nummer: 1, filmMs: 400 + 5 * S, frei: true },
      { stueck: 0, art: 'ende', nummer: 1, filmMs: 400 + 8 * S, frei: true },
      { stueck: 1, art: 'anfang', nummer: 0, filmMs: 2 * S, frei: true },
      { stueck: 1, art: 'ende', nummer: 0, filmMs: 8 * S, frei: true },
    ]);
    expect(griffLage({ art: 'ganz' }, bezug)).toEqual([]);
  });

  it('zeigt statt eines Griffs nur einen Hinweis, wenn die Grenze in keinem Abschnitt liegt', () => {
    const g: Geltung = { art: 'stuecke', stuecke: [{ vonK: 45, bisK: 55 }] };
    expect(griffLage(g, bezug)).toEqual([
      { stueck: 0, art: 'anfang', nummer: 0, filmMs: 0, frei: false },
      { stueck: 0, art: 'ende', nummer: 0, filmMs: 5 * S, frei: true },
    ]);
  });

  it('setzt einen Hinweis dorthin, wo das Stück im Film am weitesten reicht', () => {
    // Film: A (0 … 10) vor B (50 … 60). Das Stück 5 … 70 endet hinter dem Film –
    // am weitesten reicht es in B, nicht in A, wo es zuerst vorkommt.
    const film = { abschnitte: [abschnitt('A', 0, 10), abschnitt('B', 50, 60)], s: S };
    const g: Geltung = { art: 'stuecke', stuecke: [{ vonK: 5, bisK: 70 }] };
    expect(griffLage(g, film)).toEqual([
      { stueck: 0, art: 'anfang', nummer: 0, filmMs: 5 * S, frei: true },
      { stueck: 0, art: 'ende', nummer: 1, filmMs: 20 * S, frei: false },
    ]);
    // Ein Stück, das der Film gar nicht zeigt, hat weder Griff noch Hinweis.
    expect(griffLage({ art: 'stuecke', stuecke: [{ vonK: 20, bisK: 30 }] }, film)).toEqual([]);
  });

  it('bleiben beim Ziehen in ihrem Abschnitt und lassen mindestens ein Bild', () => {
    const g: Geltung = { art: 'stuecke', stuecke: [{ vonK: 52, bisK: 58 }] };
    const [anfang, ende] = griffLage(g, bezug);
    // Weit nach rechts, über den Abschnitt hinaus: bleibt ein Bild vor dem Ende.
    expect(griffZiehen(g, anfang, 9999, bezug)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 57, bisK: 58 }],
    });
    // Nach links ins Nichts: an den Anfang des Abschnitts.
    expect(griffZiehen(g, anfang, -500, bezug)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 50, bisK: 58 }],
    });
    // Das Ende bleibt in B, auch wenn der Finger bis in A reicht.
    expect(griffZiehen(g, ende, 700, bezug)).toEqual({
      art: 'stuecke',
      stuecke: [{ vonK: 52, bisK: 60 }],
    });
  });
});

/* ---------- Vom Editor zurück ---------- */

describe('editorAenderung', () => {
  const bezug = { abschnitte: EINER, s: S };

  /** Maske „Motiv" mit einem Tipp (Anker bei 10) und eine, die bei 20 nicht gilt. */
  function aufbau() {
    const motiv = maske('motiv', [spur('t1', [10, tipp('t1', scheibe(10, 10))])], {
      name: 'Motiv',
    });
    const himmel = maske('himmel', [spur('r1', [60, radial('r1', 5, 5)])], {
      name: 'Himmel',
      farbe: 1,
      geltung: { art: 'stuecke', stuecke: [{ vonK: 50, bisK: 70 }] },
    });
    const masken = [motiv, himmel];
    const karten = new Karten();
    karten.legen(motiv.teile[0].anker[0], 'vor', 20, 'fein', scheibe(14, 10), {
      liste: [{ x: 10, y: 10 }],
      mx: 10,
      my: 10,
    });
    const z = bildDocAn(neuesDoc(B, H), masken, karten, 20, 'editor', RAHMEN);
    const gezeigt: Gezeigt = { k: 20, z, vorSitzung: masken };
    return { motiv, himmel, masken, gezeigt, z };
  }

  it('ändert nichts bei der ersten Meldung nach dem Laden', () => {
    const { masken, gezeigt, z } = aufbau();
    const geloescht = new Map<string, Maske>();
    const erg = editorAenderung(docKopie(z.doc), gezeigt, masken, geloescht, bezug);
    expect(erg.masken).toBe(masken);
    expect(erg.geloescht).toBe(geloescht);
    expect(erg.neu).toEqual([]);
    expect(erg.clipDoc.bereiche).toEqual([]);
  });

  it('übernimmt einen Regler ohne neuen Anker', () => {
    const { masken, gezeigt, z, motiv, himmel } = aufbau();
    const doc = docKopie(z.doc);
    doc.bereiche[0].anpassung.belichtung = 0.5;
    doc.anpassung.kontrast = 0.3;
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    expect(erg.masken[0].anpassung.belichtung).toBe(0.5);
    expect(erg.masken[0].teile).toBe(motiv.teile);
    expect(erg.masken[1]).toBe(himmel);
    expect(erg.clipDoc.anpassung.kontrast).toBe(0.3);
  });

  it('übernimmt Bokeh und Weichzeichnen ohne neuen Anker', () => {
    /*
     * Beide Unschärfen gehören zur Maske, nicht zu einem Anker: Ein Regler
     * ändert, WIE stark die Bahn wirkt, nicht, WO sie liegt. `FELDER` kennt
     * sie deshalb nicht, und es darf weder ein Anker noch eine neue Kennung
     * noch ein Neuberechnen daraus entstehen.
     */
    const { masken, gezeigt, z, motiv, himmel } = aufbau();
    expect(z.doc.bereiche[0].anpassung.bokeh).toBe(0);
    const doc = docKopie(z.doc);
    doc.bereiche[0].anpassung.bokeh = 0.6;
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    expect(erg.neu).toEqual([]);
    expect(erg.masken[0].anpassung.bokeh).toBe(0.6);
    expect(erg.masken[0].anpassung.unschaerfe).toBe(0);
    // Die Teile sind dasselbe Feld, jeder Anker dasselbe Objekt.
    expect(erg.masken[0].teile).toBe(motiv.teile);
    expect(erg.masken[0].teile[0].anker[0]).toBe(motiv.teile[0].anker[0]);
    expect(erg.masken[1]).toBe(himmel);

    const zweiter = docKopie(z.doc);
    zweiter.bereiche[0].anpassung.unschaerfe = 0.25;
    const erg2 = editorAenderung(zweiter, gezeigt, masken, new Map(), bezug);
    expect(erg2.masken[0].anpassung.unschaerfe).toBe(0.25);
    expect(erg2.masken[0].anpassung.bokeh).toBe(0);
    expect(erg2.masken[0].teile).toBe(motiv.teile);
    expect(erg2.neu).toEqual([]);
  });

  it('hält vier Bereiche mit vier Werten getrennt', () => {
    const masken = ['a', 'b', 'c', 'd'].map((id, i) =>
      maske(id, [spur(`r${id}`, [5, radial(`r${id}`, 5 + i * 8, 5)])], { farbe: i }),
    );
    // Reine Formen brauchen eine Kamera, sonst sind sie „fehlend“: eine ruhige.
    const karten = new Karten();
    karten.lageSonst = {
      stand: 'fein',
      lage: { s: 1, w: 0, tx: 0, ty: 0, sicher: 9 },
      faktor: 2,
    };
    const z = bildDocAn(neuesDoc(B, H), masken, karten, 20, 'editor', RAHMEN);
    const gezeigt: Gezeigt = { k: 20, z, vorSitzung: masken };
    expect(z.doc.bereiche.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']);

    const doc = docKopie(z.doc);
    [0.1, 0.4, 0.7, 1].forEach((wert, i) => {
      doc.bereiche[i].anpassung.bokeh = wert;
      doc.bereiche[i].anpassung.unschaerfe = 1 - wert;
    });
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    expect(erg.neu).toEqual([]);
    expect(erg.masken.map((m) => m.anpassung.bokeh)).toEqual([0.1, 0.4, 0.7, 1]);
    erg.masken.forEach((m, i) =>
      expect(m.anpassung.unschaerfe).toBeCloseTo([0.9, 0.6, 0.3, 0][i], 12),
    );
    erg.masken.forEach((m, i) => expect(m.teile).toBe(masken[i].teile));

    // Und beim nächsten Zusammensetzen stehen sie wieder im Bilddokument,
    // je Bereich der eigene Wert.
    const wieder = bildDocAn(neuesDoc(B, H), erg.masken, karten, 20, 'editor', RAHMEN);
    expect(wieder.doc.bereiche.map((b) => b.anpassung.bokeh)).toEqual([0.1, 0.4, 0.7, 1]);
  });

  it('holt beim Rückgängig im Editor den alten Wert zurück', () => {
    const { masken, gezeigt, z } = aufbau();
    const vor = docKopie(z.doc);
    const nach = docKopie(z.doc);
    nach.bereiche[0].anpassung.bokeh = 0.8;
    const hin = editorAenderung(nach, gezeigt, masken, new Map(), bezug);
    expect(hin.masken[0].anpassung.bokeh).toBe(0.8);
    const zurueck = editorAenderung(vor, gezeigt, hin.masken, new Map(), bezug);
    expect(zurueck.masken[0].anpassung.bokeh).toBe(0);
    expect(zurueck.masken[0].teile).toBe(masken[0].teile);
  });

  it('setzt bei einem neuen Tipp einen Anker HIER – die alten bleiben', () => {
    const { masken, gezeigt, z, motiv } = aufbau();
    const doc = docKopie(z.doc);
    const alt = doc.bereiche[0].teile[0];
    const neu = {
      ...alt,
      punkte: [
        { x: 14, y: 10 },
        { x: 20, y: 20 },
      ],
      alpha: scheibe(15, 12),
      marke: filmMarke(),
    } as Maskenteil;
    doc.bereiche[0].teile = [neu];
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    const anker = erg.masken[0].teile[0].anker;
    expect(anker.map((a) => a.k)).toEqual([10, 20]);
    expect(anker[0]).toBe(motiv.teile[0].anker[0]);
    expect(anker[1].teil).toBe(neu);
    // Dieselbe Meldung noch einmal ergibt dieselben Objekte – kein neuer Anker je Reglerschritt.
    const nochmal = editorAenderung(doc, gezeigt, erg.masken, erg.geloescht, bezug);
    expect(nochmal.masken).toBe(erg.masken);
  });

  it('holt beim Rückgängig die Anker von vor der Sitzung zurück', () => {
    const { masken, gezeigt, z, motiv } = aufbau();
    const doc = docKopie(z.doc);
    doc.bereiche[0].teile = [
      { ...doc.bereiche[0].teile[0], marke: filmMarke(), alpha: scheibe(3, 3) } as Maskenteil,
    ];
    const geaendert = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    expect(geaendert.masken[0].teile[0].anker).toHaveLength(2);
    // ↺: der Editor hat wieder das ausgegebene Teil – im selben Feld oder in einem neuen.
    const zurueck = editorAenderung(docKopie(z.doc), gezeigt, geaendert.masken, new Map(), bezug);
    expect(zurueck.masken[0].teile[0]).toBe(motiv.teile[0]);
    const alsNeuesFeld = docKopie(z.doc);
    alsNeuesFeld.bereiche[0].teile = [...alsNeuesFeld.bereiche[0].teile];
    const auchZurueck = editorAenderung(alsNeuesFeld, gezeigt, geaendert.masken, new Map(), bezug);
    expect(auchZurueck.masken[0].teile[0]).toBe(motiv.teile[0]);
  });

  it('schreibt einen Moduswechsel in alle Anker – ohne neuen', () => {
    const { masken, gezeigt, z, motiv } = aufbau();
    const doc = docKopie(z.doc);
    doc.bereiche[0].teile = [{ ...doc.bereiche[0].teile[0], modus: 'weg' } as Maskenteil];
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    const anker = erg.masken[0].teile[0].anker;
    expect(anker).toHaveLength(1);
    expect(anker[0].id).toBe(motiv.teile[0].anker[0].id);
    expect(anker[0].teil.modus).toBe('weg');
    expect(anker[0].teil).not.toBe(motiv.teile[0].anker[0].teil);
  });

  it('lässt bei neuer Toleranz alle anderen Anker neu rechnen', () => {
    const { masken, gezeigt, z, motiv } = aufbau();
    const doc = docKopie(z.doc);
    const neu = {
      ...doc.bereiche[0].teile[0],
      toleranz: 60,
      alpha: scheibe(14, 10, 6),
      marke: filmMarke(),
    } as Maskenteil;
    doc.bereiche[0].teile = [neu];
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    const [dort, hier] = erg.masken[0].teile[0].anker;
    expect(hier).toMatchObject({ k: 20, teil: neu });
    expect(dort.k).toBe(10);
    expect(dort.neuRechnen).toBe(true);
    expect(dort.id).not.toBe(motiv.teile[0].anker[0].id);
    expect(dort.teil).toMatchObject({ toleranz: 60 });
  });

  it('behält den Anker eines Tipps, wenn danach nur Umkehren und Modus folgen – und ↺ stimmt', () => {
    /*
     * Der Normalfall „Motiv antippen, dann Umkehren": verglichen mit dem
     * AUSGEGEBENEN Teil unterschied sich das zweite lokal und global – ein
     * neuer Anker, und die Verfolgung begann von vorn.
     */
    const { masken, gezeigt, z, motiv } = aufbau();
    const mit = (teil: Maskenteil) => {
      const doc = docKopie(z.doc);
      doc.bereiche[0].teile = [teil];
      return doc;
    };
    const t1 = {
      ...z.doc.bereiche[0].teile[0],
      punkte: [{ x: 15, y: 12 }],
      alpha: scheibe(15, 12),
      marke: filmMarke(),
    } as Maskenteil;
    const e1 = editorAenderung(mit(t1), gezeigt, masken, new Map(), bezug);
    const hierId = e1.masken[0].teile[0].anker[1].id;
    const dortId = motiv.teile[0].anker[0].id;
    const t2 = { ...t1, umkehren: true } as Maskenteil;
    const e2 = editorAenderung(mit(t2), gezeigt, e1.masken, e1.geloescht, bezug);
    const t3 = { ...t2, modus: 'weg' } as Maskenteil;
    const e3 = editorAenderung(mit(t3), gezeigt, e2.masken, e2.geloescht, bezug);
    for (const erg of [e2, e3]) {
      const anker = erg.masken[0].teile[0].anker;
      expect(anker.map((a) => a.id)).toEqual([dortId, hierId]);
      expect(anker.every((a) => a.teil.umkehren)).toBe(true);
      expect(anker.some((a) => a.neuRechnen)).toBe(false);
    }
    expect(e3.masken[0].teile[0].anker.map((a) => a.teil.modus)).toEqual(['weg', 'weg']);
    expect(e3.masken[0].teile[0].anker[1].teil).toBe(t3);
    // Dieselbe Meldung noch einmal: dieselben Objekte.
    expect(editorAenderung(mit(t3), gezeigt, e3.masken, e3.geloescht, bezug).masken).toBe(
      e3.masken,
    );
    // ↺ Schritt für Schritt: dieselben Kennungen, die Felder von damals.
    const r2 = editorAenderung(mit(t2), gezeigt, e3.masken, e3.geloescht, bezug);
    expect(r2.masken[0].teile[0].anker.map((a) => a.id)).toEqual([dortId, hierId]);
    expect(r2.masken[0].teile[0].anker.map((a) => a.teil.modus)).toEqual(['dazu', 'dazu']);
    const r1 = editorAenderung(mit(t1), gezeigt, r2.masken, r2.geloescht, bezug);
    expect(r1.masken[0].teile[0].anker.map((a) => a.id)).toEqual([dortId, hierId]);
    expect(r1.masken[0].teile[0].anker.some((a) => a.teil.umkehren)).toBe(false);
    // … bis zum ausgegebenen Teil: die Anker von vor der Sitzung.
    const r0 = editorAenderung(docKopie(z.doc), gezeigt, r1.masken, r1.geloescht, bezug);
    expect(r0.masken[0].teile[0]).toBe(motiv.teile[0]);
    // Ein neuer Tipp danach ist wieder ein neuer Anker – wie es sein soll.
    const t4 = { ...t3, punkte: [{ x: 16, y: 12 }], marke: filmMarke() } as Maskenteil;
    const e4 = editorAenderung(mit(t4), gezeigt, e3.masken, e3.geloescht, bezug);
    expect(e4.masken[0].teile[0].anker[1].id).not.toBe(hierId);
    // Und ↺ von dort zurück auf den umgekehrten Tipp findet dessen Anker wieder.
    const zurueckT3 = editorAenderung(mit(t3), gezeigt, e4.masken, e4.geloescht, bezug);
    expect(zurueckT3.masken[0].teile[0].anker[1].id).toBe(hierId);
  });

  it('behält auch in einer hier angelegten Maske den Anker bei einer rein globalen Änderung', () => {
    const { masken, gezeigt, z } = aufbau();
    const mitNeuer = (teil: Maskenteil) => {
      const doc = docKopie(z.doc);
      doc.bereiche.push({
        id: 'bNeu',
        name: 'Neu',
        aktiv: true,
        teile: [teil],
        anpassung: { ...BEREICH_NEUTRAL },
      });
      return doc;
    };
    const r = radial('rNeu', 20, 20);
    const e1 = editorAenderung(mitNeuer(r), gezeigt, masken, new Map(), bezug);
    const id = e1.masken.find((m) => m.id === 'bNeu')?.teile[0].anker[0].id;
    const weicher = { ...r, weichheit: 0.8 } as Maskenteil;
    const e2 = editorAenderung(mitNeuer(weicher), gezeigt, e1.masken, e1.geloescht, bezug);
    const anker = e2.masken.find((m) => m.id === 'bNeu')?.teile[0].anker[0];
    expect(anker?.id).toBe(id);
    expect(anker?.teil).toBe(weicher);
    // Eine lokale Änderung dagegen ist ein neuer Anker.
    const verschoben = { ...weicher, mitte: { x: 22, y: 20 } } as Maskenteil;
    const e3 = editorAenderung(mitNeuer(verschoben), gezeigt, e2.masken, e2.geloescht, bezug);
    expect(e3.masken.find((m) => m.id === 'bNeu')?.teile[0].anker[0].id).not.toBe(id);
  });

  it('legt einen neuen Bereich als Maske für den ganzen Film an', () => {
    const { masken, gezeigt, z } = aufbau();
    const doc = docKopie(z.doc);
    const r = radial('neuR', 20, 20);
    doc.bereiche.push({
      id: 'bNeu',
      name: 'Motiv',
      aktiv: true,
      teile: [r],
      anpassung: { ...BEREICH_NEUTRAL },
    });
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    expect(erg.neu).toEqual(['bNeu']);
    const neu = erg.masken[2];
    expect(neu).toMatchObject({ id: 'bNeu', name: 'Motiv 2', geltung: { art: 'ganz' }, farbe: 2 });
    expect(neu.teile[0].anker).toEqual([expect.objectContaining({ k: 20, teil: r })]);
    // Die nächste Meldung trägt im Editor noch „Motiv" – die Maske bleibt „Motiv 2".
    const nochmal = editorAenderung(doc, gezeigt, erg.masken, erg.geloescht, bezug);
    expect(nochmal.masken).toBe(erg.masken);
    expect(nochmal.neu).toEqual([]);
  });

  it('löscht eine ausgegebene Maske im ganzen Film – und ↺ holt sie an ihre Stelle zurück', () => {
    const { masken, gezeigt, z, motiv, himmel } = aufbau();
    const ohne = docKopie(z.doc);
    ohne.bereiche = [];
    const erg = editorAenderung(ohne, gezeigt, masken, new Map(), bezug);
    expect(erg.masken).toEqual([himmel]);
    expect(erg.geloescht.get('motiv')).toBe(motiv);
    const zurueck = editorAenderung(docKopie(z.doc), gezeigt, erg.masken, erg.geloescht, bezug);
    expect(zurueck.masken).toEqual([motiv, himmel]);
    expect(zurueck.masken[0]).toBe(motiv);
    expect(zurueck.geloescht.has('motiv')).toBe(false);
  });

  it('lässt eine nicht ausgegebene Maske in Ruhe – sie ist nicht gelöscht', () => {
    const { masken, gezeigt, z, himmel } = aufbau();
    expect(z.enthalten.has('himmel')).toBe(false);
    const erg = editorAenderung(docKopie(z.doc), gezeigt, masken, new Map(), bezug);
    expect(erg.masken[1]).toBe(himmel);
    expect(erg.geloescht.size).toBe(0);
  });

  it('lehnt eine Maske ab, die an einem Bild die fünfte wäre', () => {
    const vier = ['a', 'b', 'c', 'd'].map((id, i) =>
      maske(id, [spur(`r${id}`, [20, radial(`r${id}`, 5, 5)])], { farbe: i }),
    );
    const z = bildDocAn(null, vier, new Karten(), 20, 'editor', RAHMEN);
    expect(bereichePlatz(vier, { k: 20, z, vorSitzung: vier }, bezug)).toMatchObject({ max: 4 });
    const doc = docKopie(z.doc);
    doc.bereiche.push({
      id: 'e',
      name: 'E',
      aktiv: true,
      teile: [radial('re', 1, 1)],
      anpassung: { ...BEREICH_NEUTRAL },
    });
    const erg = editorAenderung(doc, { k: 20, z, vorSitzung: vier }, vier, new Map(), bezug);
    expect(erg.abgelehnt).toMatch(/höchstens 4/);
    expect(erg.masken).toBe(vier);
  });

  it('sagt dem Editor, warum kein neuer Bereich mehr geht', () => {
    // Drei gelten hier, eine vierte nur anderswo – an diesem Bild wären Plätze frei,
    // aber eine neue Maske gälte auch dort, wo schon vier wirken.
    const hier = ['a', 'b', 'c'].map((id) =>
      maske(id, [spur(`r${id}`, [20, radial(`r${id}`, 5, 5)])]),
    );
    const dort = maske('d', [spur('rd', [60, radial('rd', 5, 5)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 50, bisK: 70 }] },
    });
    const masken = [...hier, dort];
    const z = bildDocAn(null, masken, new Karten(), 20, 'editor', RAHMEN);
    const platz = bereichePlatz(masken, { k: 20, z, vorSitzung: masken }, bezug);
    expect(platz.max).toBe(3);
    expect(platz.grund).toMatch(/schon 4 Masken/);
  });

  it('ordnet Masken in der Reihenfolge des Editors – auf ihren alten Plätzen', () => {
    const a = maske('a', [spur('ra', [20, radial('ra', 5, 5)])]);
    const x = maske('x', [spur('rx', [60, radial('rx', 5, 5)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 50, bisK: 70 }] },
    });
    const b = maske('b', [spur('rb', [20, radial('rb', 5, 5)])]);
    const masken = [a, x, b];
    const z = bildDocAn(null, masken, new Karten(), 20, 'editor', RAHMEN);
    const doc = docKopie(z.doc);
    doc.bereiche.reverse();
    const erg = editorAenderung(doc, { k: 20, z, vorSitzung: masken }, masken, new Map(), bezug);
    expect(erg.masken.map((m) => m.id)).toEqual(['b', 'x', 'a']);
  });

  it('reicht beim Kopieren des Dokuments die Teilefelder durch (Wächter für den Router)', () => {
    // Der Router erkennt „unverändert" an der Identität des Teilefelds. Kopierte
    // `docKopie` es, wäre jede Meldung eine Änderung – und jede ein neuer Anker.
    const { z } = aufbau();
    expect(docKopie(z.doc).bereiche[0].teile).toBe(z.doc.bereiche[0].teile);
  });

  it('zählt in dieser Sitzung angelegte Masken zum Editor – kein Platz zu wenig', () => {
    const { masken, gezeigt, z } = aufbau();
    // Hier gilt nur „Motiv"; „Himmel" gilt bei 50 … 70 – dort wären es mit
    // zwei neuen (die im ganzen Film gelten) vier. Also drei im Editor.
    expect(bereichePlatz(masken, gezeigt, bezug).max).toBe(3);
    const doc = docKopie(z.doc);
    doc.bereiche.push({
      id: 'bNeu',
      name: 'Neu',
      aktiv: true,
      teile: [radial('rNeu', 20, 20)],
      anpassung: { ...BEREICH_NEUTRAL },
    });
    const erg = editorAenderung(doc, gezeigt, masken, new Map(), bezug);
    // Der Editor hat jetzt zwei Bereiche und darf weiter bis drei – nicht
    // nur bis zwei, weil die neue Maske noch in keiner Zusammensetzung stand.
    expect(bereichePlatz(erg.masken, gezeigt, bezug).max).toBe(3);
  });

  it('löscht eine in der Sitzung angelegte Maske, wenn der Editor sie entfernt – ↺ holt sie zurück', () => {
    const { masken, gezeigt, z } = aufbau();
    const mitNeuer = docKopie(z.doc);
    const r = radial('rNeu', 20, 20);
    mitNeuer.bereiche.push({
      id: 'bNeu',
      name: 'Neu',
      aktiv: true,
      teile: [r],
      anpassung: { ...BEREICH_NEUTRAL },
    });
    const angelegt = editorAenderung(mitNeuer, gezeigt, masken, new Map(), bezug);
    const neu = angelegt.masken.find((m) => m.id === 'bNeu');
    const ohne = editorAenderung(
      docKopie(z.doc),
      gezeigt,
      angelegt.masken,
      angelegt.geloescht,
      bezug,
    );
    expect(ohne.masken.map((m) => m.id)).toEqual(['motiv', 'himmel']);
    expect(ohne.geloescht.get('bNeu')).toBe(neu);
    const zurueck = editorAenderung(mitNeuer, gezeigt, ohne.masken, ohne.geloescht, bezug);
    expect(zurueck.masken.find((m) => m.id === 'bNeu')).toBe(neu);
  });

  it('löscht eine Maske aus „Hier trennen" nicht, bevor der Editor neu geladen hat', () => {
    // Die Zeitleiste trennt „Motiv", während der Editor offen ist; die zweite
    // Hälfte gab es vor der Sitzung nicht und fehlt in seinen Meldungen.
    const { masken, gezeigt, z } = aufbau();
    const getrennt = maskeTrennen(masken, 'motiv', bezug, 30 * S, 'motiv2');
    if ('abgelehnt' in getrennt) throw new Error(getrennt.abgelehnt);
    const doc = docKopie(z.doc);
    doc.bereiche[0].anpassung.belichtung = 0.4;
    const erg = editorAenderung(doc, gezeigt, getrennt.masken, new Map(), bezug);
    expect(erg.masken.map((m) => m.id)).toEqual(['motiv', 'motiv2', 'himmel']);
    expect(erg.geloescht.size).toBe(0);
  });

  it('kennt die Felder: lokal, global, neu', () => {
    expect(feldArt('radial', 'weichheit')).toBe('global');
    expect(feldArt('radial', 'mitte')).toBe('lokal');
    expect(feldArt('tiefe', 'fokus')).toBe('global');
    expect(feldArt('tiefe', 'karte')).toBe('lokal');
    expect(feldArt('tipp', 'toleranz')).toBe('neu');
    expect(feldArt('tipp', 'mitNetz')).toBe('neu');
    expect(feldArt('netz', 'netz')).toBe('neu');
    expect(feldArt('pinsel', 'modus')).toBe('global');
    expect(feldArt('verlauf', 'umkehren')).toBe('global');
    expect(feldArt('netz', 'unbekannt')).toBe('lokal');
    const r = radial('r', 1, 1);
    expect(teilUnterschied(r, { ...r, weichheit: 0.9 } as Maskenteil)).toEqual({
      lokal: false,
      global: true,
      neu: false,
    });
    // Ein gleichwertiger neuer Mittelpunkt ist keine Änderung.
    expect(teilUnterschied(r, { ...r, mitte: { x: 1, y: 1 } } as Maskenteil)).toEqual({
      lokal: false,
      global: false,
      neu: false,
    });
  });
});

/* ---------- Werkzeuge der Bahn ---------- */

describe('Hier trennen', () => {
  const bezug = { abschnitte: EINER, s: S };

  it('gibt zwei Masken mit denselben Ankern und neuen Teilkennungen', () => {
    const t = tipp('t1', scheibe(10, 10));
    const m = maske('m', [spur('t1', [10, t])], { name: 'Person' });
    const erg = maskeTrennen([m], 'm', bezug, 5 * S, 'm2');
    if ('abgelehnt' in erg) throw new Error(erg.abgelehnt);
    const [vorn, hinten] = erg.masken;
    expect(vorn.geltung).toEqual({ art: 'stuecke', stuecke: [{ vonK: 0, bisK: 5 }] });
    expect(hinten).toMatchObject({ id: 'm2', name: 'Person 2', farbe: 1 });
    expect(hinten.geltung).toEqual({ art: 'stuecke', stuecke: [{ vonK: 5, bisK: 100 }] });
    expect(hinten.teile[0].anker[0]).toBe(m.teile[0].anker[0]);
    expect(hinten.teile[0].id).not.toBe('t1');
  });

  it('gibt der zweiten Maske ihre eigenen Teile – der Router ordnet richtig zu', () => {
    const t = tipp('t1', scheibe(10, 10));
    const m = maske('m', [spur('t1', [10, t])]);
    const erg = maskeTrennen([m], 'm', bezug, 5 * S, 'm2');
    if ('abgelehnt' in erg) throw new Error(erg.abgelehnt);
    const masken = erg.masken;
    // Am Anker (Bild 10) gilt nur noch die zweite.
    const z = bildDocAn(null, masken, new Karten(), 10, 'editor', RAHMEN);
    expect(z.doc.bereiche.map((b) => b.id)).toEqual(['m2']);
    const teil = z.doc.bereiche[0].teile[0];
    expect(teil.id).toBe(masken[1].teile[0].id);
    const doc = docKopie(z.doc);
    const neu = { ...teil, alpha: scheibe(11, 11), marke: filmMarke() } as Maskenteil;
    doc.bereiche[0].teile = [neu];
    const routung = editorAenderung(
      doc,
      { k: 10, z, vorSitzung: masken },
      masken,
      new Map(),
      bezug,
    );
    expect(routung.masken[0]).toBe(masken[0]);
    expect(routung.masken[1].teile[0].anker[0].teil).toBe(neu);
  });

  it('trennt nicht, wo nichts zu trennen ist, und nicht über die Grenze', () => {
    const m = maske('m', [spur('r', [10, radial('r', 1, 1)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 20, bisK: 30 }] },
    });
    expect(maskeTrennen([m], 'm', bezug, 5 * S)).toMatchObject({ abgelehnt: expect.any(String) });
    const voll = Array.from({ length: MASKEN_MAX }, (_, i) =>
      maske(`m${i}`, [spur(`r${i}`, [10, radial(`r${i}`, 1, 1)])], {
        geltung: { art: 'stuecke', stuecke: [{ vonK: i * 10, bisK: i * 10 + 10 }] },
      }),
    );
    expect(maskeTrennen(voll, 'm0', bezug, 5 * S)).toMatchObject({
      abgelehnt: expect.stringMatching(/Höchstens/),
    });
  });
});

describe('ankerEntfernen', () => {
  it('nimmt nur Anker weg, neben denen noch einer bleibt', () => {
    const m = maske('m', [
      spur('a', [10, radial('a', 1, 1)], [30, radial('a', 2, 2)]),
      spur('b', [30, radial('b', 1, 1)]),
    ]);
    const erg = ankerEntfernen([m], 'm', 30);
    expect(erg[0].teile[0].anker.map((a) => a.k)).toEqual([10]);
    expect(erg[0].teile[1]).toBe(m.teile[1]);
    expect(ankerEntfernen([m], 'm', 99)[0]).toBe(m);
  });
});

/* ---------- Übergänge ---------- */

describe('bereicheUmwandeln', () => {
  function docMit(...bereiche: { id: string; name: string; teile: Maskenteil[] }[]): BildDoc {
    return {
      ...neuesDoc(B, H),
      bereiche: bereiche.map((b) => ({ ...b, aktiv: true, anpassung: { ...BEREICH_NEUTRAL } })),
    };
  }

  it('macht aus den Bereichen geteilter Hälften EINE Maske je Bereich', () => {
    const doc = docMit(
      { id: 'b1', name: 'Motiv', teile: [tipp('t1', scheibe(10, 10))] },
      { id: 'b2', name: 'Himmel', teile: [verlauf('v1')] },
    );
    const abschnitte: Abschnitt[] = [
      { id: 'a', vonMs: 0, bisMs: 2000, doc, standMs: 500 },
      // Die zweite Hälfte wartete noch auf ihre Mitnahme: Die Masken gehören zu 500.
      { id: 'b', vonMs: 2000, bisMs: 4000, doc, standMs: 2020, teileMs: 500 },
    ];
    const erg = bereicheUmwandeln(abschnitte, [], S);
    expect(erg.verworfen).toBe(0);
    expect(erg.masken.map((m) => m.id)).toEqual(['b1', 'b2']);
    for (const m of erg.masken) {
      expect(m.geltung).toEqual({ art: 'abschnitte', ids: ['a', 'b'] });
      expect(m.teile[0].anker[0].k).toBe(12);
    }
    expect(erg.masken.map((m) => m.farbe)).toEqual([0, 1]);
    const [a, b] = erg.abschnitte;
    expect(a.doc?.bereiche).toEqual([]);
    expect(a.doc).toBe(b.doc);
    expect(b.teileMs).toBeUndefined();
  });

  it('gibt einer schon vergebenen Kennung eine neue', () => {
    const erst = docMit({ id: 'b1', name: 'Motiv', teile: [radial('r', 1, 1)] });
    const bearbeitet = docMit({ id: 'b1', name: 'Motiv', teile: [radial('r', 3, 3)] });
    const erg = bereicheUmwandeln(
      [
        { id: 'a', vonMs: 0, bisMs: 400, doc: erst, standMs: 20 },
        { id: 'b', vonMs: 400, bisMs: 800, doc: bearbeitet, standMs: 420 },
      ],
      [],
      S,
      { b: B, h: H },
    );
    expect(erg.masken).toHaveLength(2);
    expect(erg.masken[0].id).toBe('b1');
    expect(erg.masken[1].id).not.toBe('b1');
    expect(erg.masken[1].name).toBe('Motiv 2');
    // Wie nach „Hier trennen": eigene Teilkennungen, damit der Router nicht verwechselt.
    expect(erg.masken[0].teile[0].id).toBe('r');
    expect(erg.masken[1].teile[0].id).not.toBe('r');
    expect(erg.masken[0].geltung).toEqual({ art: 'abschnitte', ids: ['a'] });
    expect(erg.masken[1].geltung).toEqual({ art: 'abschnitte', ids: ['b'] });
    // Ohne Bereiche tun die Dokumente nichts mehr – sie werden `null`.
    expect(erg.abschnitte.map((a) => a.doc)).toEqual([null, null]);
  });

  it('zählt, was nicht mehr passt', () => {
    const doc = docMit(
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        name: `B${i}`,
        teile: [radial(`r${i}`, 1, 1)],
      })),
    );
    const erg = bereicheUmwandeln([{ id: 'a', vonMs: 0, bisMs: 400, doc, standMs: 20 }], [], S);
    expect(erg.masken).toHaveLength(4);
    expect(erg.verworfen).toBe(1);
  });

  it('lässt Abschnitte ohne Bereiche, wie sie sind', () => {
    const abschnitte = [abschnitt('a', 0, 10)];
    const masken: Maske[] = [];
    const erg = bereicheUmwandeln(abschnitte, masken, S);
    expect(erg.abschnitte).toBe(abschnitte);
    expect(erg.masken).toBe(masken);
  });
});

describe('maskenUmrastern', () => {
  it('legt Anker auf das Bild, das ihre alte Mitte enthält, und Stücke auf die nächste Kante', () => {
    const m = maske('m', [spur('r', [10, radial('r', 1, 1)], [11, radial('r', 2, 2)])], {
      geltung: { art: 'stuecke', stuecke: [{ vonK: 10, bisK: 20 }] },
    });
    // 25 → 10 Bilder je Sekunde: Bild 10 (420 ms) → 4, Bild 11 (460 ms) → 4 – der spätere gewinnt.
    const [neu] = maskenUmrastern([m], 40, 100);
    expect(neu.teile[0].anker.map((a) => a.k)).toEqual([4]);
    expect(neu.teile[0].anker[0].id).toBe(m.teile[0].anker[1].id);
    expect(neu.geltung).toEqual({ art: 'stuecke', stuecke: [{ vonK: 4, bisK: 8 }] });
    expect(maskenUmrastern([m], 40, 40)[0]).toBe(m);
  });
});
