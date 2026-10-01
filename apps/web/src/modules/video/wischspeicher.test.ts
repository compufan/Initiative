import { afterEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import type { LeseOptionen, Lesung, Mitschnitt } from './leserDienst.js';
import {
  BILD_MAX_BYTES,
  ENTPACKT_MAX,
  FEHLER_FOLGE_MAX,
  WISCH_MELDEN_MS,
  Wischspeicher,
  grobSchritt,
  naechstesBild,
  naechstesFehlendes,
  stufeBis,
  stufeVon,
  wischToleranz,
  zuVerdraengen,
  type WischBild,
  type WischFormat,
} from './wischspeicher.js';

/**
 * Der Wischspeicher: die reinen Rechnungen (Stufen, Reihenfolge, Suche im
 * Umkreis, Verdrängen) und die Klasse gegen einen Ersatz für den
 * `leserDienst`.
 *
 * Der Ersatz liefert kleine „Bilder" von einstellbarer Grösse und schreibt
 * mit, was in welcher Stufe verlangt wurde; entpackt wird in Ersatzbildern,
 * deren `close` gezählt wird.
 */

const S = 40;
const WEBP: WischFormat = { typ: 'image/webp', guete: 0.75 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ---------- Das Rechenbare ---------- */

describe('grobSchritt', () => {
  it('nimmt etwa eine halbe Sekunde, als Zweierpotenz zwischen 4 und 32', () => {
    expect(grobSchritt(40)).toBe(16); // 25 Bilder/s
    expect(grobSchritt(1000 / 30)).toBe(16);
    expect(grobSchritt(1000 / 60)).toBe(32);
    expect(grobSchritt(100)).toBe(8); // 10 Bilder/s
    expect(grobSchritt(200)).toBe(4);
    expect(grobSchritt(1000)).toBe(4);
    expect(grobSchritt(5)).toBe(32);
  });

  it('gibt als Toleranz die Hälfte – höchstens so weit liegt dann ein Bild der Stufe 0 daneben', () => {
    expect(wischToleranz(40)).toBe(8);
    expect(wischToleranz(1000 / 60)).toBe(16);
  });
});

describe('stufeVon', () => {
  it('ordnet jedes Rasterbild nach seinem absoluten k einer Stufe zu', () => {
    // schritt 16: jedes 16., 8., 4., 2., alle übrigen
    expect(stufeVon(0, 16)).toBe(0);
    expect(stufeVon(48, 16)).toBe(0);
    expect(stufeVon(8, 16)).toBe(1);
    expect(stufeVon(24, 16)).toBe(1);
    expect(stufeVon(4, 16)).toBe(2);
    expect(stufeVon(12, 16)).toBe(2);
    expect(stufeVon(2, 16)).toBe(3);
    expect(stufeVon(6, 16)).toBe(3);
    expect(stufeVon(1, 16)).toBe(4);
    expect(stufeVon(7, 16)).toBe(4);
  });

  it('kommt bei kleinem Schritt mit weniger Stufen aus', () => {
    // schritt 4: 4 → 0, 2 → 1, alles Übrige schon in Stufe 2
    expect([4, 8, 2, 6, 1, 3].map((k) => stufeVon(k, 4))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('teilt 300 Bilder bei 25/s so auf: 19 · 19 · 38 · 75 · 150', () => {
    const je = [0, 0, 0, 0, 0];
    for (let k = 0; k < 300; k += 1) je[stufeVon(k, 16)] += 1;
    expect(je).toEqual([19, 19, 37, 75, 150]);
  });
});

describe('naechstesFehlendes', () => {
  const film = Array.from({ length: 32 }, (_, k) => k);

  it('füllt grob zu fein: erst Stufe 0, dann 1, 2, 3, 4', () => {
    const da = new Set<number>();
    const reihenfolge: number[] = [];
    for (;;) {
      const wahl = naechstesFehlendes(film, (k) => da.has(k), 16, null);
      if (!wahl) break;
      reihenfolge.push(stufeVon(wahl.k, 16));
      da.add(wahl.k);
    }
    expect(reihenfolge).toHaveLength(32);
    expect(reihenfolge).toEqual([...reihenfolge].sort((a, b) => a - b));
    expect(da.size).toBe(32);
  });

  it('beginnt innerhalb einer Stufe beim Kopf, aufsteigend, und läuft danach von vorn weiter', () => {
    const da = new Set<number>([0, 16]);
    const gewaehlt: number[] = [];
    // Stufe 0 ist da. Stufe 1 (jedes 8.) ab Kopf 10: 24, dann von vorn 8;
    // Stufe 2 (jedes 4.) ab Kopf 10: 12.
    for (let n = 0; n < 3; n += 1) {
      const wahl = naechstesFehlendes(film, (k) => da.has(k), 16, 10);
      gewaehlt.push(wahl!.k);
      da.add(wahl!.k);
    }
    expect(gewaehlt).toEqual([24, 8, 12]);
  });

  it('nimmt auch ohne Kopf den Anfang und meldet null, wenn alles da ist', () => {
    expect(naechstesFehlendes(film, () => false, 16, null)).toEqual({ k: 0, stufe: 0 });
    expect(naechstesFehlendes(film, () => true, 16, 5)).toBeNull();
    expect(naechstesFehlendes([], () => false, 16, 0)).toBeNull();
  });

  it('lässt Stufen ab `verbotenAb` aus', () => {
    const da = new Set<number>(film.filter((k) => stufeVon(k, 16) <= 2));
    expect(naechstesFehlendes(film, (k) => da.has(k), 16, null, 3)).toBeNull();
    expect(naechstesFehlendes(film, (k) => da.has(k), 16, null, 4)?.stufe).toBe(3);
  });

  it('arbeitet auf einem Film, der nicht bei 0 anfängt und Lücken hat', () => {
    const geschnitten = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 200, 201];
    const wahl = naechstesFehlendes(geschnitten, () => false, 16, 150);
    // Stufe 0: 112 (7 · 16) und 208 (nicht im Film) – ab Kopf 150 kommt 200 nicht in Stufe 0.
    expect(wahl).toEqual({ k: 112, stufe: 0 });
  });
});

describe('naechstesBild', () => {
  const bilder = (ks: number[]) => ks.map((k) => ({ k }));

  it('nimmt das nächste Filmbild, dessen Rasterbild der Speicher hat', () => {
    const film = bilder([10, 11, 12, 13, 14, 15, 16]);
    const hat = (k: number) => k === 10 || k === 16;
    expect(naechstesBild(film, 3, hat, 8)).toEqual({ index: 0, abstand: 3 });
    expect(naechstesBild(film, 5, hat, 8)).toEqual({ index: 6, abstand: 1 });
  });

  it('nimmt bei gleichem Abstand das frühere', () => {
    const film = bilder([0, 1, 2, 3, 4]);
    expect(naechstesBild(film, 2, (k) => k === 0 || k === 4, 8)).toEqual({ index: 0, abstand: 2 });
  });

  it('meldet Abstand 0, wenn das Bild selbst da ist, und null jenseits der Toleranz', () => {
    const film = bilder([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(naechstesBild(film, 4, (k) => k === 4, 8)).toEqual({ index: 4, abstand: 0 });
    expect(naechstesBild(film, 11, (k) => k === 0, 8)).toBeNull();
    expect(naechstesBild(film, 11, (k) => k === 0, 11)).toEqual({ index: 0, abstand: 11 });
    expect(naechstesBild([], 0, () => true, 8)).toBeNull();
  });

  it('sucht im Raum der Filmbilder: dasselbe k in zwei Abschnitten liegt an zwei Stellen', () => {
    // Derselbe Ausschnitt zweimal: k 5, 6, 7, dann 5, 6, 7.
    const film = bilder([5, 6, 7, 5, 6, 7]);
    const hat = (k: number) => k === 5;
    expect(naechstesBild(film, 4, hat, 8)).toEqual({ index: 3, abstand: 1 });
    expect(naechstesBild(film, 1, hat, 8)).toEqual({ index: 0, abstand: 1 });
  });

  it('hält den Index im Film, auch wenn der Finger darüber hinaus liegt', () => {
    const film = bilder([0, 1, 2]);
    expect(naechstesBild(film, 99, (k) => k === 2, 8)).toEqual({ index: 2, abstand: 0 });
    expect(naechstesBild(film, -5, (k) => k === 0, 8)).toEqual({ index: 0, abstand: 0 });
  });
});

describe('zuVerdraengen', () => {
  const film = new Set(Array.from({ length: 32 }, (_, k) => k));

  it('nimmt zuerst, was nicht mehr im Film liegt', () => {
    expect(zuVerdraengen([0, 1, 2, 99], film, 16, 0)).toBe(99);
  });

  it('nimmt dann aus der feinsten Stufe, und darin das, was am weitesten vom Kopf liegt', () => {
    // 1, 3, 5 sind Stufe 4; 8 ist Stufe 1; 0 ist Stufe 0.
    expect(zuVerdraengen([0, 8, 1, 3, 5], film, 16, 4)).toBe(1);
    expect(zuVerdraengen([0, 8, 1, 3, 5], film, 16, 0)).toBe(5);
    expect(zuVerdraengen([0, 8, 1, 3, 5], film, 16, 20)).toBe(1);
  });

  it('lässt Stufe 0 bis zuletzt stehen', () => {
    expect(zuVerdraengen([0, 16], film, 16, 0)).toBe(16);
    expect(zuVerdraengen([8, 16], film, 16, 0)).toBe(8);
  });

  it('meldet null, wenn nichts da ist', () => {
    expect(zuVerdraengen([], film, 16, 0)).toBeNull();
  });
});

describe('stufeBis', () => {
  const film = Array.from({ length: 32 }, (_, k) => k);

  it('sagt, bis zu welcher Stufe alles da ist', () => {
    const da = new Set<number>();
    expect(stufeBis(film, (k) => da.has(k), 16)).toBe(-1);
    for (const k of film) if (stufeVon(k, 16) === 0) da.add(k);
    expect(stufeBis(film, (k) => da.has(k), 16)).toBe(0);
    for (const k of film) if (stufeVon(k, 16) === 2) da.add(k);
    // Stufe 1 fehlt noch.
    expect(stufeBis(film, (k) => da.has(k), 16)).toBe(0);
    for (const k of film) if (stufeVon(k, 16) === 1) da.add(k);
    expect(stufeBis(film, (k) => da.has(k), 16)).toBe(2);
    for (const k of film) da.add(k);
    expect(stufeBis(film, (k) => da.has(k), 16)).toBe(4);
  });

  it('sagt bei einem Film ohne Bilder -1 und nicht die höchste Stufe', () => {
    expect(stufeBis([], () => false, 16)).toBe(-1);
  });
});

/* ---------- Die Klasse ---------- */

interface Auftrag {
  readonly ms: number;
  readonly prio: string;
}

function ersatzLeser(
  groesse: (ms: number) => number = () => 1000,
  kodiertNull: (ms: number) => boolean = () => false,
) {
  const auftraege: Auftrag[] = [];
  let mitschnitt: Mitschnitt | null = null;
  let angehalten: Promise<void> | null = null;
  let loslassen: () => void = () => undefined;
  return {
    auftraege,
    get mitschnitt() {
      return mitschnitt;
    },
    mitschnittSetzen(neu: Mitschnitt | null) {
      mitschnitt = neu;
    },
    anhalten() {
      angehalten = new Promise((weiter) => {
        loslassen = () => {
          angehalten = null;
          weiter();
        };
      });
    },
    weiter() {
      loslassen();
    },
    async holen(ms: number, prio: string, optionen: LeseOptionen = {}): Promise<Lesung> {
      auftraege.push({ ms, prio });
      if (angehalten) await angehalten;
      if (optionen.abbruch?.aborted) throw new AbbruchError();
      const klein = kodiertNull(ms)
        ? Promise.resolve(null)
        : Promise.resolve(new Blob([new Uint8Array(groesse(ms))]));
      return { voll: null, grau: null, klein };
    },
    /** Welche Rasterbilder bisher verlangt wurden. */
    ks: () => auftraege.map((a) => Math.floor(a.ms / S)),
  };
}

/** Ersatzbilder mit Zähler für `close`. */
function ersatzBilder() {
  const zu: number[] = [];
  let naechste = 0;
  const entpacken = async (): Promise<WischBild> => {
    const nummer = (naechste += 1);
    return {
      width: 480,
      height: 270,
      close: () => zu.push(nummer),
    } as unknown as ImageBitmap;
  };
  return { entpacken, zu };
}

function speicherMit(
  leser: ReturnType<typeof ersatzLeser>,
  optionen: Partial<ConstructorParameters<typeof Wischspeicher>[0]> = {},
) {
  const bilder = ersatzBilder();
  const speicher = new Wischspeicher({
    leser,
    s: S,
    format: async () => WEBP,
    entpacken: bilder.entpacken,
    meldenMs: 0,
    weiterMs: 1,
    ...optionen,
  });
  return { speicher, bilder };
}

function filmVon(anzahl: number, ab = 0) {
  return Array.from({ length: anzahl }, (_, i) => ({ stelle: i, nummer: 0, k: ab + i }));
}

const warten = async (bedingung: () => boolean, ms = 3000) => {
  const ende = Date.now() + ms;
  while (!bedingung()) {
    if (Date.now() > ende) throw new Error('Bedingung nicht erfüllt');
    await new Promise((weiter) => setTimeout(weiter, 2));
  }
};

describe('Wischspeicher – Füllen', () => {
  it('liest jedes Bild des Films genau einmal, grob zu fein, an der Mitte des Rasterbildes', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(32));
    await warten(() => speicher.stand().fertig);
    const ks = leser.ks();
    expect(ks).toHaveLength(32);
    expect(new Set(ks).size).toBe(32);
    // Mitte: (k + ½) · s
    for (const auftrag of leser.auftraege) {
      expect(auftrag.ms - Math.floor(auftrag.ms / S) * S).toBeCloseTo(S / 2, 6);
    }
    const stufen = ks.map((k) => stufeVon(k, 16));
    expect(stufen).toEqual([...stufen].sort((a, b) => a - b));
    expect(speicher.stand().stufe).toBe(4);
    expect(speicher.stand().bilder).toBe(32);
    speicher.schliessen();
  });

  it("gibt den groben Stufen Vorfahrt ('mitte'), den feinen nicht ('hinten')", async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(32));
    await warten(() => speicher.stand().fertig);
    for (const auftrag of leser.auftraege) {
      const stufe = stufeVon(Math.floor(auftrag.ms / S), 16);
      expect(auftrag.prio).toBe(stufe <= 2 ? 'mitte' : 'hinten');
    }
    expect(leser.auftraege.some((a) => a.prio === 'mitte')).toBe(true);
    expect(leser.auftraege.some((a) => a.prio === 'hinten')).toBe(true);
    speicher.schliessen();
  });

  it('fängt bei dem Bild an, an dem der Anwender steht', async () => {
    const leser = ersatzLeser();
    leser.anhalten();
    const { speicher } = speicherMit(leser);
    speicher.kopf(20);
    speicher.setzen(filmVon(64));
    await warten(() => leser.auftraege.length === 1);
    // Stufe 0 ab Kopf 20: 32 (2 · 16).
    expect(leser.ks()).toEqual([32]);
    leser.weiter();
    speicher.schliessen();
  });

  it('nimmt neue Bilder hinten dazu, wenn der Film länger wird – und liest nichts doppelt', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(32));
    await warten(() => speicher.stand().fertig);
    expect(leser.auftraege).toHaveLength(32);
    speicher.setzen(filmVon(48));
    await warten(() => speicher.stand().bilder === 48);
    expect(leser.auftraege).toHaveLength(48);
    expect(new Set(leser.ks()).size).toBe(48);
    speicher.schliessen();
  });

  it('bleibt gültig, wenn der Film gekürzt oder umgestellt wird: dasselbe k, kein neues Lesen', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(32));
    await warten(() => speicher.stand().fertig);
    // Gekürzt auf 8 … 23 und mit den Filmbildern in anderer Reihenfolge.
    const umgestellt = [...filmVon(16, 8)].reverse();
    speicher.setzen(umgestellt);
    expect(speicher.stand().von).toBe(16);
    expect(speicher.stand().fertig).toBe(true);
    expect(speicher.hat(10)).toBe(true);
    // Die Bilder ausserhalb liegen weiter da, bis das Budget sie braucht.
    expect(speicher.hat(2)).toBe(true);
    expect(leser.auftraege).toHaveLength(32);
    speicher.schliessen();
  });

  it('ruht, solange ein Grund besteht, und fährt danach fort', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.ruhen('wiedergabe', true);
    speicher.ruhen('zug', true);
    speicher.setzen(filmVon(16));
    await new Promise((weiter) => setTimeout(weiter, 40));
    expect(leser.auftraege).toHaveLength(0);
    expect(speicher.stand().bilder).toBe(0);
    speicher.ruhen('wiedergabe', false);
    await new Promise((weiter) => setTimeout(weiter, 40));
    // Der Zug hält es weiter an.
    expect(leser.auftraege).toHaveLength(0);
    speicher.ruhen('zug', false);
    await warten(() => speicher.stand().fertig, 4000);
    expect(leser.auftraege).toHaveLength(16);
    speicher.schliessen();
  });

  it("hält an, wenn der Arbeitsspeicher knapp wird – 'speicher' – und gibt entpackte Bilder frei", async () => {
    const leser = ersatzLeser();
    const { speicher, bilder } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    await speicher.bild(0);
    await speicher.bild(8);
    speicher.speicherKnapp(true);
    expect(bilder.zu).toHaveLength(2);
    expect(speicher.entpacktBild(0)).toBeNull();
    // Die kodierten Bilder bleiben.
    expect(speicher.hat(0)).toBe(true);
    speicher.speicherKnapp(false);
    speicher.schliessen();
  });
});

describe('Wischspeicher – Grenze in Bytes', () => {
  it('hält das Budget ein und verdrängt die feinste Stufe zuerst', async () => {
    const leser = ersatzLeser(() => 1000);
    const { speicher } = speicherMit(leser, { budget: 10_500 });
    speicher.kopf(0);
    speicher.setzen(filmVon(64));
    // 64 Bilder zu 1000 Byte passen nicht in 10 500: Es läuft, bis die Stufen voll sind.
    await new Promise((weiter) => setTimeout(weiter, 120));
    const stand = speicher.stand();
    expect(stand.bytes).toBeLessThanOrEqual(10_500);
    expect(stand.bilder).toBe(10);
    // Die groben Stufen (4 + 4 + 8 = 16 Bilder bis Stufe 2) sind nicht vollständig, aber
    // alles, was da ist, ist grober als das, was fehlt: Stufe 0 und 1 vollständig.
    for (let k = 0; k < 64; k += 8) expect(speicher.hat(k)).toBe(true);
    speicher.schliessen();
  });

  it('liest nach dem Reissen des Budgets nicht endlos dieselben Bilder', async () => {
    const leser = ersatzLeser(() => 1000);
    const { speicher } = speicherMit(leser, { budget: 5_500 });
    speicher.setzen(filmVon(64));
    await new Promise((weiter) => setTimeout(weiter, 150));
    const gelesen = leser.auftraege.length;
    await new Promise((weiter) => setTimeout(weiter, 150));
    expect(leser.auftraege).toHaveLength(gelesen);
    // Höchstens ein Bild zu viel gelesen und wieder verdrängt.
    expect(gelesen).toBeLessThanOrEqual(5 + 2);
    expect(speicher.stand().bytes).toBeLessThanOrEqual(5_500);
    speicher.schliessen();
  });

  it('verdrängt zuerst Bilder, die nicht mehr im Film liegen', async () => {
    const leser = ersatzLeser(() => 1000);
    const { speicher } = speicherMit(leser, { budget: 40_500 });
    speicher.setzen(filmVon(40));
    await warten(() => speicher.stand().fertig);
    expect(speicher.stand().bytes).toBe(40_000);
    // Der Film wird nach hinten verlängert und das Budget reicht nicht mehr: erst die verwaisten.
    speicher.setzen(filmVon(40, 100));
    await warten(() => speicher.stand().fertig, 4000);
    expect(speicher.stand().bytes).toBeLessThanOrEqual(40_500);
    for (let k = 100; k < 140; k += 1) expect(speicher.hat(k)).toBe(true);
    speicher.schliessen();
  });

  it('verwirft ein einzelnes Bild über der Grenze und liest es nicht noch einmal', async () => {
    const gross = 5 * S + S / 2;
    const leser = ersatzLeser((ms) => (ms === gross ? BILD_MAX_BYTES + 1 : 1000));
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    expect(speicher.hat(5)).toBe(false);
    expect(speicher.hat(4)).toBe(true);
    expect(leser.ks().filter((k) => k === 5)).toHaveLength(1);
    expect(speicher.stand().bilder).toBe(15);
    speicher.schliessen();
  });
});

describe('Wischspeicher – Entpacken', () => {
  it('hält höchstens ENTPACKT_MAX Bilder und gibt die verdrängten frei', async () => {
    const leser = ersatzLeser();
    const { speicher, bilder } = speicherMit(leser);
    speicher.setzen(filmVon(32));
    await warten(() => speicher.stand().fertig);
    for (let k = 0; k < 20; k += 1) await speicher.bild(k);
    expect(bilder.zu).toHaveLength(20 - ENTPACKT_MAX);
    // Die zuletzt gebrauchten stehen noch da.
    for (let k = 20 - ENTPACKT_MAX; k < 20; k += 1) expect(speicher.entpacktBild(k)).not.toBeNull();
    expect(speicher.entpacktBild(0)).toBeNull();
    speicher.schliessen();
  });

  it('entpackt beim Vorladen im Hintergrund – danach liegt es synchron bereit', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    expect(speicher.entpacktBild(3)).toBeNull();
    speicher.vorladen(3);
    speicher.vorladen(3);
    await warten(() => speicher.entpacktBild(3) !== null);
    expect(speicher.entpacktBild(3)?.width).toBe(480);
    speicher.schliessen();
  });

  it('antwortet für ein Bild, das es nicht hat, mit null', async () => {
    const leser = ersatzLeser();
    leser.anhalten();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    expect(await speicher.bild(3)).toBeNull();
    leser.weiter();
    speicher.schliessen();
  });

  it('verwirft ein Bild, das sich nicht entpacken lässt, und liest es noch einmal – zweimal: lässt es aus', async () => {
    const leser = ersatzLeser();
    let versuche = 0;
    const { speicher } = speicherMit(leser, {
      entpacken: async () => {
        versuche += 1;
        throw new Error('verdorben');
      },
    });
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    expect(await speicher.bild(4)).toBeNull();
    // Das Bild wurde verworfen; es fehlt, bis es neu gelesen ist.
    await warten(() => speicher.hat(4));
    expect(await speicher.bild(4)).toBeNull();
    // Zweimal verdorben: ausgelassen, nicht noch einmal gelesen.
    await new Promise((weiter) => setTimeout(weiter, 30));
    expect(speicher.hat(4)).toBe(false);
    expect(leser.ks().filter((k) => k === 4)).toHaveLength(2);
    expect(versuche).toBe(2);
    expect(speicher.stand().fertig).toBe(true);
    speicher.schliessen();
  });

  it('gibt ein Bild frei, das ankommt, nachdem es ersetzt oder geschlossen wurde', async () => {
    const leser = ersatzLeser();
    let loslassen: () => void = () => undefined;
    const geschlossen: number[] = [];
    const { speicher } = speicherMit(leser, {
      entpacken: () =>
        new Promise<WischBild>((fertig) => {
          loslassen = () =>
            fertig({
              width: 480,
              height: 270,
              close: () => geschlossen.push(1),
            } as unknown as ImageBitmap);
        }),
    });
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    speicher.vorladen(2);
    speicher.schliessen();
    loslassen();
    await warten(() => geschlossen.length === 1);
    expect(speicher.entpacktBild(2)).toBeNull();
  });
});

describe('Wischspeicher – Schliessen', () => {
  it('räumt alles: Bilder, Bytes, entpackte Bilder, Mitschnitt, Aufträge', async () => {
    const leser = ersatzLeser();
    const { speicher, bilder } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    await speicher.bild(1);
    await speicher.bild(2);
    expect(leser.mitschnitt).not.toBeNull();
    speicher.schliessen();
    expect(speicher.stand().bilder).toBe(0);
    expect(speicher.stand().bytes).toBe(0);
    expect(speicher.stand().von).toBe(0);
    expect(bilder.zu).toHaveLength(2);
    expect(leser.mitschnitt).toBeNull();
    expect(speicher.hat(1)).toBe(false);
    expect(speicher.entpacktBild(1)).toBeNull();
    const gelesen = leser.auftraege.length;
    await new Promise((weiter) => setTimeout(weiter, 40));
    expect(leser.auftraege).toHaveLength(gelesen);
  });

  it('bricht einen laufenden Auftrag ab – und füllt nach einem späteren setzen von vorn (StrictMode)', async () => {
    const leser = ersatzLeser();
    leser.anhalten();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => leser.auftraege.length === 1);
    speicher.schliessen();
    leser.weiter();
    await new Promise((weiter) => setTimeout(weiter, 20));
    // Der abgebrochene Auftrag legt nichts mehr ab.
    expect(speicher.stand().bilder).toBe(0);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    expect(speicher.stand().bilder).toBe(16);
    speicher.schliessen();
  });

  it('hat vor dem ersten setzen keine Nebenwirkung', () => {
    const leser = ersatzLeser();
    const gesetzt = vi.spyOn(leser, 'mitschnittSetzen');
    const { speicher } = speicherMit(leser);
    expect(gesetzt).not.toHaveBeenCalled();
    expect(speicher.stand().bilder).toBe(0);
    speicher.schliessen();
  });
});

describe('Wischspeicher – wenn etwas fehlt', () => {
  it('ist nicht verfügbar, wenn kein Format kodiert wird – ohne einen Auftrag zu stellen', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser, { format: async () => null });
    speicher.setzen(filmVon(16));
    await warten(() => !speicher.stand().verfuegbar);
    expect(speicher.hat(0)).toBe(false);
    expect(leser.auftraege).toHaveLength(0);
    expect(leser.mitschnitt).toBeNull();
    speicher.schliessen();
  });

  it('lässt bei einem einzelnen Kodierfehler nur dieses Bild aus', async () => {
    const leser = ersatzLeser(
      () => 1000,
      (ms) => ms === 3 * S + S / 2,
    );
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    expect(speicher.stand().verfuegbar).toBe(true);
    expect(speicher.hat(3)).toBe(false);
    expect(speicher.stand().bilder).toBe(15);
    expect(leser.ks().filter((k) => k === 3)).toHaveLength(1);
    speicher.schliessen();
  });

  it(`beendet das Füllen nach ${FEHLER_FOLGE_MAX} Kodierfehlern in Folge`, async () => {
    const leser = ersatzLeser(
      () => 1000,
      () => true,
    );
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => !speicher.stand().verfuegbar);
    expect(leser.auftraege).toHaveLength(FEHLER_FOLGE_MAX);
    speicher.schliessen();
  });

  it('läuft nach einem Abbruch des Dienstes weiter, statt zu enden', async () => {
    let abgebrochen = 0;
    const leser = ersatzLeser();
    const echt = leser.holen.bind(leser);
    leser.holen = async (ms, prio, optionen) => {
      if (abgebrochen < 2) {
        abgebrochen += 1;
        leser.auftraege.push({ ms, prio });
        throw new AbbruchError();
      }
      return echt(ms, prio, optionen);
    };
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig, 4000);
    expect(speicher.stand().verfuegbar).toBe(true);
    expect(speicher.stand().bilder).toBe(16);
    speicher.schliessen();
  });
});

describe('Wischspeicher – Mitschnitt', () => {
  it('braucht nur, was im Film liegt und fehlt – und nicht, solange er ruht', async () => {
    const leser = ersatzLeser();
    leser.anhalten();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => leser.mitschnitt !== null);
    const m = leser.mitschnitt!;
    expect(m.braucht(3)).toBe(true);
    // Nicht im Film.
    expect(m.braucht(99)).toBe(false);
    speicher.ruhen('wiedergabe', true);
    expect(m.braucht(3)).toBe(false);
    speicher.ruhen('wiedergabe', false);
    leser.weiter();
    speicher.schliessen();
  });

  it('legt ein mitgeschnittenes Bild ab – danach braucht es nicht mehr', async () => {
    const leser = ersatzLeser();
    leser.anhalten();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => leser.mitschnitt !== null);
    const m = leser.mitschnitt!;
    m.ablegen(5, new Blob([new Uint8Array(500)]));
    expect(speicher.hat(5)).toBe(true);
    expect(m.braucht(5)).toBe(false);
    expect(speicher.stand().bytes).toBe(500);
    leser.weiter();
    speicher.schliessen();
  });
});

describe('Wischspeicher – Meldungen', () => {
  it('meldet höchstens alle WISCH_MELDEN_MS und am Ende den vollen Stand', async () => {
    vi.useFakeTimers();
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser, { meldenMs: WISCH_MELDEN_MS });
    let meldungen = 0;
    speicher.abonnieren(() => {
      meldungen += 1;
    });
    speicher.setzen(filmVon(32));
    await vi.advanceTimersByTimeAsync(10);
    // 32 Bilder in wenigen Millisekunden – aber nicht 32 Meldungen.
    expect(meldungen).toBeLessThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(2 * WISCH_MELDEN_MS);
    expect(speicher.stand().bilder).toBe(32);
    expect(speicher.stand().fertig).toBe(true);
    const bei = meldungen;
    await vi.advanceTimersByTimeAsync(2000);
    expect(meldungen).toBe(bei);
    speicher.schliessen();
  });

  it('gibt dasselbe Stand-Objekt zurück, solange sich nichts ändert', async () => {
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    const a = speicher.stand();
    expect(speicher.stand()).toBe(a);
    speicher.schliessen();
  });
});

describe('Wischspeicher – Prüfhaken', () => {
  function fensterAttrappe(vorher: Record<string, unknown> = {}) {
    const fenster = {
      __wisch: vorher,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('window', fenster);
    return fenster;
  }

  it('legt window.__wisch an und hält Stand, Format und Zähler darin fest', async () => {
    const fenster = fensterAttrappe();
    delete (fenster as { __wisch?: unknown }).__wisch;
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await warten(() => speicher.stand().fertig);
    const haken = (fenster as unknown as { __wisch: Record<string, unknown> }).__wisch;
    expect(haken.format).toBe('image/webp');
    expect(haken.bilder).toBe(16);
    expect(haken.fertig).toBe(true);
    expect(haken.stufe).toBe(4);
    expect(haken.bytes).toBe(16_000);
    expect((haken.zaehler as { kodiert: number }).kodiert).toBe(16);
    speicher.schliessen();
    expect(haken.bilder).toBe(0);
    expect(haken.bytes).toBe(0);
    expect(haken.entpackt).toBe(0);
  });

  it('schaltet mit `aus` Benutzung und Füllen ab', async () => {
    fensterAttrappe({ aus: true });
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    await new Promise((weiter) => setTimeout(weiter, 60));
    expect(leser.auftraege).toHaveLength(0);
    expect(speicher.hat(0)).toBe(false);
    speicher.schliessen();
  });

  it('nimmt ein vorab gesetztes Budget und lässt `ruhen` von aussen zu', async () => {
    const fenster = fensterAttrappe({ budget: 2_500 });
    const leser = ersatzLeser();
    const { speicher } = speicherMit(leser);
    speicher.setzen(filmVon(16));
    const haken = (fenster as unknown as { __wisch: { ruhen: (g: string, an: boolean) => void } })
      .__wisch;
    haken.ruhen('speicher', true);
    await new Promise((weiter) => setTimeout(weiter, 60));
    const gelesen = leser.auftraege.length;
    expect(gelesen).toBeLessThanOrEqual(1);
    haken.ruhen('speicher', false);
    await new Promise((weiter) => setTimeout(weiter, 80));
    expect(speicher.stand().bytes).toBeLessThanOrEqual(2_500);
    speicher.schliessen();
  });
});
