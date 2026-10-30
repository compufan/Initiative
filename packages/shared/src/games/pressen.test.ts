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
  DRIFT_BESCHLEUNIGUNG,
  GLAS_ML,
  GLAS_START_X,
  GLAS_START_Y,
  MAX_TICKS,
  MUND_HALB_X,
  MUND_HALB_Y,
  MUND_X,
  MUND_Y,
  driftBei,
  driftSeedFuer,
  haltekurve,
  imMund,
  physikFuer,
  simBis,
  simuliere,
  neuerZustand,
  strahlLandung,
  type Eingabe,
} from './pressen-sim.js';
import {
  ATEMPO_TOLERANZ_MS,
  MALUS_MAX_MS,
  START_FRIST_MS,
  START_ZAEHLER_MS,
  dranSitze,
  malusBei,
  planFuer,
  pressen,
  startPhase,
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
  startFaelle: {
    name: string;
    spieler: number;
    schritte: ({
      typ: 'start' | 'ergebnis';
      sitz: number;
      jetzt: number;
      art?: 'echtzeit' | 'asynchron';
      fehler?: boolean;
      danach?: {
        beginn?: number | null;
        art?: (string | null)[];
        bereitAm?: (number | null)[];
        gruppe?: number[];
        dran?: number[];
        versatz?: { sitz: number; wert: number };
      };
    } & Partial<PressenZug>)[];
  }[];
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
        versatzMs: zug.versatzMs ?? null,
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

describe('Start: Echtzeit oder asynchron (Rust prüft dieselben Fälle)', () => {
  it.each(daten.startFaelle)('$name', (fall) => {
    let state = pressen.createInitialState(sitze(fall.spieler));
    for (const [nr, schritt] of fall.schritte.entries()) {
      const wo = `Schritt ${nr + 1}`;
      const roh =
        schritt.typ === 'start'
          ? { typ: 'start', art: schritt.art }
          : {
              typ: 'ergebnis',
              runde: schritt.runde ?? 1,
              dauerMs: schritt.dauerMs,
              verschuettetDezi: schritt.verschuettetDezi,
              reaktionMs: schritt.reaktionMs ?? null,
              vorzeitig: schritt.vorzeitig ?? false,
              verzoegerungMs: schritt.verzoegerungMs ?? 0,
              versatzMs: schritt.versatzMs ?? null,
            };
      const bewegung = pressen.parseMove(roh);
      expect(bewegung, wo).not.toBeNull();
      const antwort = pressen.applyMove(state, bewegung!, {
        seat: schritt.sitz,
        userId: `u${schritt.sitz}`,
        players: sitze(fall.spieler),
        nowMs: schritt.jetzt,
      });
      expect(antwort.ok, `${wo}: ${antwort.ok ? '' : antwort.error}`).toBe(!schritt.fehler);
      if (!antwort.ok) continue;
      state = antwort.state;
      const d = schritt.danach;
      if (!d) continue;
      if ('beginn' in d) expect(state.start.beginn, wo).toBe(d.beginn);
      if (d.art) expect(state.start.art, wo).toEqual(d.art);
      if (d.bereitAm) expect(state.start.bereitAm, wo).toEqual(d.bereitAm);
      if (d.gruppe) expect(state.start.gruppe, wo).toEqual(d.gruppe);
      if (d.dran) expect(sortiert(dranSitze(state)), wo).toEqual(sortiert(d.dran));
      if (d.versatz) expect(state.ergebnisse[d.versatz.sitz]?.versatzMs, wo).toBe(d.versatz.wert);
    }
  });

  it('die Phase eines Sitzes folgt aus Wahl, Frist und Beginn', () => {
    const jetzt = 5_000_000;
    let state = pressen.createInitialState(sitze(2));
    const zug = (sitz: number, art: 'echtzeit' | 'asynchron', nowMs: number) => {
      const r = pressen.applyMove(
        state,
        { typ: 'start', art },
        {
          seat: sitz,
          userId: `u${sitz}`,
          players: sitze(2),
          nowMs,
        },
      );
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    };
    expect(startPhase(state, 0, jetzt)).toEqual({ phase: 'wahl' });
    zug(0, 'echtzeit', jetzt);
    expect(startPhase(state, 0, jetzt + 2000)).toEqual({
      phase: 'wartet',
      frist: jetzt + START_FRIST_MS,
      bereit: 1,
      von: 2,
    });
    // Der andere hat noch nicht gewählt und sieht die Wahl.
    expect(startPhase(state, 1, jetzt + 2000)).toEqual({ phase: 'wahl' });
    // Nach der Frist ohne den zweiten: Rückfall in asynchron.
    expect(startPhase(state, 0, jetzt + START_FRIST_MS + 1)).toEqual({
      phase: 'asynchron',
      grund: 'frist',
    });
    zug(1, 'echtzeit', jetzt + 3000);
    const beginn = jetzt + 3000 + START_ZAEHLER_MS;
    expect(startPhase(state, 0, jetzt + 3500)).toEqual({ phase: 'zaehlt', beginn });
    expect(startPhase(state, 1, beginn - 1)).toEqual({ phase: 'zaehlt', beginn });
    expect(startPhase(state, 1, beginn)).toEqual({ phase: 'gestartet', beginn });
  });

  it('wer asynchron wählt, macht es für alle asynchron – und sieht „frei“, wenn er allein ist', () => {
    let state = pressen.createInitialState(sitze(2));
    const r = pressen.applyMove(
      state,
      { typ: 'start', art: 'asynchron' },
      {
        seat: 1,
        userId: 'u1',
        players: sitze(2),
        nowMs: 10,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) state = r.state;
    expect(startPhase(state, 0, 20)).toEqual({ phase: 'asynchron', grund: 'gewaehlt' });
    expect(startPhase(pressen.createInitialState(sitze(1)), 0, 0)).toEqual({ phase: 'frei' });
    // Ampel zuerst: sie läuft allein.
    expect(startPhase(pressen.createInitialState(sitze(3)), 2, 0)).toEqual({ phase: 'frei' });
    // Ältere Stände ohne Start-Feld verlangen nichts.
    const alt = { ...pressen.createInitialState(sitze(2)) } as Partial<PressenState>;
    delete alt.start;
    expect(startPhase(alt as PressenState, 0, 0)).toEqual({ phase: 'frei' });
  });
});

describe('Gegen den Spiegel (Anforderung 7)', () => {
  it('kommt IMMER Atempo heraus, die nächste Runde steht sofort bereit, der Malus wächst nie', () => {
    let state = pressen.createInitialState(sitze(1));
    const lauefe = [
      { dauerMs: 10_000, verschuettetDezi: 0 },
      { dauerMs: 80_000, verschuettetDezi: 2900 }, // völlig daneben
      { dauerMs: 14_000, verschuettetDezi: 130 },
      { dauerMs: 11_000, verschuettetDezi: 0 },
    ];
    for (const [nr, lauf] of lauefe.entries()) {
      const zug: PressenZug = {
        typ: 'ergebnis',
        runde: state.runde,
        dauerMs: lauf.dauerMs,
        verschuettetDezi: lauf.verschuettetDezi,
        reaktionMs: 300,
        vorzeitig: false,
        verzoegerungMs: 200,
        versatzMs: null,
      };
      const r = pressen.applyMove(state, zug, {
        seat: 0,
        userId: 'u0',
        players: sitze(1),
        nowMs: 1000 + nr,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      state = r.state;
      expect(state.fertig).toBe(false);
      expect(state.atempo).toBe(nr + 1);
      expect(state.runde).toBe(nr + 2);
      expect(dranSitze(state)).toEqual([0]);
      expect(state.ergebnisse[0]).toBeNull();
      expect(state.malus[0]!.wertMs).toBe(0);
      expect(state.start.gruppe).toEqual([]);
      expect(startPhase(state, 0, 0)).toEqual({ phase: 'frei' });
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
      versatzMs: null,
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
          versatzMs: null,
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
  const wert = (profil: Parameters<typeof botLauf>[0], verz = 0, seed = 1) => {
    const r = botLauf(profil, verz, seed).ergebnis!;
    return { ...r, wertung: wertungMs(r.dauerMs, r.verschuettetDezi) };
  };
  const mittel = (profil: Parameters<typeof botLauf>[0], verz = 0) => {
    const l = [1, 2, 3, 4].map((seed) => wert(profil, verz, seed));
    const m = (f: (x: (typeof l)[number]) => number) => l.reduce((a, x) => a + f(x), 0) / l.length;
    return {
      wertung: m((x) => x.wertung),
      dauerMs: m((x) => x.dauerMs),
      dezi: m((x) => x.verschuettetDezi),
    };
  };

  it('hastig und vorsichtig verlieren klar gegen ausgewogen', () => {
    const hastig = wert(HASTIG);
    const vorsichtig = wert(VORSICHTIG);
    const ausgewogen = wert(AUSGEWOGEN);
    // Die Profile sind das, was sie heißen.
    expect(hastig.dauerMs).toBeLessThan(ausgewogen.dauerMs);
    expect(hastig.verschuettetDezi).toBeGreaterThan(1000);
    expect(vorsichtig.verschuettetDezi).toBeLessThanOrEqual(20);
    expect(vorsichtig.dauerMs).toBeGreaterThan(ausgewogen.dauerMs);
    // Und die Wertung belohnt keines der Extreme.
    expect(hastig.wertung).toBeGreaterThan(ausgewogen.wertung * 2);
    expect(vorsichtig.wertung).toBeGreaterThan(ausgewogen.wertung * 2);
  });

  it('über alle Gießstärken liegt das Optimum innen – und beide Ränder sind weit davon weg', () => {
    const stufen = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 40, 60, 100];
    const werte = stufen.map((u) => wert({ ...AUSGEWOGEN, zielUeber: u }).wertung);
    const bester = Math.min(...werte);
    const i = werte.indexOf(bester);
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(stufen.length - 1);
    expect(werte[0]!).toBeGreaterThan(bester * 2);
    expect(werte[stufen.length - 1]!).toBeGreaterThan(bester * 2);
    // Auch die Nachbarschaft ist ein Tal, keine Rampe: spürbar mehr Vorsicht
    // oder spürbar mehr Eile kostet jeweils.
    expect(werte[stufen.indexOf(16)]!).toBeGreaterThan(bester * 1.3);
    expect(werte[stufen.indexOf(30)]!).toBeGreaterThan(bester * 1.3);
  });

  it('ein ausgewogener Spieler trifft den Mund zuverlässig – mit Mühe, aber ohne Pfützen', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = wert(AUSGEWOGEN, 0, seed);
      // Weniger als 5 ml daneben und in einer vernünftigen Zeit (Mundgrenze: 10 s).
      expect(r.verschuettetDezi, `Seed ${seed}`).toBeLessThanOrEqual(50);
      expect(r.dauerMs, `Seed ${seed}`).toBeGreaterThan(10_000);
      expect(r.dauerMs, `Seed ${seed}`).toBeLessThan(25_000);
    }
    // Auch mit etwas trägerer Wahrnehmung (200 ms) geht es, nur mit mehr Mühe.
    const langsamer = wert({ ...AUSGEWOGEN, reaktionTicks: 10 });
    expect(langsamer.verschuettetDezi).toBeLessThan(300);
    expect(langsamer.dauerMs).toBeLessThan(40_000);
  });

  it('die zweite Achse zählt: wer nur links/rechts steuert, trifft nicht', () => {
    const nurX = wert({ ...AUSGEWOGEN, ohneTiefe: true });
    expect(nurX.verschuettetDezi).toBeGreaterThan(2500);
  });

  it('späte Runden sind spürbar schwerer – aber machbar', () => {
    const werte = [0, 60, 120, 180, 250].map((verz) => mittel(AUSGEWOGEN, verz));
    // Monoton schwerer …
    for (let i = 1; i < werte.length; i += 1) {
      expect(werte[i]!.wertung, `Stufe ${i}`).toBeGreaterThan(werte[i - 1]!.wertung);
    }
    // … deutlich, aber nicht unmöglich: höchstens das Dreieinhalbfache, wenig verschüttet.
    const frisch = werte[0]!;
    const muede = werte[4]!;
    expect(muede.wertung).toBeGreaterThan(frisch.wertung * 1.6);
    expect(muede.wertung).toBeLessThan(frisch.wertung * 3.5);
    expect(muede.dezi).toBeLessThan(400);
    expect(muede.dauerMs).toBeLessThan(60_000);
    // Und auch dann bleiben hastig und vorsichtig schlechter.
    expect(mittel(HASTIG, 250).wertung).toBeGreaterThan(muede.wertung * 1.5);
    expect(mittel(VORSICHTIG, 250).wertung).toBeGreaterThan(muede.wertung * 1.5);
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
      Math.abs(wert(AUSGEWOGEN).wertung - wert({ ...AUSGEWOGEN, zielUeber: 14 }).wertung),
    ).toBeGreaterThan(ATEMPO_TOLERANZ_MS);
  });
});

describe('Die neue Physik fühlt sich so an, wie sie beschrieben ist', () => {
  /** Eine Taste von `t0` bis `t1` gehalten, danach `ticks` Schritte gerechnet. */
  const lauf = (
    taste: 'links' | 'rechts' | 'hoch' | 'runter',
    haltenMs: number,
    verz: number,
    ticks: number,
  ) =>
    simBis(
      neuerZustand(),
      [
        { t: 1, was: taste, unten: true },
        { t: 1 + haltenMs, was: taste, unten: false },
      ],
      verz,
      ticks,
      // Ohne Abdrift messen: Seed, dessen erster Abschnitt kaum schiebt, gibt es
      // nicht – deshalb eigene Rechnung über die Differenz zum Leerlauf unten.
      0,
    );
  const leerlauf = (verz: number, ticks: number) => simBis(neuerZustand(), [], verz, ticks, 0);

  it('die Zweite Achse bewegt das Glas vor und zurück', () => {
    const vorn = lauf('runter', 600, 0, 100);
    const hinten = lauf('hoch', 600, 0, 100);
    const still = leerlauf(0, 100);
    expect(vorn.y).toBeGreaterThan(still.y + 5);
    expect(hinten.y).toBeLessThan(still.y - 5);
    // x bleibt davon (bis auf die Abdrift) unberührt.
    expect(Math.abs(vorn.x - still.x)).toBeLessThan(1e-9);
  });

  it('Loslassen bremst nicht ab, sondern dämpft nur allmählich', () => {
    const z = lauf('rechts', 800, 0, 40 + 1);
    const nachher = lauf('rechts', 800, 0, 40 + 10);
    const spaeter = lauf('rechts', 800, 0, 40 + 30);
    // Beim Loslassen (≈ Tick 40) ist es schnell, ein halbes Tick-Fenster später immer noch.
    expect(z.vx).toBeGreaterThan(80);
    expect(nachher.vx).toBeGreaterThan(0.5 * z.vx);
    expect(spaeter.vx).toBeGreaterThan(5);
    expect(spaeter.vx).toBeLessThan(nachher.vx);
    // Das Glas schiebt dabei noch ein ganzes Stück weiter.
    expect(spaeter.x - nachher.x).toBeGreaterThan(20);
  });

  it('mit steigendem Malus gleitet das Glas weiter (schwächere Dämpfung)', () => {
    const weg = (verz: number) => {
      // Vom Loslassen (Tick 40, ohne Verzögerung gerechnet) bis 3 s später.
      const a = lauf('rechts', 800, verz, 40 + Math.ceil(verz / 20) + 1);
      const b = lauf('rechts', 800, verz, 40 + Math.ceil(verz / 20) + 150);
      return b.x - a.x;
    };
    expect(physikFuer(MALUS_MAX_MS).daempfung).toBeLessThan(physikFuer(0).daempfung);
    expect(weg(MALUS_MAX_MS)).toBeGreaterThan(weg(0) * 1.2);
  });

  it('die Bewegung ist nicht linear: lange gedrückt ist deutlich mehr als doppelt so weit', () => {
    // Weg während des Haltens, Abdrift herausgerechnet (Vergleich mit dem Leerlauf).
    const strecke = (haltenMs: number) => {
      const t = 1 + haltenMs;
      const z = simBis(
        neuerZustand(),
        [{ t: 1, was: 'rechts', unten: true }],
        0,
        Math.floor(t / 20),
        0,
      );
      return z.x - leerlauf(0, Math.floor(t / 20)).x;
    };
    expect(strecke(300)).toBeGreaterThan(0);
    expect(strecke(1200)).toBeGreaterThan(5 * strecke(600));
    expect(strecke(600)).toBeGreaterThan(2.5 * strecke(300));
    // Kurz drücken ist „sehr langsam“: unter 40 Einheiten je Sekunde im Schnitt.
    expect(strecke(300) / 0.3).toBeLessThan(60);
  });

  it('die Kurve wird mit dem Malus steiler: gleiche Haltezeit, weniger Tempo', () => {
    for (const halte of [0.3, 0.6, 0.9]) {
      expect(haltekurve(halte, 1.25, 1)).toBeLessThan(haltekurve(halte, 1.25, 0));
    }
    expect(haltekurve(1.25, 1.25, 1)).toBeCloseTo(1, 12);
    expect(haltekurve(1.25, 1.25, 0)).toBeCloseTo(1, 12);
    expect(haltekurve(0, 1.25, 0.5)).toBe(0);
    // In der Simulation: nach gleicher Haltezeit ist das Glas bei Malus langsamer
    // (beide mit Verzögerung 0 für die Taste, nur die Kurve unterscheidet sich).
    const tempo = (verz: number) =>
      simBis(
        neuerZustand(),
        [{ t: 1, was: 'rechts', unten: true }],
        verz,
        2 + Math.ceil(verz / 20) + 40,
        0,
      ).vx;
    expect(tempo(0)).toBeGreaterThan(0);
    expect(tempo(MALUS_MAX_MS)).toBeLessThan(tempo(0));
  });

  it('das Glas driftet immer leicht ab – bei allen gleich, je Runde anders', () => {
    const treibt = (seed: number) => {
      const z = simBis(neuerZustand(), [], 0, 250, seed);
      return { dx: z.x - GLAS_START_X, dy: z.y - GLAS_START_Y };
    };
    const a = treibt(driftSeedFuer(1));
    expect(Math.hypot(a.dx, a.dy)).toBeGreaterThan(15);
    // „leicht“: in fünf Sekunden nicht aus dem Bild.
    expect(Math.hypot(a.dx, a.dy)).toBeLessThan(150);
    // Gleiche Runde, gleiches Ergebnis – auf jedem Gerät.
    expect(treibt(driftSeedFuer(1))).toEqual(a);
    // Andere Runden schieben anders.
    const richtungen = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((r) => JSON.stringify(treibt(driftSeedFuer(r)))),
    );
    expect(richtungen.size).toBeGreaterThan(4);
    // Die Beschleunigung bleibt bei der Konstante (Betrag höchstens 1×).
    for (let tick = 0; tick < 600; tick += 7) {
      const d = driftBei(tick, 3, DRIFT_BESCHLEUNIGUNG);
      expect(Math.hypot(d.ax, d.ay)).toBeLessThanOrEqual(DRIFT_BESCHLEUNIGUNG + 1e-9);
    }
  });

  it('der Strahl fliegt mit der Neigung weiter nach vorn, nur das Oval ist Mund', () => {
    const nah = strahlLandung(500, 400, 0, 0, 3);
    const fern = strahlLandung(500, 400, 0, 0, 20);
    expect(fern.y).toBeLessThan(nah.y);
    expect(fern.x).toBe(nah.x);
    // Die eigene Bewegung fliegt mit.
    expect(strahlLandung(500, 400, 100, 0, 3).x).toBeGreaterThan(500);
    expect(imMund(MUND_X, MUND_Y)).toBe(true);
    expect(imMund(MUND_X + MUND_HALB_X - 1, MUND_Y)).toBe(true);
    expect(imMund(MUND_X + MUND_HALB_X + 1, MUND_Y)).toBe(false);
    expect(imMund(MUND_X, MUND_Y + MUND_HALB_Y + 1)).toBe(false);
    // In der Ecke des Rechtecks liegt der Strahl schon daneben: es ist ein Oval.
    expect(imMund(MUND_X + MUND_HALB_X * 0.9, MUND_Y + MUND_HALB_Y * 0.9)).toBe(false);
  });

  it('Neigen ist träger als ein Schalter: nach dem Loslassen dreht das Glas noch ein Stück weiter', () => {
    const z = simBis(
      neuerZustand(),
      [
        { t: 1, was: 'neigen', unten: true },
        { t: 1500, was: 'neigen', unten: false },
      ],
      0,
      76,
      0,
    );
    const davor = simBis(neuerZustand(), [{ t: 1, was: 'neigen', unten: true }], 0, 74, 0);
    expect(z.neigung).toBeGreaterThanOrEqual(davor.neigung);
  });
});

describe('Verzögerung im Spiel', () => {
  it('rundet auf ganze Millisekunden', () => {
    expect(Number.isInteger(verzoegerungBei({ wertMs: 40, stand: 0 }, 33_333))).toBe(true);
  });
});
