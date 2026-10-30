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
 * für die Wiederholung beim Gegner). Aus demselben Grund steckt die
 * Abdrift als Tabelle fertiger Richtungen in der Datei und nicht als `cos`/`sin`.
 *
 * # Die Bühne
 *
 * Man schaut von oben auf die Tischplatte, leicht geneigt: Das Glas hat zwei
 * Lageachsen – `x` links/rechts und `y` vor/zurück (im Bild unten/oben) – und
 * eine Neigung. Der Mund ist ein flaches Oval auf der Platte. Das Bier verlässt
 * das Glas am vorderen Rand und fällt in einer Parabel: Je weiter geneigt,
 * desto weiter fliegt der Strahl nach vorn (`y` kleiner), und die eigene
 * Bewegung fliegt ein Stück mit. Getrunken ist nur, was im Oval landet.
 *
 * # Wie sich die Tasten anfühlen
 *
 * - **Trägheit**: Eine Taste legt nur ein Ziel fest; die Geschwindigkeit holt
 *   es mit begrenzter Beschleunigung ein.
 * - **Nichtlinear**: Das Ziel hängt davon ab, wie lange die Taste schon
 *   gehalten wird: kurz = kriechen, lang = deutlich schneller.
 * - **Gleiten**: Wer loslässt, bremst nicht – die Geschwindigkeit klingt mit
 *   einer Dämpfungsrate ab.
 * - **Abdrift**: Eine langsam wechselnde Beschleunigung schiebt das Glas immer
 *   leicht weg; sie hängt nur von der Runde ab, nicht vom Gerät.
 * - **Ermüdung (Malus)**: `verzoegerungMs` verzögert nicht nur jede Taste,
 *   sondern macht Beschleunigung träger, Dämpfung schwächer, die Kurve steiler
 *   und die Abdrift stärker (siehe `physikFuer`).
 *
 * Maße: Das Spielfeld ist 1000 × 600 Einheiten. Neigung in Grad (0 =
 * aufrecht), Füllung in Millilitern.
 */

/** Zeitschritt in Millisekunden – Eingaben werden auf ihn gerundet. */
export const DT_MS = 20;
const DT = DT_MS / 1000;

export const GLAS_ML = 300;
export const FELD_BREITE = 1000;
export const FELD_TIEFE = 600;
export const MUND_X = 500;
export const MUND_Y = 210;
/** Halbachsen des Munds (Oval): so weit darf der Strahl daneben liegen. */
export const MUND_HALB_X = 62;
export const MUND_HALB_Y = 42;
export const GLAS_START_X = 140;
export const GLAS_START_Y = 480;

/**
 * Bei „voller“ Ermüdung gilt die Verzögerung als 100 %. Gleich
 * `MALUS_MAX_MS` in `pressen.ts` (dort die Regel, hier die Physik).
 */
export const ERMUEDUNG_VOLL_MS = 250;

/** Kriechtempo bei kurzem Druck und Höchsttempo bei langem (Einheiten je s). */
export const GLAS_V_MIN = 22;
export const GLAS_V_MAX = 340;
/** Nach so vielen Sekunden Halten gilt die Taste als „ganz durchgedrückt“. */
export const GLAS_HALTE_VOLL_S = 1.25;
/** Wie schnell die Geschwindigkeit das Ziel einholt (Einheiten je s²). */
export const GLAS_BESCHLEUNIGUNG = 620;
/** Wie stark die Geschwindigkeit nach dem Loslassen abklingt (je Sekunde). */
export const GLAS_DAEMPFUNG = 2.4;
/** Abdrift (Einheiten je s²) und die Dauer einer Richtung (Schritte). */
export const DRIFT_BESCHLEUNIGUNG = 46;
export const DRIFT_SEGMENT_TICKS = 150;

export const NEIGUNG_MAX = 110;
/** Neigen: Kriechen bei kurzem Druck, Höchsttempo nach langem (Grad je s). */
export const NEIGUNG_V_MIN = 7;
export const NEIGUNG_V_MAX = 46;
export const NEIGUNG_HALTE_VOLL_S = 1.4;
/**
 * Zurückkippen ohne Taste (Grad je s) und Trägheit der Drehung (Grad je s²).
 *
 * Das Zurückkippen ist bewusst langsamer als das Neigen und kommt erst
 * allmählich in Fahrt (`NEIGUNG_RUECK_BESCHLEUNIGUNG`): Wer kurz loslässt,
 * soll das Glas nicht sofort aufrecht haben – erst nach einer Weile versiegt
 * der Strahl. Vorher schnappte es mit 50 °/s zurück, das fühlte sich an wie
 * eine Feder statt wie eine Hand.
 */
export const NEIGUNG_RUECK = 24;
export const NEIGUNG_BESCHLEUNIGUNG = 380;
export const NEIGUNG_RUECK_BESCHLEUNIGUNG = 90;

/** Fluss je Grad über der Kippschwelle (ml/s). */
export const FLUSS_PRO_GRAD = 2;
/**
 * Strahl: Reichweite nach vorn = Grundweite + Weite je Grad über der Schwelle,
 * dazu fliegt die Geschwindigkeit des Glases `FALLZEIT_S` lang mit.
 */
export const STRAHL_GRUNDWEITE = 55;
export const STRAHL_WEITE_PRO_GRAD = 2;
export const FALLZEIT_S = 0.22;
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

/** Die 16 Richtungen der Abdrift im Abstand von 22,5° (fertige Zahlen, siehe Kopf). */
const RICHTUNG_X = [
  1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1, -0.92388, -0.70711, -0.38268,
  0, 0.38268, 0.70711, 0.92388,
] as const;
const RICHTUNG_Y = [
  0, 0.38268, 0.70711, 0.92388, 1, 0.92388, 0.70711, 0.38268, 0, -0.38268, -0.70711, -0.92388, -1,
  -0.92388, -0.70711, -0.38268,
] as const;

/**
 * Wert der Abdrift-Zufallsreihe für den `n`-ten Abschnitt: ganze Zahlen, damit
 * nichts gerundet wird. Gleiche Runde, gleicher Abschnitt, gleiche Richtung.
 */
function richtungsIndex(driftSeed: number, n: number): number {
  return (driftSeed * 5 + n * 7 + (((driftSeed + 3) * (n + 1)) % 11)) % 16;
}

/** Der Anfangswert der Abdrift für eine Runde (alle Sitze haben dieselben Bedingungen). */
export function driftSeedFuer(runde: number): number {
  return Math.max(0, Math.floor(runde)) % 1_000_003;
}

/** Abdrift-Beschleunigung (Einheiten je s²) zum Schritt `tick`. */
export function driftBei(
  tick: number,
  driftSeed: number,
  staerke: number,
): { ax: number; ay: number } {
  const abschnitt = Math.floor(tick / DRIFT_SEGMENT_TICKS);
  const s = (tick - abschnitt * DRIFT_SEGMENT_TICKS) / DRIFT_SEGMENT_TICKS;
  const a = richtungsIndex(driftSeed, abschnitt);
  const b = richtungsIndex(driftSeed, abschnitt + 1);
  return {
    ax: staerke * ((1 - s) * RICHTUNG_X[a]! + s * RICHTUNG_X[b]!),
    ay: staerke * ((1 - s) * RICHTUNG_Y[a]! + s * RICHTUNG_Y[b]!),
  };
}

export type Taste = 'links' | 'rechts' | 'hoch' | 'runter' | 'neigen';
export const TASTEN: readonly Taste[] = ['links', 'rechts', 'hoch', 'runter', 'neigen'];

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
  y: number;
  vx: number;
  vy: number;
  /** Wie lange die Richtung auf der jeweiligen Achse schon gehalten wird (s). */
  halteX: number;
  halteY: number;
  /** Richtung der Achse im letzten Schritt (-1, 0, 1). */
  richtungX: number;
  richtungY: number;
  neigung: number;
  /** Drehgeschwindigkeit des Glases (Grad je s). */
  neigungV: number;
  halteNeigen: number;
  fuellung: number;
  mund: number;
  getrunken: number;
  verschuettet: number;
  /** Aktueller Strahl in ml/s, ob er den Mund trifft und wo er landet (für die Zeichnung). */
  fluss: number;
  trifft: boolean;
  landeX: number;
  landeY: number;
  links: boolean;
  rechts: boolean;
  hoch: boolean;
  runter: boolean;
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
    y: GLAS_START_Y,
    vx: 0,
    vy: 0,
    halteX: 0,
    halteY: 0,
    richtungX: 0,
    richtungY: 0,
    neigung: 0,
    neigungV: 0,
    halteNeigen: 0,
    fuellung: GLAS_ML,
    mund: 0,
    getrunken: 0,
    verschuettet: 0,
    fluss: 0,
    trifft: false,
    landeX: GLAS_START_X,
    landeY: GLAS_START_Y,
    links: false,
    rechts: false,
    hoch: false,
    runter: false,
    neigen: false,
    leerTick: null,
    abgestelltTick: null,
    vorzeitig: false,
    fertig: false,
  };
}

/** Alles, was die Ermüdung an der Physik ändert – an einer Stelle nachlesbar. */
export interface Physik {
  /** 0 (ausgeruht) bis 1 (voll ermüdet). */
  q: number;
  beschleunigung: number;
  daempfung: number;
  drift: number;
  winkelBeschleunigung: number;
  /** Wie schnell das Zurückkippen in Fahrt kommt – mit Malus noch zäher. */
  rueckBeschleunigung: number;
}

export function physikFuer(verzoegerungMs: number): Physik {
  const q = Math.min(1, Math.max(0, verzoegerungMs / ERMUEDUNG_VOLL_MS));
  return {
    q,
    // Träger: das Ziel wird später erreicht.
    beschleunigung: GLAS_BESCHLEUNIGUNG * (1 - 0.35 * q),
    // Schwächere Dämpfung: das Glas gleitet nach dem Loslassen weiter.
    daempfung: GLAS_DAEMPFUNG * (1 - 0.5 * q),
    drift: DRIFT_BESCHLEUNIGUNG * (1 + 0.4 * q),
    winkelBeschleunigung: NEIGUNG_BESCHLEUNIGUNG * (1 - 0.35 * q),
    rueckBeschleunigung: NEIGUNG_RUECK_BESCHLEUNIGUNG * (1 - 0.35 * q),
  };
}

/**
 * Die Haltekurve: 0 bis 1 über die Haltedauer. Ausgeruht quadratisch (kurz sehr
 * langsam, dann zunehmend schneller), bei Ermüdung Richtung kubisch – derselbe
 * Druck bleibt länger kriechend und wird erst spät schnell.
 */
export function haltekurve(halteS: number, vollS: number, q: number): number {
  const s = Math.min(1, halteS / vollS);
  const s2 = s * s;
  return s2 + q * (s2 * s - s2);
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
 * Eine Lageachse um einen Schritt: Taste = Ziel, Geschwindigkeit holt es mit
 * begrenzter Beschleunigung ein; ohne Taste klingt sie nur ab.
 */
function achse(
  v: number,
  halte: number,
  richtungAlt: number,
  richtung: number,
  p: Physik,
  drift: number,
): { v: number; halte: number } {
  let neuV = v;
  let neuHalte = 0;
  if (richtung === 0) {
    neuV -= neuV * p.daempfung * DT;
  } else {
    // Richtungswechsel fängt die Kurve von vorn an.
    neuHalte = (richtung === richtungAlt ? halte : 0) + DT;
    const tempo =
      GLAS_V_MIN + (GLAS_V_MAX - GLAS_V_MIN) * haltekurve(neuHalte, GLAS_HALTE_VOLL_S, p.q);
    if (neuV * richtung > tempo) {
      // Schon schneller in diese Richtung (Gleiten): weiter nur abklingen,
      // nicht abbremsen, nur weil man erneut drückt.
      neuV -= neuV * p.daempfung * DT;
    } else {
      neuV = naeher(neuV, richtung * tempo, p.beschleunigung * DT);
    }
  }
  return { v: neuV + drift * DT, halte: neuHalte };
}

/** Liegt der Landepunkt im Mund-Oval? (Ohne Division: Ellipsengleichung mal Nenner.) */
export function imMund(lx: number, ly: number): boolean {
  const dx = lx - MUND_X;
  const dy = ly - MUND_Y;
  return (
    dx * dx * (MUND_HALB_Y * MUND_HALB_Y) + dy * dy * (MUND_HALB_X * MUND_HALB_X) <=
    MUND_HALB_X * MUND_HALB_X * (MUND_HALB_Y * MUND_HALB_Y)
  );
}

/** Wohin der Strahl bei dieser Lage fiele (für die Bots und die Zeichnung). */
export function strahlLandung(
  x: number,
  y: number,
  vx: number,
  vy: number,
  ueberGrad: number,
): { x: number; y: number } {
  return {
    x: x + vx * FALLZEIT_S,
    y: y + vy * FALLZEIT_S - (STRAHL_GRUNDWEITE + STRAHL_WEITE_PRO_GRAD * ueberGrad),
  };
}

/**
 * Rechnet bis einschließlich Schritt `bisTick` weiter.
 *
 * `eingaben` muss nach `t` sortiert sein und darf nur wachsen; ein Ereignis in
 * der Vergangenheit bereits gerechneter Schritte würde nicht mehr
 * berücksichtigt. Der Aufrufer legt neue Ereignisse deshalb nach
 * `tick * DT_MS` ab.
 *
 * `driftSeed` kommt aus der Runde (`driftSeedFuer`) und ist für alle gleich.
 */
export function simBis(
  start: SimZustand,
  eingaben: readonly Eingabe[],
  verzoegerungMs: number,
  bisTick: number,
  driftSeed = 0,
): SimZustand {
  const z = { ...start };
  const p = physikFuer(verzoegerungMs);
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
      // Lage: zwei Achsen mit Trägheit, Haltekurve, Gleiten und Abdrift.
      const d = driftBei(z.tick, driftSeed, p.drift);
      const rx = (z.rechts ? 1 : 0) - (z.links ? 1 : 0);
      const ry = (z.runter ? 1 : 0) - (z.hoch ? 1 : 0);
      const ax = achse(z.vx, z.halteX, z.richtungX, rx, p, d.ax);
      const ay = achse(z.vy, z.halteY, z.richtungY, ry, p, d.ay);
      z.vx = ax.v;
      z.vy = ay.v;
      z.halteX = ax.halte;
      z.halteY = ay.halte;
      z.richtungX = rx;
      z.richtungY = ry;
      z.x = Math.min(FELD_BREITE, Math.max(0, z.x + z.vx * DT));
      z.y = Math.min(FELD_TIEFE, Math.max(0, z.y + z.vy * DT));
      // An der Kante bleibt die Geschwindigkeit nicht aufgespart.
      if (z.x <= 0 || z.x >= FELD_BREITE) z.vx = 0;
      if (z.y <= 0 || z.y >= FELD_TIEFE) z.vy = 0;

      // Neigung: ebenfalls träge und mit Haltekurve; ohne Taste kippt es
      // zurück, aber erst, nachdem die Drehung ausgelaufen ist.
      z.halteNeigen = z.neigen ? z.halteNeigen + DT : 0;
      const winkelZiel = z.neigen
        ? NEIGUNG_V_MIN +
          (NEIGUNG_V_MAX - NEIGUNG_V_MIN) * haltekurve(z.halteNeigen, NEIGUNG_HALTE_VOLL_S, p.q)
        : -NEIGUNG_RUECK;
      const winkelBeschleunigung = z.neigen ? p.winkelBeschleunigung : p.rueckBeschleunigung;
      z.neigungV = naeher(z.neigungV, winkelZiel, winkelBeschleunigung * DT);
      z.neigung = Math.min(NEIGUNG_MAX, Math.max(0, z.neigung + z.neigungV * DT));
      if (z.neigung <= 0 || z.neigung >= NEIGUNG_MAX) z.neigungV = 0;

      if (z.fuellung > 0) {
        const ueber = z.neigung - kippSchwelle(z.fuellung);
        if (ueber > 0) {
          const menge = Math.min(z.fuellung, FLUSS_PRO_GRAD * ueber * DT);
          z.fuellung -= menge;
          z.fluss = menge / DT;
          const land = strahlLandung(z.x, z.y, z.vx, z.vy, ueber);
          z.landeX = land.x;
          z.landeY = land.y;
          z.trifft = imMund(land.x, land.y);
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
  driftSeed = 0,
): LaufErgebnis | null {
  return ergebnisVon(simBis(neuerZustand(), eingaben, verzoegerungMs, MAX_TICKS, driftSeed));
}
