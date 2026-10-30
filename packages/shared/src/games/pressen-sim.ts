/**
 * Pressen – die Physik eines Laufs.
 *
 * Reine Funktion mit festem Zeitschritt: gleiche Eingaben, gleiches Ergebnis,
 * auf jedem Gerät. Jeder Client rechnet seinen Lauf selbst (die Steuerung darf
 * nicht auf das Netz warten); der Server bekommt nur das Ergebnis und prüft es
 * auf Plausibilität (siehe `pressen.ts` und `docs/entwurf-pressen.md`).
 *
 * WARUM nur `+ - * /` und Vergleiche: `Math.sin`, `Math.pow` & Co. dürfen sich
 * von Browser zu Browser in der letzten Stelle unterscheiden, Grundrechenarten
 * nicht. So bleibt ein Lauf bitgleich, wenn man ihn irgendwo wiederholt (etwa
 * für die Wiederholung beim Gegner).
 *
 * Maße: Das Spielfeld ist 1000 Einheiten breit, der Mund steht in der Mitte.
 * Neigung in Grad (0 = aufrecht), Füllung in Millilitern.
 */

/** Zeitschritt in Millisekunden – Eingaben werden auf ihn gerundet. */
export const DT_MS = 20;
const DT = DT_MS / 1000;

export const GLAS_ML = 300;
export const FELD_BREITE = 1000;
export const MUND_X = 500;
/** Halbe Breite der Öffnung: so weit darf der Strahl daneben liegen. */
export const MUND_HALB = 45;
export const GLAS_START_X = 120;

/** Höchstgeschwindigkeit und Beschleunigung des Glases (Einheiten je s, s²). */
export const GLAS_V_MAX = 300;
export const GLAS_BESCHLEUNIGUNG = 1800;

export const NEIGUNG_MAX = 110;
/** Grad je Sekunde beim Neigen und beim Zurückkippen. */
export const NEIGUNG_HOCH = 40;
export const NEIGUNG_RUNTER = 60;

/** Fluss je Grad über der Kippschwelle (ml/s). */
export const FLUSS_PRO_GRAD = 2;
/** Der Mund fasst so viel auf einmal; mehr läuft daneben. */
export const MUND_KAPAZITAET_ML = 25;
/** Und schluckt so schnell (ml/s). */
export const SCHLUCK_RATE_ML_S = 30;

/** Unter dieser Füllung gilt das Glas als leer. */
const LEER_ML = 0.05;
/** Obergrenze, damit ein liegengelassener Lauf endet (10 Minuten). */
export const MAX_TICKS = 30_000;

/**
 * Neigung, ab der bei dieser Füllung Bier über den Rand kommt: volles Glas
 * früh, fast leeres erst kurz vor dem Kopfstand. Deshalb muss man beim Trinken
 * nachkippen.
 */
export function kippSchwelle(fuellungMl: number): number {
  return 20 + 70 * (1 - fuellungMl / GLAS_ML);
}

export type Taste = 'links' | 'rechts' | 'neigen';

/** Ein Tastendruck oder Loslassen, `t` in ms seit dem Start des Laufs. */
export interface TastenEreignis {
  t: number;
  was: Taste;
  unten: boolean;
}
/** „Abstellen“-Knopf nach leerem Glas, oder `vorzeitig` (Rest zählt als verschüttet). */
export interface AbstellEreignis {
  t: number;
  was: 'abstellen' | 'vorzeitig';
}
export type Eingabe = TastenEreignis | AbstellEreignis;

export interface SimZustand {
  /** Zahl der bereits gerechneten Schritte; Zeit = tick * DT_MS. */
  tick: number;
  /** Nächste noch nicht angewendete Eingabe. */
  naechste: number;
  x: number;
  vx: number;
  neigung: number;
  fuellung: number;
  mund: number;
  getrunken: number;
  verschuettet: number;
  /** Aktueller Strahl in ml/s und ob er den Mund trifft (für die Zeichnung). */
  fluss: number;
  trifft: boolean;
  links: boolean;
  rechts: boolean;
  neigen: boolean;
  /** Schritt, in dem das Glas leer wurde, sonst null. */
  leerTick: number | null;
  abgestelltTick: number | null;
  vorzeitig: boolean;
  /** Abgestellt und der Mund ist leer: der Lauf ist zu Ende. */
  fertig: boolean;
}

export function neuerZustand(): SimZustand {
  return {
    tick: 0,
    naechste: 0,
    x: GLAS_START_X,
    vx: 0,
    neigung: 0,
    fuellung: GLAS_ML,
    mund: 0,
    getrunken: 0,
    verschuettet: 0,
    fluss: 0,
    trifft: false,
    links: false,
    rechts: false,
    neigen: false,
    leerTick: null,
    abgestelltTick: null,
    vorzeitig: false,
    fertig: false,
  };
}

function naeher(wert: number, ziel: number, schritt: number): number {
  if (wert < ziel) return Math.min(ziel, wert + schritt);
  return Math.max(ziel, wert - schritt);
}

/** Zeitpunkt (ms), zu dem eine Eingabe nach dem Malus gilt. */
function wirkt(eingabe: Eingabe, verzoegerungMs: number): number {
  // Der Malus trifft Position und Neigung – Drücken UND Loslassen. Der
  // Abstellen-Knopf ist ein Zeigen, kein Steuern, und bleibt unverzögert.
  return 'unten' in eingabe ? eingabe.t + verzoegerungMs : eingabe.t;
}

/**
 * Rechnet bis einschließlich Schritt `bisTick` weiter.
 *
 * `eingaben` muss nach `t` sortiert sein und darf nur wachsen; ein Ereignis in
 * der Vergangenheit bereits gerechneter Schritte würde nicht mehr
 * berücksichtigt. Der Aufrufer legt neue Ereignisse deshalb nach
 * `tick * DT_MS` ab.
 */
export function simBis(
  start: SimZustand,
  eingaben: readonly Eingabe[],
  verzoegerungMs: number,
  bisTick: number,
): SimZustand {
  const z = { ...start };
  const ende = Math.min(bisTick, MAX_TICKS);
  while (z.tick < ende && !z.fertig) {
    z.tick += 1;
    const jetzt = z.tick * DT_MS;

    while (z.naechste < eingaben.length) {
      const e = eingaben[z.naechste]!;
      if (wirkt(e, verzoegerungMs) > jetzt) break;
      z.naechste += 1;
      if (z.abgestelltTick != null) continue;
      if ('unten' in e) {
        z[e.was] = e.unten;
      } else if (e.was === 'abstellen' && z.leerTick != null) {
        z.abgestelltTick = z.tick;
      } else if (e.was === 'vorzeitig') {
        z.abgestelltTick = z.tick;
        z.vorzeitig = z.leerTick == null;
      }
    }

    z.fluss = 0;
    z.trifft = false;

    if (z.abgestelltTick == null) {
      // Position: Trägheit, damit das Glas nicht auf der Stelle steht.
      const ziel = (z.rechts ? 1 : 0) - (z.links ? 1 : 0);
      z.vx = naeher(z.vx, ziel * GLAS_V_MAX, GLAS_BESCHLEUNIGUNG * DT);
      z.x = Math.min(FELD_BREITE, Math.max(0, z.x + z.vx * DT));

      z.neigung = z.neigen
        ? Math.min(NEIGUNG_MAX, z.neigung + NEIGUNG_HOCH * DT)
        : Math.max(0, z.neigung - NEIGUNG_RUNTER * DT);

      if (z.fuellung > 0) {
        const ueber = z.neigung - kippSchwelle(z.fuellung);
        if (ueber > 0) {
          const menge = Math.min(z.fuellung, FLUSS_PRO_GRAD * ueber * DT);
          z.fuellung -= menge;
          z.fluss = menge / DT;
          z.trifft = Math.abs(z.x - MUND_X) <= MUND_HALB;
          if (z.trifft) z.mund += menge;
          else z.verschuettet += menge;
        }
        if (z.fuellung <= LEER_ML) {
          // Das letzte Restchen läuft mit – sonst gäbe es ein unsichtbares Glas.
          if (z.trifft) z.mund += z.fuellung;
          else z.verschuettet += z.fuellung;
          z.fuellung = 0;
          z.leerTick = z.tick;
        }
      }
    } else if (z.fuellung > 0) {
      // Vorzeitig abgestellt: was noch drin ist, gilt als verschüttet.
      z.verschuettet += z.fuellung;
      z.fuellung = 0;
    }

    // Der Mund schluckt gleichmäßig; was nicht hineinpasst, läuft über.
    const schluck = Math.min(z.mund, SCHLUCK_RATE_ML_S * DT);
    z.mund -= schluck;
    z.getrunken += schluck;
    if (z.mund > MUND_KAPAZITAET_ML) {
      z.verschuettet += z.mund - MUND_KAPAZITAET_ML;
      z.mund = MUND_KAPAZITAET_ML;
    }

    if (z.abgestelltTick != null && z.mund <= 1e-9) z.fertig = true;
  }
  return z;
}

export interface LaufErgebnis {
  dauerMs: number;
  /** Verschüttet in Zehntelmilliliter – ganze Zahlen kreuzen die Sprachgrenze exakt. */
  verschuettetDezi: number;
  /** Zeit von „Glas leer“ bis „abgestellt“; null bei vorzeitigem Abstellen. */
  reaktionMs: number | null;
  vorzeitig: boolean;
}

/** Fasst einen beendeten Lauf zusammen; null, solange er läuft. */
export function ergebnisVon(z: SimZustand): LaufErgebnis | null {
  if (!z.fertig || z.abgestelltTick == null) return null;
  const reaktion =
    !z.vorzeitig && z.leerTick != null ? (z.abgestelltTick - z.leerTick) * DT_MS : null;
  return {
    dauerMs: z.tick * DT_MS,
    verschuettetDezi: Math.round(z.verschuettet * 10),
    reaktionMs: reaktion,
    vorzeitig: z.vorzeitig,
  };
}

/** Der ganze Lauf auf einmal; null, wenn nie abgestellt wurde. */
export function simuliere(
  eingaben: readonly Eingabe[],
  verzoegerungMs: number,
): LaufErgebnis | null {
  return ergebnisVon(simBis(neuerZustand(), eingaben, verzoegerungMs, MAX_TICKS));
}
