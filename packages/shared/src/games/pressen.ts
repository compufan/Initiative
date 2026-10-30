/**
 * Pressen – Regeln, Wertung, Rollen und Malus.
 *
 * Die Physik eines Laufs steht in `pressen-sim.ts` und läuft nur im Client.
 * Hier steht, was der Server prüft und entscheidet (gespiegelt in
 * `apps/api/src/games/pressen.rs`, beide gegen `testdaten/pressen.json`):
 * wer wann dran ist, wie ein gemeldeter Lauf gewertet wird, wann es Atempo
 * gibt, wer gewinnt und wie stark die Tasten verzögert sind.
 */
import type { GameDefinition, GameMoveResult, GameOutcome, GameSeat } from './types.js';
import { DT_MS, GLAS_ML, MAX_TICKS, MUND_KAPAZITAET_ML, SCHLUCK_RATE_ML_S } from './pressen-sim.js';

/* ---------- Konstanten ---------- */

/** Wertung = Dauer + Strafe; die Strafe wächst überlinear (siehe Entwurf). */
export const STRAFE_LINEAR_MS_PRO_ML = 100;
export const STRAFE_QUADRAT_MS_PRO_ML2 = 2;

/** Unterschied unter dieser Schwelle heißt „Atempo“ (je Läufer eines Teams). */
export const ATEMPO_TOLERANZ_MS = 250;

/** Jeder gespielte Lauf macht die Tasten um so viel träger … */
export const MALUS_PRO_RUNDE_MS = 40;
export const MALUS_MAX_MS = 250;
/** … und nach dieser Zeit ist davon nur noch die Hälfte übrig. */
export const MALUS_HALBWERTSZEIT_MS = 120_000;

/** Glas leer und höchstens so schnell abgestellt: Auszeichnung „getrümmert“. */
export const GETRUEMMERT_MS = 450;

/** Plausibilitätsgrenzen für gemeldete Läufe. */
export const MIN_REAKTION_MS = 120;
export const MIN_DAUER_MS = 1500;
export const MAX_DAUER_MS = MAX_TICKS * DT_MS;
/** So lange darf zwischen „Los“ und der Meldung höchstens Spielraum liegen. */
const START_SPIELRAUM_MS = 30_000;

export const PRESSEN_MIN_SPIELER = 1;
export const PRESSEN_MAX_SPIELER = 8;

/* ---------- Typen ---------- */

export type PressenModus = 'spiegel' | 'duell' | 'ampel' | 'staffette';

export interface PressenMalus {
  /** Verzögerung in ms zum Zeitpunkt `stand` (Serveruhr, ms seit 1970). */
  wertMs: number;
  stand: number;
}

export interface PressenErgebnis {
  dauerMs: number;
  verschuettetDezi: number;
  reaktionMs: number | null;
  vorzeitig: boolean;
  verzoegerungMs: number;
  wertungMs: number;
  getruemmert: boolean;
}

export interface PressenState {
  modus: PressenModus;
  /** Sitz, der die Ampel macht (läuft zuerst, wird nicht gewertet). */
  ampel: number | null;
  /** Läufer je Team in Staffel-Reihenfolge; im Spiegelmodus nur `[[0]]`. */
  teams: number[][];
  runde: number;
  /** Wie oft es bisher Atempo gab. */
  atempo: number;
  /** Ergebnisse der laufenden Runde, je Sitz. */
  ergebnisse: (PressenErgebnis | null)[];
  /** Ergebnisse der letzten Atempo-Runde (zur Anzeige). */
  vorrunde: (PressenErgebnis | null)[] | null;
  letzterAbstandMs: number | null;
  malus: PressenMalus[];
  /** Teamwertungen der entscheidenden Runde. */
  teamWertung: number[] | null;
  sieger: number[];
  fertig: boolean;
}

export interface PressenZug {
  typ: 'ergebnis';
  runde: number;
  dauerMs: number;
  verschuettetDezi: number;
  reaktionMs: number | null;
  vorzeitig: boolean;
  verzoegerungMs: number;
}

/* ---------- reine Funktionen ---------- */

/** Wertung in ms (kleiner ist besser), ganzzahlig und ohne Gleitkomma. */
export function wertungMs(dauerMs: number, verschuettetDezi: number): number {
  const d = verschuettetDezi;
  // Strafe = LIN·ml + QUAD·ml² mit ml = d/10, auf ganze ms gerundet.
  const strafe = Math.floor(
    (10 * STRAFE_LINEAR_MS_PRO_ML * d + STRAFE_QUADRAT_MS_PRO_ML2 * d * d + 50) / 100,
  );
  return dauerMs + strafe;
}

/** Wer spielt welche Rolle bei `n` Personen. */
export function planFuer(n: number): {
  modus: PressenModus;
  ampel: number | null;
  teams: number[][];
} {
  if (n <= 1) return { modus: 'spiegel', ampel: null, teams: [[0]] };
  const ampel = n >= 3 && n % 2 === 1 ? n - 1 : null;
  const laeufer = ampel == null ? n : n - 1;
  const teams: number[][] = [[], []];
  for (let sitz = 0; sitz < laeufer; sitz += 1) teams[sitz % 2]!.push(sitz);
  const modus: PressenModus = n === 2 ? 'duell' : n === 3 ? 'ampel' : 'staffette';
  return { modus, ampel, teams };
}

/** Verzögerung (ms, mit Nachkommastellen) zum Zeitpunkt `jetztMs`. */
export function malusBei(malus: PressenMalus, jetztMs: number): number {
  const alter = Math.max(0, jetztMs - malus.stand);
  return malus.wertMs * Math.pow(0.5, alter / MALUS_HALBWERTSZEIT_MS);
}

/** Verzögerung, wie sie die Simulation bekommt: ganze Millisekunden. */
export function verzoegerungBei(malus: PressenMalus, jetztMs: number): number {
  return Math.round(malusBei(malus, jetztMs));
}

/** Sitze, die gerade laufen dürfen. */
export function dranSitze(state: PressenState): number[] {
  if (state.fertig) return [];
  const offen = (sitz: number) => state.ergebnisse[sitz] == null;
  if (state.ampel != null && offen(state.ampel)) return [state.ampel];
  const dran: number[] = [];
  for (const team of state.teams) {
    const naechster = team.find(offen);
    if (naechster != null) dran.push(naechster);
  }
  return dran;
}

/** Warum jemand gerade nicht dran ist – für die Anzeige. */
export function wartetAuf(state: PressenState, sitz: number): 'ampel' | 'teamkollege' | null {
  if (state.fertig || state.ergebnisse[sitz] != null) return null;
  if (dranSitze(state).includes(sitz)) return null;
  if (state.ampel != null && state.ergebnisse[state.ampel] == null) return 'ampel';
  return 'teamkollege';
}

/** Prüft einen gemeldeten Lauf gegen das, was die Physik hergibt. */
export function pruefeLauf(zug: PressenZug): string | null {
  const ganz = (wert: number) => Number.isInteger(wert);
  if (!ganz(zug.dauerMs) || zug.dauerMs < MIN_DAUER_MS || zug.dauerMs > MAX_DAUER_MS) {
    return 'Unplausible Dauer.';
  }
  if (
    !ganz(zug.verschuettetDezi) ||
    zug.verschuettetDezi < 0 ||
    zug.verschuettetDezi > GLAS_ML * 10
  ) {
    return 'Unplausible Menge.';
  }
  // Getrunken ist, was nicht verschüttet wurde – und mehr als der Mund
  // schlucken kann (plus sein Fassungsvermögen) geht in der Zeit nicht.
  const getrunkenMl = GLAS_ML - zug.verschuettetDezi / 10;
  if (getrunkenMl > (SCHLUCK_RATE_ML_S * zug.dauerMs) / 1000 + MUND_KAPAZITAET_ML) {
    return 'Unplausibel schnell getrunken.';
  }
  if (zug.vorzeitig) {
    if (zug.reaktionMs != null) return 'Unplausible Reaktion.';
  } else if (
    zug.reaktionMs == null ||
    !ganz(zug.reaktionMs) ||
    zug.reaktionMs < MIN_REAKTION_MS ||
    zug.reaktionMs > zug.dauerMs
  ) {
    return 'Unplausible Reaktion.';
  }
  if (!ganz(zug.verzoegerungMs) || zug.verzoegerungMs < 0 || zug.verzoegerungMs > MALUS_MAX_MS) {
    return 'Unplausible Verzögerung.';
  }
  return null;
}

/* ---------- Zustandsmaschine ---------- */

function neuerZustand(players: GameSeat[]): PressenState {
  const n = Math.max(1, players.length);
  const plan = planFuer(n);
  return {
    ...plan,
    runde: 1,
    atempo: 0,
    ergebnisse: Array.from({ length: n }, () => null),
    vorrunde: null,
    letzterAbstandMs: null,
    malus: Array.from({ length: n }, () => ({ wertMs: 0, stand: 0 })),
    teamWertung: null,
    sieger: [],
    fertig: false,
  };
}

function angewendet(
  state: PressenState,
  sitz: number,
  zug: PressenZug,
  jetztMs: number,
): PressenState {
  const spiegel = state.modus === 'spiegel';
  const malus = state.malus[sitz]!;
  // Die Verzögerung kann nicht kleiner sein als der Malus jetzt und nicht
  // größer als der zu Beginn des Laufs – dazwischen wird begrenzt, nicht
  // abgelehnt: Eine verstellte Handyuhr soll keinen guten Lauf kosten.
  const untere = Math.max(0, verzoegerungBei(malus, jetztMs) - 2);
  const obere = Math.min(
    MALUS_MAX_MS,
    verzoegerungBei(malus, jetztMs - zug.dauerMs - START_SPIELRAUM_MS) + 2,
  );
  const verzoegerungMs = spiegel ? 0 : Math.max(untere, Math.min(obere, zug.verzoegerungMs));

  const ergebnis: PressenErgebnis = {
    dauerMs: zug.dauerMs,
    verschuettetDezi: zug.verschuettetDezi,
    reaktionMs: zug.reaktionMs,
    vorzeitig: zug.vorzeitig,
    verzoegerungMs,
    wertungMs: wertungMs(zug.dauerMs, zug.verschuettetDezi),
    getruemmert: !zug.vorzeitig && zug.reaktionMs != null && zug.reaktionMs <= GETRUEMMERT_MS,
  };

  const ergebnisse = state.ergebnisse.slice();
  ergebnisse[sitz] = ergebnis;
  const maluse = state.malus.slice();
  if (!spiegel) {
    maluse[sitz] = {
      wertMs: Math.min(MALUS_MAX_MS, verzoegerungBei(malus, jetztMs) + MALUS_PRO_RUNDE_MS),
      stand: jetztMs,
    };
  }
  const weiter: PressenState = { ...state, ergebnisse, malus: maluse };

  const alleDa =
    state.teams.flat().every((s) => ergebnisse[s] != null) &&
    (state.ampel == null || ergebnisse[state.ampel] != null);
  if (!alleDa) return weiter;

  const summen = state.teams.map((team) =>
    team.reduce((summe, s) => summe + ergebnisse[s]!.wertungMs, 0),
  );
  const abstand = spiegel ? 0 : Math.abs(summen[0]! - summen[1]!);
  const toleranz = ATEMPO_TOLERANZ_MS * (state.teams[0]?.length ?? 1);
  if (spiegel || abstand < toleranz) {
    return {
      ...weiter,
      runde: state.runde + 1,
      atempo: state.atempo + 1,
      vorrunde: ergebnisse,
      letzterAbstandMs: abstand,
      ergebnisse: ergebnisse.map(() => null),
    };
  }
  const gewinner = summen[0]! < summen[1]! ? 0 : 1;
  return {
    ...weiter,
    teamWertung: summen,
    sieger: state.teams[gewinner]!.slice(),
    fertig: true,
  };
}

function lies(raw: unknown): PressenZug | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const zahl = (w: unknown): w is number => typeof w === 'number' && Number.isFinite(w);
  if (r.typ !== 'ergebnis' || !zahl(r.runde) || !zahl(r.dauerMs)) return null;
  if (!zahl(r.verschuettetDezi) || !zahl(r.verzoegerungMs)) return null;
  if (typeof r.vorzeitig !== 'boolean') return null;
  if (r.reaktionMs !== null && !zahl(r.reaktionMs)) return null;
  return {
    typ: 'ergebnis',
    runde: r.runde,
    dauerMs: r.dauerMs,
    verschuettetDezi: r.verschuettetDezi,
    reaktionMs: r.reaktionMs as number | null,
    vorzeitig: r.vorzeitig,
    verzoegerungMs: r.verzoegerungMs,
  };
}

export const pressen: GameDefinition<PressenState, PressenZug> = {
  key: 'pressen',
  name: 'Pressen',
  description:
    'Bier so schnell wie möglich trinken – und möglichst nichts verschütten. Allein gegen den Spiegel, zu zweit, mit Ampel oder als Staffette.',
  emoji: '🍺',
  minPlayers: PRESSEN_MIN_SPIELER,
  maxPlayers: PRESSEN_MAX_SPIELER,
  echtzeit: true,

  createInitialState: neuerZustand,

  parseMove: lies,

  applyMove(state, zug, ctx): GameMoveResult<PressenState> {
    if (state.fertig) return { ok: false, error: 'Das Spiel ist beendet.' };
    if (zug.runde !== state.runde) return { ok: false, error: 'Diese Runde ist schon vorbei.' };
    if (!dranSitze(state).includes(ctx.seat)) {
      return { ok: false, error: 'Du bist gerade nicht dran.' };
    }
    const fehler = pruefeLauf(zug);
    if (fehler) return { ok: false, error: fehler };
    return { ok: true, state: angewendet(state, ctx.seat, zug, ctx.nowMs ?? Date.now()) };
  },

  currentSeat(state) {
    const dran = dranSitze(state);
    return dran.length === 1 ? dran[0]! : null;
  },

  getOutcome(state): GameOutcome {
    return { finished: state.fertig, draw: false, winnerSeats: state.sieger };
  },

  describe(state) {
    if (state.fertig) {
      return state.modus === 'duell' || state.modus === 'ampel'
        ? `Sieg für Spieler ${state.sieger[0]! + 1}`
        : `Sieg für Team ${state.teams.findIndex((t) => t[0] === state.sieger[0]) + 1}`;
    }
    return state.atempo > 0 ? `Atempo – Runde ${state.runde}` : `Runde ${state.runde} läuft`;
  },
};
