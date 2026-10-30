/**
 * Pressen – Regeln, Wertung, Rollen und Malus.
 *
 * Die Physik eines Laufs steht in `pressen-sim.ts` und läuft nur im Client.
 * Hier steht, was der Server prüft und entscheidet (gespiegelt in
 * `apps/api/src/games/pressen.rs`, beide gegen `testdaten/pressen.json`):
 * wer wann dran ist, wie ein gemeldeter Lauf gewertet wird, wann es Atempo
 * gibt, wer gewinnt, wie stark die Tasten verzögert sind (Malus = Ermüdung)
 * und wie ein gemeinsamer Start (Echtzeit) oder ein einzelner (asynchron)
 * abläuft.
 */
import type { GameDefinition, GameMoveResult, GameOutcome, GameSeat } from './types.js';
import {
  DT_MS,
  ERMUEDUNG_VOLL_MS,
  GLAS_ML,
  MAX_TICKS,
  MUND_KAPAZITAET_ML,
  SCHLUCK_RATE_ML_S,
} from './pressen-sim.js';

/* ---------- Konstanten ---------- */

/** Wertung = Dauer + Strafe; die Strafe wächst überlinear (siehe Entwurf). */
export const STRAFE_LINEAR_MS_PRO_ML = 100;
export const STRAFE_QUADRAT_MS_PRO_ML2 = 2;

/** Unterschied unter dieser Schwelle heißt „Atempo“ (je Läufer eines Teams). */
export const ATEMPO_TOLERANZ_MS = 250;

/** Jeder gespielte Lauf macht die Tasten um so viel träger … */
export const MALUS_PRO_RUNDE_MS = 40;
export const MALUS_MAX_MS = ERMUEDUNG_VOLL_MS;
/** … und nach dieser Zeit ist davon nur noch die Hälfte übrig. */
export const MALUS_HALBWERTSZEIT_MS = 120_000;

/** Glas leer und höchstens so schnell abgestellt: Auszeichnung „getrümmert“. */
export const GETRUEMMERT_MS = 450;

/** Plausibilitätsgrenzen für gemeldete Läufe. */
export const MIN_REAKTION_MS = 120;
export const MIN_DAUER_MS = 1500;
export const MAX_DAUER_MS = MAX_TICKS * DT_MS;
/** So lange darf zwischen „Anstoßen“ und der Meldung höchstens Spielraum liegen. */
const START_SPIELRAUM_MS = 30_000;

/** Echtzeit: so lange gilt eine „Zusammen“-Bestätigung, bis alle anderen nachziehen müssen. */
export const START_FRIST_MS = 10_000;
/** Echtzeit: Countdown 3-2-1 zwischen der letzten Bestätigung und dem gemeinsamen Beginn. */
export const START_ZAEHLER_MS = 3000;
/** Wie viel länger als „jetzt − gemeinsamer Beginn“ ein gemeldeter Lauf höchstens dauern darf. */
export const MELDE_SPIELRAUM_MS = 5000;
/** Obergrenze für das Warten bis „Anstoßen“ nach dem gemeinsamen Beginn. */
export const MAX_VERSATZ_MS = 600_000;

export const PRESSEN_MIN_SPIELER = 1;
export const PRESSEN_MAX_SPIELER = 8;

/* ---------- Typen ---------- */

export type PressenModus = 'spiegel' | 'duell' | 'ampel' | 'staffette';

/** Wie jemand antreten will: gemeinsam mit Countdown oder unabhängig vom anderen. */
export type PressenArt = 'echtzeit' | 'asynchron';

export interface PressenMalus {
  /**
   * Ermüdung als Verzögerung in ms zum Zeitpunkt `stand` (Serveruhr, ms seit
   * 1970). Sie verzögert die Tasten und steuert Trägheit, Dämpfung und
   * Haltekurve der Simulation (siehe `physikFuer`).
   */
  wertMs: number;
  stand: number;
}

export interface PressenErgebnis {
  /** Gesamtzeit; bei gemeinsamem Start steckt das Warten bis „Anstoßen“ darin. */
  dauerMs: number;
  verschuettetDezi: number;
  reaktionMs: number | null;
  vorzeitig: boolean;
  verzoegerungMs: number;
  /** Davon die Zeit zwischen gemeinsamem Beginn und „Anstoßen“ (0 bei asynchronem Lauf). */
  versatzMs: number;
  wertungMs: number;
  getruemmert: boolean;
}

/** Was andere vor Abschluss der Runde von einem fremden Lauf sehen: nur „fertig“. */
export interface PressenVerborgen {
  verborgen: true;
}

export function istVerborgen(e: unknown): e is PressenVerborgen {
  return typeof e === 'object' && e !== null && (e as PressenVerborgen).verborgen === true;
}

/**
 * Wie die Gruppe antritt. Eine Gruppe gibt es nur, wenn mindestens zwei Sitze
 * gleichzeitig loslaufen dürfen (Duell, die beiden ersten Läufer einer
 * Staffette, die beiden Teams nach der Ampel). Ein Einzelner (Spiegel, Ampel,
 * Staffetten-Nachfolger) startet immer mit seinem eigenen „Anstoßen“.
 */
export interface PressenStart {
  /** Mitglieder der Gruppe; leer = nichts abzustimmen. */
  gruppe: number[];
  /** Je Sitz die Wahl dieser Etappe (null = noch keine). */
  art: (PressenArt | null)[];
  /** Je Sitz die Serverzeit (ms), zu der „Zusammen“ bestätigt wurde. */
  bereitAm: (number | null)[];
  /** Gemeinsamer Beginn (Serverzeit, ms), sobald alle bestätigt haben; sonst null. */
  beginn: number | null;
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
  /** Start der laufenden Etappe (Echtzeit/asynchron). */
  start: PressenStart;
  /** Teamwertungen der entscheidenden Runde. */
  teamWertung: number[] | null;
  sieger: number[];
  fertig: boolean;
}

/**
 * Der Stand, wie ihn jemand VOR Abschluss der Runde ausgeliefert bekommt:
 * fremde Läufe sind nur als „fertig“ erkennbar. Der Server baut ihn
 * (`fuer_betrachter` in `pressen.rs`); der Client liest ihn.
 */
export type PressenAnsicht = Omit<PressenState, 'ergebnisse' | 'vorrunde'> & {
  ergebnisse: (PressenErgebnis | PressenVerborgen | null)[];
  vorrunde: (PressenErgebnis | PressenVerborgen | null)[] | null;
};

/** Ein gemeldeter Lauf. */
export interface PressenZug {
  typ: 'ergebnis';
  runde: number;
  dauerMs: number;
  verschuettetDezi: number;
  reaktionMs: number | null;
  vorzeitig: boolean;
  verzoegerungMs: number;
  /** Echtzeit: Zeit zwischen gemeinsamem Beginn und „Anstoßen“ (in `dauerMs` enthalten); sonst null. */
  versatzMs: number | null;
}

/** Wahl vor dem Start: „Zusammen (Echtzeit)“ oder „Wann ich will (asynchron)“. */
export interface PressenStartZug {
  typ: 'start';
  art: PressenArt;
}

export type PressenBewegung = PressenZug | PressenStartZug;

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

/** Sitze, die gerade laufen dürfen (arbeitet auch auf der verborgenen Ansicht). */
export function dranSitze(
  state: Pick<PressenState, 'fertig' | 'ampel' | 'teams'> & {
    ergebnisse: readonly (unknown | null)[];
  },
): number[] {
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
export function wartetAuf(
  state: Pick<PressenState, 'fertig' | 'ampel' | 'teams'> & {
    ergebnisse: readonly (unknown | null)[];
  },
  sitz: number,
): 'ampel' | 'teamkollege' | null {
  if (state.fertig || state.ergebnisse[sitz] != null) return null;
  if (dranSitze(state).includes(sitz)) return null;
  if (state.ampel != null && state.ergebnisse[state.ampel] == null) return 'ampel';
  return 'teamkollege';
}

/* ---------- Start: Echtzeit oder asynchron ---------- */

export function neuerStart(n: number, gruppe: number[]): PressenStart {
  return {
    gruppe: gruppe.length >= 2 ? gruppe.slice() : [],
    art: Array.from({ length: n }, () => null),
    bereitAm: Array.from({ length: n }, () => null),
    beginn: null,
  };
}

/** Ältere Stände kennen den Start noch nicht: dort gibt es nichts abzustimmen. */
function startVon(state: { start?: PressenStart; ergebnisse: readonly unknown[] }): PressenStart {
  return state.start ?? neuerStart(state.ergebnisse.length, []);
}

/**
 * Wo steht ein Sitz im Start?
 *
 *  - `frei`: nichts abzustimmen, „Anstoßen“ gilt sofort und die Zeit zählt ab da
 *    (Einzelne, Staffetten-Nachfolger, Spiegel).
 *  - `wahl`: der Sitz muss noch wählen.
 *  - `wartet`: „Zusammen“ ist bestätigt, die anderen haben bis `frist` (Serverzeit).
 *  - `zaehlt` / `gestartet`: der gemeinsame Beginn steht fest; davor Countdown, danach
 *    läuft die Uhr, auch wenn „Anstoßen“ noch nicht gedrückt ist.
 *  - `asynchron`: jemand will unabhängig spielen, oder die Frist ist verfallen
 *    (`grund: 'frist'`): die Zeit zählt ab dem eigenen „Anstoßen“.
 */
export type StartPhase =
  | { phase: 'frei' }
  | { phase: 'wahl' }
  | { phase: 'wartet'; frist: number; bereit: number; von: number }
  | { phase: 'zaehlt'; beginn: number }
  | { phase: 'gestartet'; beginn: number }
  | { phase: 'asynchron'; grund: 'gewaehlt' | 'frist' };

export function startPhase(
  state: Pick<PressenState, 'fertig' | 'ampel' | 'teams'> & {
    ergebnisse: readonly (unknown | null)[];
    start?: PressenStart;
  },
  sitz: number,
  jetztMs: number,
): StartPhase {
  const start = startVon(state);
  const offene = start.gruppe.filter((s) => state.ergebnisse[s] == null);
  if (!start.gruppe.includes(sitz) || state.ergebnisse[sitz] != null) return { phase: 'frei' };
  if (start.beginn != null) {
    return jetztMs < start.beginn
      ? { phase: 'zaehlt', beginn: start.beginn }
      : { phase: 'gestartet', beginn: start.beginn };
  }
  if (offene.length < 2) return { phase: 'frei' };
  if (offene.some((s) => start.art[s] === 'asynchron')) {
    return { phase: 'asynchron', grund: 'gewaehlt' };
  }
  const meine = start.art[sitz] ?? null;
  if (meine == null) return { phase: 'wahl' };
  const bestaetigt = offene.filter((s) => start.bereitAm[s] != null);
  const frist = Math.min(...bestaetigt.map((s) => start.bereitAm[s]!)) + START_FRIST_MS;
  if (jetztMs > frist) return { phase: 'asynchron', grund: 'frist' };
  return { phase: 'wartet', frist, bereit: bestaetigt.length, von: offene.length };
}

/** Prüft eine Wahl und bucht sie ein (Serveruhr `jetztMs`). */
function startAngewendet(
  state: PressenState,
  sitz: number,
  zug: PressenStartZug,
  jetztMs: number,
): GameMoveResult<PressenState> {
  if (state.fertig) return { ok: false, error: 'Das Spiel ist beendet.' };
  const start = startVon(state);
  const offene = start.gruppe.filter((s) => state.ergebnisse[s] == null);
  if (!offene.includes(sitz) || offene.length < 2) {
    return { ok: false, error: 'Hier gibt es nichts abzustimmen.' };
  }
  if (start.beginn != null) return { ok: false, error: 'Der Start steht schon fest.' };
  const alt = start.art[sitz] ?? null;
  if (alt === 'asynchron' || (alt === zug.art && zug.art === 'echtzeit')) {
    // Asynchron ist endgültig; ein zweites „Zusammen“ ändert nichts.
    if (alt === zug.art) return { ok: true, state };
    return { ok: false, error: 'Du hast schon „Wann ich will“ gewählt.' };
  }
  const art = start.art.slice();
  const bereitAm = start.bereitAm.slice();
  art[sitz] = zug.art;
  bereitAm[sitz] = zug.art === 'echtzeit' ? jetztMs : null;
  let beginn: number | null = null;
  const alleZusammen = offene.every((s) => art[s] === 'echtzeit' && bereitAm[s] != null);
  if (alleZusammen) {
    const aelteste = Math.min(...offene.map((s) => bereitAm[s]!));
    // Zu spät bestätigt (Frist verfallen): kein gemeinsamer Beginn mehr.
    if (jetztMs <= aelteste + START_FRIST_MS) beginn = jetztMs + START_ZAEHLER_MS;
  }
  return { ok: true, state: { ...state, start: { ...start, art, bereitAm, beginn } } };
}

/* ---------- Plausibilität ---------- */

/** Prüft einen gemeldeten Lauf gegen das, was die Physik hergibt. */
export function pruefeLauf(
  zug: PressenZug,
  gemeinsam?: { jetztMs: number; beginn: number | null },
): string | null {
  const ganz = (wert: number) => Number.isInteger(wert);
  const versatz = zug.versatzMs ?? 0;
  if (!ganz(versatz) || versatz < 0 || versatz > MAX_VERSATZ_MS) return 'Unplausibler Start.';
  const laufMs = zug.dauerMs - versatz;
  if (!ganz(zug.dauerMs) || laufMs < MIN_DAUER_MS || laufMs > MAX_DAUER_MS) {
    return 'Unplausible Dauer.';
  }
  // Wer gemeinsam gestartet ist, kann nicht länger gebraucht haben, als seit
  // dem gemeinsamen Beginn vergangen ist.
  if (
    zug.versatzMs != null &&
    gemeinsam?.beginn != null &&
    zug.dauerMs > gemeinsam.jetztMs - gemeinsam.beginn + MELDE_SPIELRAUM_MS
  ) {
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
  if (getrunkenMl > (SCHLUCK_RATE_ML_S * laufMs) / 1000 + MUND_KAPAZITAET_ML) {
    return 'Unplausibel schnell getrunken.';
  }
  if (zug.vorzeitig) {
    if (zug.reaktionMs != null) return 'Unplausible Reaktion.';
  } else if (
    zug.reaktionMs == null ||
    !ganz(zug.reaktionMs) ||
    zug.reaktionMs < MIN_REAKTION_MS ||
    zug.reaktionMs > laufMs
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
  const zustand: PressenState = {
    ...plan,
    runde: 1,
    atempo: 0,
    ergebnisse: Array.from({ length: n }, () => null),
    vorrunde: null,
    letzterAbstandMs: null,
    malus: Array.from({ length: n }, () => ({ wertMs: 0, stand: 0 })),
    start: neuerStart(n, []),
    teamWertung: null,
    sieger: [],
    fertig: false,
  };
  zustand.start = neuerStart(n, dranSitze(zustand));
  return zustand;
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
  const start = startVon(state);

  const ergebnis: PressenErgebnis = {
    dauerMs: zug.dauerMs,
    verschuettetDezi: zug.verschuettetDezi,
    reaktionMs: zug.reaktionMs,
    vorzeitig: zug.vorzeitig,
    verzoegerungMs,
    // Ohne gemeinsamen Beginn gibt es keinen Versatz, der zählen könnte.
    versatzMs: start.beginn != null ? (zug.versatzMs ?? 0) : 0,
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
  const weiter: PressenState = { ...state, ergebnisse, malus: maluse, start };

  const alleDa =
    state.teams.flat().every((s) => ergebnisse[s] != null) &&
    (state.ampel == null || ergebnisse[state.ampel] != null);
  if (!alleDa) {
    // Wer nach diesem Lauf NEU dran ist: zwei oder mehr gleichzeitig (nach der
    // Ampel) stimmen sich wieder ab, ein einzelner Nachfolger startet frei.
    const vorher = dranSitze(state);
    const neu = dranSitze(weiter).filter((s) => !vorher.includes(s));
    return neu.length >= 2 ? { ...weiter, start: neuerStart(ergebnisse.length, neu) } : weiter;
  }

  const summen = state.teams.map((team) =>
    team.reduce((summe, s) => summe + ergebnisse[s]!.wertungMs, 0),
  );
  const abstand = spiegel ? 0 : Math.abs(summen[0]! - summen[1]!);
  const toleranz = ATEMPO_TOLERANZ_MS * (state.teams[0]?.length ?? 1);
  if (spiegel || abstand < toleranz) {
    const naechste: PressenState = {
      ...weiter,
      runde: state.runde + 1,
      atempo: state.atempo + 1,
      vorrunde: ergebnisse,
      letzterAbstandMs: abstand,
      ergebnisse: ergebnisse.map(() => null),
    };
    return { ...naechste, start: neuerStart(ergebnisse.length, dranSitze(naechste)) };
  }
  const gewinner = summen[0]! < summen[1]! ? 0 : 1;
  return {
    ...weiter,
    teamWertung: summen,
    sieger: state.teams[gewinner]!.slice(),
    fertig: true,
  };
}

function lies(raw: unknown): PressenBewegung | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const zahl = (w: unknown): w is number => typeof w === 'number' && Number.isFinite(w);
  if (r.typ === 'start') {
    return r.art === 'echtzeit' || r.art === 'asynchron' ? { typ: 'start', art: r.art } : null;
  }
  if (r.typ !== 'ergebnis' || !zahl(r.runde) || !zahl(r.dauerMs)) return null;
  if (!zahl(r.verschuettetDezi) || !zahl(r.verzoegerungMs)) return null;
  if (typeof r.vorzeitig !== 'boolean') return null;
  if (r.reaktionMs !== null && !zahl(r.reaktionMs)) return null;
  // Fehlt der Versatz (ältere Clients), ist es ein Lauf ab eigenem „Anstoßen“.
  const versatz = r.versatzMs ?? null;
  if (versatz !== null && !zahl(versatz)) return null;
  return {
    typ: 'ergebnis',
    runde: r.runde,
    dauerMs: r.dauerMs,
    verschuettetDezi: r.verschuettetDezi,
    reaktionMs: r.reaktionMs as number | null,
    vorzeitig: r.vorzeitig,
    verzoegerungMs: r.verzoegerungMs,
    versatzMs: versatz,
  };
}

export const pressen: GameDefinition<PressenState, PressenBewegung> = {
  key: 'pressen',
  name: 'Pressen',
  description:
    'Bier so schnell wie möglich trinken – und möglichst nichts verschütten. Allein gegen den Spiegel, zu zweit, mit Ampel oder als Staffette; gemeinsam in Echtzeit oder jeder, wann er will.',
  emoji: '🍺',
  minPlayers: PRESSEN_MIN_SPIELER,
  maxPlayers: PRESSEN_MAX_SPIELER,
  echtzeit: true,

  createInitialState: neuerZustand,

  parseMove: lies,

  applyMove(state, zug, ctx): GameMoveResult<PressenState> {
    const jetzt = ctx.nowMs ?? Date.now();
    if (zug.typ === 'start') return startAngewendet(state, ctx.seat, zug, jetzt);
    if (state.fertig) return { ok: false, error: 'Das Spiel ist beendet.' };
    if (zug.runde !== state.runde) return { ok: false, error: 'Diese Runde ist schon vorbei.' };
    if (!dranSitze(state).includes(ctx.seat)) {
      return { ok: false, error: 'Du bist gerade nicht dran.' };
    }
    const fehler = pruefeLauf(zug, { jetztMs: jetzt, beginn: startVon(state).beginn });
    if (fehler) return { ok: false, error: fehler };
    // Die Vorhersage im Client kennt fremde Läufe nur als „fertig“; steht eine
    // Runde damit nicht fest, bucht sie nur den eigenen Lauf ein und wartet auf
    // den Stand des Servers.
    if (state.ergebnisse.some((e, i) => i !== ctx.seat && istVerborgen(e))) {
      const ergebnisse = state.ergebnisse.slice();
      ergebnisse[ctx.seat] = {
        dauerMs: zug.dauerMs,
        verschuettetDezi: zug.verschuettetDezi,
        reaktionMs: zug.reaktionMs,
        vorzeitig: zug.vorzeitig,
        verzoegerungMs: zug.verzoegerungMs,
        versatzMs: zug.versatzMs ?? 0,
        wertungMs: wertungMs(zug.dauerMs, zug.verschuettetDezi),
        getruemmert: false,
      };
      return { ok: true, state: { ...state, ergebnisse } };
    }
    return { ok: true, state: angewendet(state, ctx.seat, zug, jetzt) };
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
