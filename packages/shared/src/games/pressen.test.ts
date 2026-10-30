/**
 * Pressen: Wertung, Rollen, Malus, Atempo (gemeinsame Fälle mit Rust) und die
 * Balance – gemessen an der echten Simulation, nicht an ausgedachten Zahlen.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { AUSGEWOGEN, HASTIG, VORSICHTIG, botLauf } from './pressen-bot.hilfe.js';
import {
  GLAS_ML,
  MAX_TICKS,
  simBis,
  simuliere,
  neuerZustand,
  type Eingabe,
} from './pressen-sim.js';
import {
  ATEMPO_TOLERANZ_MS,
  MALUS_MAX_MS,
  dranSitze,
  malusBei,
  planFuer,
  pressen,
  verzoegerungBei,
  wartetAuf,
  wertungMs,
  type PressenErgebnis,
  type PressenState,
  type PressenZug,
} from './pressen.js';

const hier = dirname(fileURLToPath(import.meta.url));
const daten = JSON.parse(readFileSync(resolve(hier, '../testdaten/pressen.json'), 'utf8')) as {
  wertung: { dauerMs: number; verschuettetDezi: number; erwartet: number }[];
  malus: { wertMs: number; stand: number; jetzt: number; erwartet: number }[];
  plan: { n: number; modus: string; ampel: number | null; teams: number[][] }[];
  ablaeufe: {
    name: string;
    spieler: number;
    zuege: (PressenZug & {
      sitz: number;
      jetzt: number;
      fehler?: boolean;
      danach?: {
        runde?: number;
        atempo?: number;
        fertig?: boolean;
        dran?: number[];
        sieger?: number[];
        teamWertung?: number[];
        malusWerte?: number[];
        abstandMs?: number;
        verzoegerung?: { sitz: number; wert: number };
      };
    })[];
  }[];
};

function sitze(n: number) {
  return Array.from({ length: n }, (_, seat) => ({ seat, userId: `u${seat}` }));
}

const sortiert = (liste: number[]) => liste.slice().sort((a, b) => a - b);

describe('gemeinsame Testfälle (Rust prüft dieselbe Datei)', () => {
  it.each(daten.wertung)('Wertung $dauerMs ms / $verschuettetDezi dml', (fall) => {
    expect(wertungMs(fall.dauerMs, fall.verschuettetDezi)).toBe(fall.erwartet);
  });

  it.each(daten.malus)('Malus $wertMs nach $jetzt', (fall) => {
    expect(verzoegerungBei({ wertMs: fall.wertMs, stand: fall.stand }, fall.jetzt)).toBe(
      fall.erwartet,
    );
  });

  it.each(daten.plan)('Rollen bei $n Personen', (fall) => {
    expect(planFuer(fall.n)).toEqual({ modus: fall.modus, ampel: fall.ampel, teams: fall.teams });
  });

  it.each(daten.ablaeufe)('Ablauf: $name', (ablauf) => {
    let state = pressen.createInitialState(sitze(ablauf.spieler));
    for (const [nr, zug] of ablauf.zuege.entries()) {
      const wo = `Zug ${nr + 1}`;
      const bewegung = pressen.parseMove({
        typ: 'ergebnis',
        runde: zug.runde,
        dauerMs: zug.dauerMs,
        verschuettetDezi: zug.verschuettetDezi,
        reaktionMs: zug.reaktionMs,
        vorzeitig: zug.vorzeitig,
        verzoegerungMs: zug.verzoegerungMs,
      });
      expect(bewegung, wo).not.toBeNull();
      const antwort = pressen.applyMove(state, bewegung!, {
        seat: zug.sitz,
        userId: `u${zug.sitz}`,
        players: sitze(ablauf.spieler),
        nowMs: zug.jetzt,
      });
      expect(antwort.ok, wo).toBe(!zug.fehler);
      if (!antwort.ok) continue;
      state = antwort.state;
      const d = zug.danach;
      if (!d) continue;
      if (d.runde != null) expect(state.runde, wo).toBe(d.runde);
      if (d.atempo != null) expect(state.atempo, wo).toBe(d.atempo);
      if (d.fertig != null) expect(state.fertig, wo).toBe(d.fertig);
      if (d.dran) expect(sortiert(dranSitze(state)), wo).toEqual(sortiert(d.dran));
      if (d.sieger) expect(sortiert(state.sieger), wo).toEqual(sortiert(d.sieger));
      if (d.teamWertung) expect(state.teamWertung, wo).toEqual(d.teamWertung);
      if (d.malusWerte)
        expect(
          state.malus.map((m) => m.wertMs),
          wo,
        ).toEqual(d.malusWerte);
      if (d.abstandMs != null) expect(state.letzterAbstandMs, wo).toBe(d.abstandMs);
      if (d.verzoegerung) {
        const e: PressenErgebnis | null =
          state.ergebnisse[d.verzoegerung.sitz] ?? state.vorrunde?.[d.verzoegerung.sitz] ?? null;
        expect(e?.verzoegerungMs, wo).toBe(d.verzoegerung.wert);
      }
    }
  });
});

describe('Rollen und Anzeige', () => {
  it('kennt, worauf jemand wartet', () => {
    const state = pressen.createInitialState(sitze(5));
    expect(wartetAuf(state, 4)).toBeNull();
    expect(wartetAuf(state, 0)).toBe('ampel');
    const ohneAmpel = pressen.createInitialState(sitze(4));
    expect(wartetAuf(ohneAmpel, 2)).toBe('teamkollege');
    expect(wartetAuf(ohneAmpel, 0)).toBeNull();
  });

  it('der Spiegel ist solo und endet nie von selbst', () => {
    const state = pressen.createInitialState(sitze(1));
    expect(state.modus).toBe('spiegel');
    expect(pressen.getOutcome(state).finished).toBe(false);
    expect(pressen.currentSeat(state)).toBe(0);
  });

  it('die Ampel zählt nicht zur Wertung, auch wenn sie völlig daneben ist', () => {
    const ampelZug: PressenZug = {
      typ: 'ergebnis',
      runde: 1,
      dauerMs: 60_000,
      verschuettetDezi: 2900,
      reaktionMs: 5000,
      vorzeitig: false,
      verzoegerungMs: 0,
    };
    const state = pressen.createInitialState(sitze(3));
    const r = pressen.applyMove(state, ampelZug, {
      seat: 2,
      userId: 'u2',
      players: sitze(3),
      nowMs: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.teamWertung).toBeNull();
  });
});

describe('Malus', () => {
  it('halbiert sich je Halbwertszeit und wächst nicht über die Grenze', () => {
    expect(malusBei({ wertMs: 100, stand: 0 }, 120_000)).toBeCloseTo(50, 9);
    let state: PressenState = pressen.createInitialState(sitze(2));
    // Lauter Atempo-Runden dicht hintereinander: der Malus steigt bis zur Grenze.
    for (let i = 0; i < 20; i += 1) {
      for (const seat of [0, 1]) {
        const zug: PressenZug = {
          typ: 'ergebnis',
          runde: state.runde,
          dauerMs: 10_000,
          verschuettetDezi: 0,
          reaktionMs: 300,
          vorzeitig: false,
          verzoegerungMs: MALUS_MAX_MS,
        };
        const r = pressen.applyMove(state, zug, {
          seat,
          userId: `u${seat}`,
          players: sitze(2),
          nowMs: 1000 + i,
        });
        expect(r.ok).toBe(true);
        if (r.ok) state = r.state;
      }
    }
    expect(state.malus[0]!.wertMs).toBe(MALUS_MAX_MS);
    expect(state.atempo).toBe(20);
  });

  it('verzögert Drücken und Loslassen, nicht aber das Abstellen', () => {
    // Eine Taste, kurz gehalten: mit 200 ms Malus kommt beides 200 ms später an.
    const ohne: Eingabe[] = [
      { t: 100, was: 'neigen', unten: true },
      { t: 700, was: 'neigen', unten: false },
    ];
    const frueh = simBis(neuerZustand(), ohne, 0, 10);
    const spaet = simBis(neuerZustand(), ohne, 200, 10);
    expect(frueh.neigen).toBe(true);
    expect(spaet.neigen).toBe(false);
    expect(simBis(neuerZustand(), ohne, 200, 20).neigen).toBe(true);
    expect(simBis(neuerZustand(), ohne, 0, 36).neigen).toBe(false);
    expect(simBis(neuerZustand(), ohne, 200, 36).neigen).toBe(true); // Loslassen kommt erst bei 900 ms
    expect(simBis(neuerZustand(), ohne, 200, 46).neigen).toBe(false);

    // Dasselbe Spiel, Glas leer: der Klick wirkt sofort.
    const lauf = botLauf(AUSGEWOGEN, 0);
    expect(lauf.ergebnis!.reaktionMs).toBeLessThanOrEqual(400);
  });

  it('macht denselben Spieler messbar schlechter', () => {
    // Ein Bot, der die Trägheit kennt und dagegenhält, verliert trotzdem Zeit …
    const w = (verz: number) => {
      const r = botLauf(AUSGEWOGEN, verz).ergebnis!;
      return wertungMs(r.dauerMs, r.verschuettetDezi);
    };
    expect(w(60)).toBeGreaterThan(w(0) + 1000);
    // … und dieselben Handgriffe mit voller Verzögerung kommen später ans Ziel.
    const { eingaben } = botLauf(AUSGEWOGEN, 0);
    const leer = simBis(neuerZustand(), eingaben, 0, MAX_TICKS).leerTick!;
    const frisch = simBis(neuerZustand(), eingaben, 0, leer - 20);
    const traege = simBis(neuerZustand(), eingaben, MALUS_MAX_MS, leer - 20);
    expect(traege.getrunken).toBeLessThan(frisch.getrunken);
  });
});

describe('Simulation', () => {
  it('ist deterministisch', () => {
    const { eingaben } = botLauf(AUSGEWOGEN);
    expect(simuliere(eingaben, 0)).toEqual(simuliere(eingaben, 0));
    expect(simuliere(eingaben, 80)).toEqual(simuliere(eingaben, 80));
  });

  it('läuft ohne Eingaben nie ins Unendliche und meldet kein Ergebnis', () => {
    expect(simuliere([], 0)).toBeNull();
    expect(simBis(neuerZustand(), [], 0, MAX_TICKS + 99).tick).toBe(MAX_TICKS);
  });

  it('schlucken ist begrenzt: nie mehr als der Mund schafft', () => {
    const r = botLauf(AUSGEWOGEN).ergebnis!;
    expect(GLAS_ML - r.verschuettetDezi / 10).toBeLessThanOrEqual((30 * r.dauerMs) / 1000 + 25);
  });

  it('der Rest gilt beim vorzeitigen Abstellen als verschüttet', () => {
    const eingaben: Eingabe[] = [{ t: 2000, was: 'vorzeitig' }];
    const r = simuliere(eingaben, 0)!;
    expect(r.vorzeitig).toBe(true);
    expect(r.reaktionMs).toBeNull();
    expect(r.verschuettetDezi).toBe(GLAS_ML * 10);
  });

  it('der Abstellen-Knopf zählt erst bei leerem Glas', () => {
    expect(simuliere([{ t: 1000, was: 'abstellen' }], 0)).toBeNull();
  });

  it('Bier daneben ist verschüttet', () => {
    // Am Startplatz kippen, weit weg vom Mund.
    const eingaben: Eingabe[] = [
      { t: 20, was: 'neigen', unten: true },
      { t: 6000, was: 'abstellen' },
    ];
    const z = simBis(neuerZustand(), eingaben, 0, 400);
    expect(z.leerTick).not.toBeNull();
    expect(z.getrunken).toBe(0);
    expect(z.verschuettet).toBeGreaterThan(GLAS_ML - 1);
  });
});

describe('Balance: weder „schnell und schlampig“ noch „langsam und genau“ gewinnt', () => {
  const wert = (profil: Parameters<typeof botLauf>[0]) => {
    const r = botLauf(profil).ergebnis!;
    return { ...r, wertung: wertungMs(r.dauerMs, r.verschuettetDezi) };
  };

  it('hastig und vorsichtig verlieren klar gegen ausgewogen', () => {
    const hastig = wert(HASTIG);
    const vorsichtig = wert(VORSICHTIG);
    const ausgewogen = wert(AUSGEWOGEN);
    // Die Profile sind das, was sie heißen.
    expect(hastig.dauerMs).toBeLessThan(ausgewogen.dauerMs);
    expect(hastig.verschuettetDezi).toBeGreaterThan(1000);
    expect(vorsichtig.verschuettetDezi).toBe(0);
    expect(vorsichtig.dauerMs).toBeGreaterThan(ausgewogen.dauerMs);
    // Und die Wertung belohnt keines der Extreme.
    expect(hastig.wertung).toBeGreaterThan(ausgewogen.wertung * 2);
    expect(vorsichtig.wertung).toBeGreaterThan(ausgewogen.wertung * 2);
  });

  it('über alle Gießstärken liegt das Optimum innen – und beide Ränder sind weit davon weg', () => {
    const stufen = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30, 40, 60, 100];
    const werte = stufen.map((u) => wert({ ...AUSGEWOGEN, zielUeber: u }).wertung);
    const bester = Math.min(...werte);
    const i = werte.indexOf(bester);
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(stufen.length - 1);
    expect(werte[0]!).toBeGreaterThan(bester * 2);
    expect(werte[stufen.length - 1]!).toBeGreaterThan(bester * 2);
    // Auch die Nachbarschaft ist ein Tal, keine Rampe: ein Drittel mehr Eile
    // oder ein Drittel mehr Vorsicht kostet jeweils spürbar.
    expect(werte[stufen.indexOf(6)]!).toBeGreaterThan(bester * 1.3);
    expect(werte[stufen.indexOf(25)]!).toBeGreaterThan(bester * 1.3);
  });

  it('die Strafe wächst überlinear, aber ein Tropfen ist nicht gratis', () => {
    const strafe = (dezi: number) => wertungMs(0, dezi);
    expect(strafe(10)).toBeGreaterThan(0);
    expect(strafe(2000)).toBeGreaterThan(2 * strafe(1000));
    // 1 ml kostet etwa eine zehntel Sekunde.
    expect(strafe(10)).toBeGreaterThanOrEqual(100);
    expect(strafe(10)).toBeLessThan(ATEMPO_TOLERANZ_MS);
  });

  it('der Abstand zwischen Spielerprofilen ist größer als die Atempo-Toleranz', () => {
    expect(
      Math.abs(wert(AUSGEWOGEN).wertung - wert({ ...AUSGEWOGEN, zielUeber: 8 }).wertung),
    ).toBeGreaterThan(ATEMPO_TOLERANZ_MS);
  });
});

describe('Verzögerung im Spiel', () => {
  it('rundet auf ganze Millisekunden', () => {
    expect(Number.isInteger(verzoegerungBei({ wertMs: 40, stand: 0 }, 33_333))).toBe(true);
  });
});
