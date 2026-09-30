import type { Maskenteil } from '../bild/doc.js';
import type { Tiefensitzung } from '../bild/tiefeNetz.js';
import { AbbruchError, EngineError, sitzungFreigeberSetzen } from '../stickers/engines/index.js';
import { filmMarke, type NeueDaten } from './bildweise.js';
import { MAX_BILDER_FILM, dauerText } from './einstellungen.js';
import { BytesLru } from './lru.js';
import {
  filmStandAn,
  kettenAuftrag,
  kettenBedarf,
  kettenPlan,
  kettenSchluessel,
  maskenZiele,
  type Anker,
  type Bezug,
  type Guete,
  type KettenBild,
  type Kettenbedarf,
  type KettenPlan,
  type LageAntwort,
  type Lauf,
  type Maske,
  type Richtung,
  type SpurQuelle,
  type SpurTeil,
  type TiefenBild,
} from './masken.js';
import {
  WIEDER_MS,
  fensterRechnen,
  inhaltFensterSuchen,
  kameraFensterSuchen,
  tiefeBereit,
  tiefenFensterSuchen,
  tiefenLaeufe,
  type Fenster,
  type FensterLeser,
  type FensterStart,
  type InhaltsFensterPlan,
  type TiefenLauf,
  type Tor,
  type Zaehler,
} from './maskenVerfolgen.js';
import type { Punkt } from './objektFolge.js';
import { bildMitte, fensterGroesse, filmRaster, grobAbstand, schluesselAbstand } from './raster.js';
import { rleDekodieren } from './rle.js';
import type { Abschnitt } from './schnitt.js';
import { Vorrat, type KettenEintrag, type Pass, type Tiefenkarte } from './spurVorrat.js';
import { teilRechnen } from './teilRechnen.js';
import { LAGE_RUHE, grauMass, maskeZiehen, type Lage } from './verfolgung.js';

/**
 * Die Verfolgung der Masken im Hintergrund – was wann gerechnet wird, und
 * was davon schon da ist.
 *
 * # API im Überblick (für die Anbindung in S4)
 *
 * Ausführlicher, mit Aufrufstellen: `masken-api.md` beim Lead.
 *
 * - `new Verfolger({ leser, s, mass })` – einer je (Datei, Kante, Bildrate);
 *   `leser` ist der `leserDienst` der Sitzung, `mass` die Rechengrösse.
 *   Ändert sich eines davon: `schliessen()` und neu anlegen (die Schlüssel
 *   der Ketten enthalten Raster und Grösse, es gilt ohnehin nichts mehr).
 *   Der Konstruktor hat KEINE Nebenwirkungen (StrictMode): Prüfhaken,
 *   Horcher und Schleife kommen mit dem ersten `setzen`.
 * - `setzen(masken, abschnitte, F?)` bei JEDER Änderung von Masken oder
 *   Abschnitten. Rechnet den Unterschied: Teilen, Kürzen, Umstellen,
 *   Löschen und eine reine Änderung der Regler kosten nichts; ein neuer
 *   Anker beginnt 600 ms nach seinem Auftauchen (drei schnelle Tipps sind
 *   ein Auftrag). `F` ohne Angabe: `filmRaster(…).menge`. Nach `schliessen`
 *   fängt ein `setzen` von vorn an.
 * - `SpurQuelle` (`kette`, `maske`, `lage`, `tiefe`) – für `bildDocAn`,
 *   `bahnZustand`, `zustandAn`. Synchron.
 * - `abonnieren(fn)` / `stand()` – für `useSyncExternalStore`. `stand()`
 *   ist dasselbe Objekt, bis sich etwas ändert (höchstens alle 250 ms):
 *   `{ version, jeMaske: Map<id, { anteil, grobAnteil, restMs, grobRestMs,
 *   laeuft, fehler? }> }`. `version` taugt als Anlass, Bahnen neu zu zeichnen.
 * - `vorziehen(k)` – Editor und Vorschau für das Bild, das sie brauchen.
 *   Die Kette, der dort etwas fehlt, kommt zuerst dran; ein laufendes
 *   Fenster endet dafür am nächsten Schlüsselbild – oder gleich, wenn es
 *   gerade am Tor wartet.
 * - `verfolgungRuhen(grund, an)` – `'zug'` (Finger auf Zeitleiste, Bühne,
 *   Griffen), `'wiedergabe'`, `'bauen'` (der Filmbau läuft – vom Start bis
 *   zum Ende, auch nach einem Abbruch wieder aus). `'verborgen'` meldet der
 *   Verfolger selbst. Es geht 300 ms nach dem letzten Grund weiter,
 *   frühestens 500 ms nach einem Zug (BiRefNet: 1 s).
 * - `spurenFertig(abbruch?, fortschritt?)` – für den Filmbau: erfüllt sich,
 *   wenn jede EINGESCHALTETE Maske an jedem ihrer Filmbilder endgültige
 *   Daten hat – nach denselben Regeln wie `bildDocAn(…, 'bild')`
 *   (`filmStandAn`); scheitert mit dem Fehler einer Kette („Die Maske ‚X'
 *   liess sich nicht verfolgen: …"). Ein Abbruch hält nur das Warten an,
 *   nicht die Verfolgung.
 * - `schliessen()` – beim Schliessen des Blatts und bei `alleVerwerfen`.
 *   Wartende `spurenFertig` scheitern mit `AbbruchError`.
 * - Prüfhaken: `window.__verfolger = { laeufe, lesen, fenster }` (Zähler
 *   dieses Verfolgers: Modelläufe ohne Netzvorrat-Treffer, Leseaufträge,
 *   Fenster) – gesetzt beim ersten `setzen`.
 * - Speicher: Über `SPUR_BUDGET` (nach dem Verdrängen von Ersetztem) hält
 *   jede Kette an, die noch wachsen würde; die Bahn sagt `SPEICHER_VOLL`,
 *   bis wieder Platz ist (siehe `speicherPruefen`).
 *
 * # Was als Nächstes dran ist
 *
 * Immer EIN Fenster zur Zeit, über alle Ketten. Die Reihenfolge:
 * 0. die Kette, der an `vorziehen(k)` noch jede Maske fehlt;
 * 1. was eine eingeschaltete Maske zum ersten Mal sichtbar macht – der
 *    Grobpass teurer Verfahren (ein Modellauf je Sekunde), das Einzige bei
 *    billigen (Person, Antippen nach Farbe), Kamera, grobe Tiefe;
 * 2. der Feinpass eingeschalteter Masken;
 * 3. und 4. dasselbe für abgeschaltete.
 *
 * Innerhalb einer Stufe zuerst, was dem Kopf am nächsten liegt, dann nach
 * der Reihenfolge der Masken, und die Richtungen im Wechsel. Dazu die
 * Verfahrenstreue: Dasselbe Verfahren rechnet weiter, solange ein anderes
 * nicht mehr als zwei Sekunden näher am Kopf wäre – sonst lüden BiRefNet,
 * Tiefe und SAM abwechselnd, und das hält ein Telefon nicht lange aus
 * (siehe `modellReihe`).
 *
 * # Warum eine Grenze je Stufe und nicht eine Liste je Maske
 *
 * Weil der Anwender die Maske ÜBERALL sehen will, wo sie gilt, und das zuerst:
 * Eine Motiv-Bahn über 24 s Film ist fein erst nach Minuten voll, grob nach
 * gut einer. Und weil ein Wischen im Editor an eine Stelle, an der noch
 * nichts ist, genau das sofort braucht – deshalb die Stufe 0.
 */

/** Ein neuer Anker wartet so lange – drei schnelle Tipps sind EIN Auftrag. */
export const ENTPRELL_MS = 600;
/** So lange nach dem letzten Grund geht es weiter. */
export const WEITER_MS = 300;
/** Nach einem Zug mindestens so lange Ruhe. */
export const ZUG_RUHE_MS = 500;
/** So oft höchstens meldet `stand()` Neues. */
export const MELDEN_MS = 250;
/** So lange bleibt der Bildschirm nach dem letzten Fenster wach. */
export const WACH_MS = 5000;
/** Verfahrenstreue: so viel näher muss ein anderes Verfahren sein, damit es übernimmt. */
export const TREUE_MS = 2000;
/** Was die Bahn sagt, wenn eine Kette wegen des Speichers anhält. */
export const SPEICHER_VOLL = 'Speicher voll – kürzer schneiden oder eine Maske löschen';

/**
 * Warum die Verfolgung ruht.
 *
 * - `'zug'`: ein Finger auf Zeitleiste, Bühne oder Griffen.
 * - `'wiedergabe'`: die Vorschau spielt.
 * - `'verborgen'`: die Seite ist nicht zu sehen – meldet der Verfolger selbst.
 * - `'bauen'`: der Filmbau läuft. Nach `spurenFertig` rechnet die Verfolgung
 *   sonst weiter an abgeschalteten Masken – mit einem eigenen Dekodierer
 *   neben dem des Filmbaus und Modelläufen, die mit dem Kodieren um die
 *   Grafikeinheit streiten. Ein `leser.schliessen()` allein half nicht: Der
 *   nächste Leseauftrag der Verfolgung öffnete den Leser sofort wieder.
 */
export type RuheGrund = 'zug' | 'wiedergabe' | 'verborgen' | 'bauen';

export interface MaskenFortschritt {
  /** Anteil der Filmbilder, an denen die Maske endgültig ist, 0 … 1. */
  readonly anteil: number;
  /** Anteil, an dem sie wenigstens grob da ist – so viel zeigt die Bahn schon. */
  readonly grobAnteil: number;
  /** Geschätzt bis endgültig. */
  readonly restMs: number;
  /** Geschätzt bis überall wenigstens grob. */
  readonly grobRestMs: number;
  /** Rechnet gerade ein Fenster dieser Maske? */
  readonly laeuft: boolean;
  /** Warum sie nicht weiterkommt – ein Satz für den Anwender. */
  readonly fehler?: string;
}

export interface VerfolgerStand {
  readonly version: number;
  readonly jeMaske: ReadonlyMap<string, MaskenFortschritt>;
}

/** Ein gerechnetes Fenster – für Prüfungen und Messungen (`VerfolgerOptionen.protokoll`). */
export interface Fensterprotokoll {
  readonly kette: string;
  readonly art: 'inhalt' | 'kamera' | 'tiefe';
  readonly richtung?: Richtung;
  readonly pass: Pass;
  readonly von: number;
  readonly bis: number;
  readonly masken: readonly string[];
}

export interface VerfolgerOptionen {
  /** Der Leser der Sitzung (`leserDienst`) – oder ein Ersatz. */
  readonly leser: FensterLeser;
  /** Die Schrittweite des Rasters, `1000 / bildrate`. */
  readonly s: number;
  /** Die Rechengrösse. */
  readonly mass: { readonly b: number; readonly h: number };
  /** Ersatz für die Freisteller – für Prüfungen. Sonst `teilRechnen` mit `vorrang: 'hinten'`. */
  readonly rechnen?: (
    teil: Maskenteil,
    bild: ImageData,
    punkte: readonly Punkt[] | null,
    abbruch?: AbortSignal,
  ) => Promise<Uint8Array>;
  /** Ersatz für die Tiefe – für Prüfungen. Sonst eine eigene Sitzung aus `bild/tiefeNetz.ts`. */
  readonly tiefeRechnen?: (bild: ImageData, abbruch?: AbortSignal) => Promise<NeueDaten>;
  readonly budget?: number;
  readonly entprellMs?: number;
  readonly weiterMs?: number;
  readonly meldenMs?: number;
  readonly protokoll?: (eintrag: Fensterprotokoll) => void;
}

/** Gemessene Kosten je Filmbild auf einem Telefon – der Anfang der Schätzung, siehe Spez. */
const MS_JE_BILD: Readonly<Record<string, number>> = {
  person: 100,
  face: 100,
  tipp: 135,
  tippen: 400,
  object: 575,
  birefnet: 575,
  tiefe: 785,
  kamera: 140,
};
const MS_JE_BILD_GROB: Readonly<Record<string, number>> = {
  tippen: 150,
  object: 140,
  birefnet: 140,
  tiefe: 250,
};

interface Kettenjob {
  readonly art: 'inhalt' | 'kamera';
  readonly schluessel: string;
  readonly anker: Anker;
  readonly plan: KettenPlan;
  readonly ohne: { readonly vor: ReadonlySet<number>; readonly rueck: ReadonlySet<number> };
  readonly verfahren: string;
  /** Mit Grobpass? */
  readonly grob: boolean;
  readonly aktiv: boolean;
  /** Die Stelle der ersten Maske, die sie braucht – für den Gleichstand. */
  readonly reihe: number;
  readonly masken: readonly string[];
  readonly wiederBilder?: number;
  readonly ruheMs: number;
}

interface Tiefenjob {
  readonly art: 'tiefe';
  readonly schluessel: 'tiefe';
  readonly verfahren: 'tiefe';
  readonly fein: readonly TiefenLauf[];
  readonly grob: readonly TiefenLauf[];
  readonly ziele: ReadonlySet<number>;
  /** An welchen Bildern eine Karte gebraucht wird – fein und grob. */
  readonly karten: ReadonlySet<number>;
  readonly aktiv: boolean;
  readonly reihe: number;
  readonly masken: readonly string[];
}

type Job = Kettenjob | Tiefenjob;

interface Kandidat {
  readonly job: Job;
  readonly richtung?: Richtung;
  readonly lauf: number;
  readonly pass: Pass;
  readonly stufe: number;
  /** Wo das Fenster beginnt – für den Abstand zum Kopf. */
  readonly start: number;
  readonly inhalt?: InhaltsFensterPlan;
  readonly pfad?: readonly number[];
  readonly schluessel?: ReadonlySet<number>;
}

type Gefunden =
  | 'verloren'
  | { readonly eintrag: Extract<KettenEintrag, { rle: Uint8Array }>; readonly stand: Guete };

/** Das Tor: zu, solange ein Grund besteht, und noch ein wenig länger. */
class Ruhetor implements Tor {
  private readonly gruende = new Set<RuheGrund>();
  private frei = 0;
  private zugEnde = 0;
  private readonly wartende = new Set<() => void>();

  constructor(private readonly weiterMs: number) {}

  get zu(): boolean {
    return this.gruende.size > 0;
  }

  setzen(grund: RuheGrund, an: boolean): void {
    if (an) this.gruende.add(grund);
    else if (this.gruende.delete(grund)) {
      const jetzt = Date.now();
      if (this.gruende.size === 0) this.frei = jetzt + this.weiterMs;
      if (grund === 'zug') this.zugEnde = jetzt;
    }
    this.wecken();
  }

  /**
   * Wie lange insgesamt am Tor gewartet wurde, in ms – damit die Schätzung
   * der Restzeit nur lernt, was gerechnet wurde, nicht wie lange der
   * Anwender gewischt hat (siehe `ausfuehren`).
   */
  gewartet = 0;

  async offen(ruheNachZugMs = 0): Promise<void> {
    const beginn = Date.now();
    try {
      for (;;) {
        if (this.gruende.size > 0) {
          await this.schlafen(null);
          continue;
        }
        const jetzt = Date.now();
        const warten = Math.max(
          this.frei - jetzt,
          this.zugEnde + Math.max(ZUG_RUHE_MS, ruheNachZugMs) - jetzt,
        );
        if (warten <= 0) return;
        await this.schlafen(warten);
      }
    } finally {
      this.gewartet += Date.now() - beginn;
    }
  }

  wecken(): void {
    for (const weiter of [...this.wartende]) weiter();
  }

  private schlafen(ms: number | null): Promise<void> {
    return new Promise((weiter) => {
      let zeitgeber: ReturnType<typeof setTimeout> | null = null;
      const fertig = () => {
        this.wartende.delete(fertig);
        if (zeitgeber) clearTimeout(zeitgeber);
        weiter();
      };
      this.wartende.add(fertig);
      if (ms !== null) zeitgeber = setTimeout(fertig, ms);
    });
  }
}

/** Das erste Netz- oder Tippteil – eine Maske damit hat Formen, die ihm folgen. */
function hatInhalt(maske: Maske): boolean {
  return maske.teile.some((teil) => {
    const art = teil.anker[0].teil.art;
    return art === 'netz' || art === 'tipp';
  });
}

/** Der Anker, der an k am nächsten liegt – bei Gleichstand der frühere (wie in `masken.ts`). */
function naechsterAnker(anker: readonly Anker[], k: number): Anker {
  let bester = anker[0];
  for (const a of anker) if (Math.abs(a.k - k) < Math.abs(bester.k - k)) bester = a;
  return bester;
}

function verfahrenVon(teil: Maskenteil): string {
  if (teil.art === 'netz') return teil.netz;
  if (teil.art === 'tipp') return teil.mitNetz ? 'tippen' : 'tipp';
  if (teil.art === 'tiefe') return 'tiefe';
  return 'kamera';
}

/** Teure Verfahren bekommen einen Grobpass – billige sind fein schon schnell genug. */
function mitGrobpass(teil: Maskenteil): boolean {
  if (teil.art === 'netz') return teil.netz === 'object' || teil.netz === 'birefnet';
  return teil.art === 'tipp' && teil.mitNetz;
}

/** Wie weit etwas an einem Bild ist – für Fortschritt und `spurenFertig`. */
type Fertig = 'fein' | 'grob' | 'offen';

const OFFEN_BILD: KettenBild = { stand: 'offen' };
const VERLOREN_BILD: KettenBild = { stand: 'verloren' };

export class Verfolger implements SpurQuelle {
  readonly zaehler: Zaehler = { laeufe: 0, lesen: 0, fenster: 0 };
  private readonly s: number;
  private readonly b: number;
  private readonly h: number;
  private readonly K: number;
  private readonly kGrob: number;
  private readonly fensterBilder: number;
  private readonly vorrat: Vorrat;
  private readonly tor: Ruhetor;
  private readonly entprellMs: number;
  private readonly meldenMs: number;

  private masken: readonly Maske[] = [];
  private bezug: Bezug = { abschnitte: [], s: 1 };
  private film: readonly number[] = [];
  private jobs = new Map<string, Job>();
  private teile = new Map<string, SpurTeil>();
  private readonly vorgaenger = new Map<string, Anker>();
  private readonly ankerSeit = new Map<string, number>();
  /** Ketten, die wegen des Speichers anhalten – siehe `speicherPruefen`. */
  private angehalten = new Set<string>();
  private tiefeAngehalten = false;
  /** Warum die Tiefe nicht weiterkommt – bis ein neuer Tiefenanker kommt (siehe `setzen`). */
  private tiefeFehler: string | null = null;
  /** Die Kennungen aller Tiefenanker beim letzten `setzen`. */
  private tiefenAnker = new Set<string>();
  private kopf: number | null = null;
  private letztesVerfahren: string | null = null;
  private letzteRichtung: Richtung | null = null;
  private readonly kosten = new Map<string, number>();
  /** Fenster in Folge, die nichts ablegten – je Kette. Siehe `ausfuehren`. */
  private readonly stillstand = new Map<string, number>();
  private laufend: {
    readonly wahl: Kandidat;
    readonly steuer: AbortController;
    unterbrechen: boolean;
  } | null = null;
  private geschlossen = false;
  /** Läuft die Schleife? Erst ab dem ersten `setzen` – siehe `anlaufen`. */
  private laeuft = false;
  /** Zählt jedes Anlaufen: Eine Schleife von vor einem `schliessen` hört damit auf. */
  private generation = 0;
  private weckRufe = new Set<() => void>();

  private standWert: VerfolgerStand = { version: 0, jeMaske: new Map() };
  private readonly hoerer = new Set<() => void>();
  private meldung: ReturnType<typeof setTimeout> | null = null;
  private letzteMeldung = 0;
  private readonly wartendeFertig = new Set<(fehler: unknown) => void>();

  private readonly ausgepackt: BytesLru<number, Uint8Array>;
  private readonly gezogen = new BytesLru<string, NeueDaten>(4 * 1024 * 1024);
  private readonly tiefenMarken = new Map<string, number>();
  private tiefensitzung: Promise<Tiefensitzung> | null = null;
  private wachSperre: { release(): Promise<void> } | null = null;
  private wachAnfrage = false;
  private wachZeitgeber: ReturnType<typeof setTimeout> | null = null;
  private sichtbarkeit: (() => void) | null = null;

  constructor(private readonly optionen: VerfolgerOptionen) {
    this.s = optionen.s;
    this.b = optionen.mass.b;
    this.h = optionen.mass.h;
    this.K = schluesselAbstand(this.s);
    this.kGrob = grobAbstand(this.K, this.s);
    this.fensterBilder = fensterGroesse(this.b, this.h, this.K);
    const grau = grauMass(this.b, this.h);
    this.vorrat = new Vorrat(optionen.budget, grau.b * grau.h);
    this.tor = new Ruhetor(optionen.weiterMs ?? WEITER_MS);
    this.entprellMs = optionen.entprellMs ?? ENTPRELL_MS;
    this.meldenMs = optionen.meldenMs ?? MELDEN_MS;
    this.ausgepackt = new BytesLru(4 * this.b * this.h);
  }

  /**
   * Die Nebenwirkungen: Prüfhaken, Horcher auf die Sichtbarkeit, die
   * Schleife. Erst beim ersten `setzen` – nicht im Konstruktor.
   *
   * # Warum nicht im Konstruktor
   *
   * Weil React im StrictMode (in der Entwicklung und damit in jeder
   * e2e-Prüfung) die Fabrik eines `useMemo` zweimal ruft und die ERSTE
   * Instanz behält. Mit Nebenwirkungen im Konstruktor zeigte
   * `window.__verfolger` auf die Zähler der verworfenen zweiten – die immer
   * bei 0 bleiben, und eine Prüfung „nichts neu gelesen" bestünde ohne
   * Aussage –, und deren Horcher lebte weiter. Ein Verfolger, dem nie etwas
   * gesetzt wird, tut hier gar nichts.
   *
   * Nach `schliessen` läuft er mit dem nächsten `setzen` wieder an, von
   * vorn: StrictMode führt Aufräumen und Effekt ein zweites Mal aus, und ein
   * endgültiges Schliessen hinterliesse einen toten Verfolger.
   */
  private anlaufen(): void {
    if (this.laeuft) return;
    this.laeuft = true;
    this.geschlossen = false;
    this.generation += 1;
    if (typeof window !== 'undefined') {
      (window as unknown as { __verfolger?: Zaehler }).__verfolger = this.zaehler;
    }
    if (typeof document !== 'undefined') {
      this.sichtbarkeit = () => this.tor.setzen('verborgen', document.hidden);
      document.addEventListener('visibilitychange', this.sichtbarkeit);
      this.sichtbarkeit();
    }
    void this.schleife(this.generation);
  }

  /* ---------- Masken und Abschnitte ---------- */

  setzen(masken: readonly Maske[], abschnitte: readonly Abschnitt[], F?: readonly number[]): void {
    this.anlaufen();
    const { s, b, h, K } = this;
    this.masken = masken;
    this.bezug = { abschnitte, s };
    this.film = F ?? filmRaster(abschnitte, s, MAX_BILDER_FILM).menge;
    const jetzt = Date.now();

    /*
     * Vorgänger merken: Ein Anker, der einen anderen im selben Teil ersetzt,
     * erbt dessen Kette als „veraltet" – die Vorschau zeigt sie, bis die neue
     * da ist, statt die Maske ganz wegzulassen.
     */
    for (const maske of masken) {
      for (const teil of maske.teile) {
        const alt = this.teile.get(teil.id);
        for (const anker of teil.anker) {
          if (!this.ankerSeit.has(anker.id)) this.ankerSeit.set(anker.id, jetzt);
          if (!alt || this.vorgaenger.has(anker.id) || alt.anker.some((a) => a.id === anker.id)) {
            continue;
          }
          /*
           * Ein Vorgänger, der nie gerechnet wurde (er wurde ersetzt, bevor
           * seine Entprellung um war), taugt nicht als „veraltet" – dann
           * gleich dessen Vorgänger. So bleibt die Reihe kurz.
           */
          let vor: Anker | undefined = naechsterAnker(alt.anker, anker.k);
          const besucht = new Set<string>();
          while (vor && !besucht.has(vor.id) && !this.hatDaten(vor)) {
            besucht.add(vor.id);
            vor = this.vorgaenger.get(vor.id);
          }
          if (vor) this.vorgaenger.set(anker.id, vor);
        }
      }
    }
    this.teile = new Map(masken.flatMap((maske) => maske.teile.map((teil) => [teil.id, teil])));

    // Je Kette EIN Auftrag – zwei Masken mit denselben Ankern („Hier trennen") teilen ihn.
    const gruppen = new Map<
      string,
      {
        bedarf: Kettenbedarf;
        ziele: Set<number>;
        lo: number;
        hi: number;
        masken: string[];
        aktiv: boolean;
        reihe: number;
      }
    >();
    const tiefeZiele = new Set<number>();
    const tiefenAnker = new Set<string>();
    const tiefeMasken: string[] = [];
    let tiefeAktiv = false;
    let tiefeReihe = Infinity;
    masken.forEach((maske, reihe) => {
      for (const bedarf of kettenBedarf(maske, this.film, this.bezug)) {
        const schluessel = kettenSchluessel(bedarf.grenze.anker, s, b, h, K);
        const da = gruppen.get(schluessel);
        if (da) {
          for (const k of bedarf.ziele) da.ziele.add(k);
          da.lo = Math.min(da.lo, bedarf.grenze.lo);
          da.hi = Math.max(da.hi, bedarf.grenze.hi);
          if (!da.masken.includes(maske.id)) da.masken.push(maske.id);
          da.aktiv ||= maske.aktiv;
        } else {
          gruppen.set(schluessel, {
            bedarf,
            ziele: new Set(bedarf.ziele),
            lo: bedarf.grenze.lo,
            hi: bedarf.grenze.hi,
            masken: [maske.id],
            aktiv: maske.aktiv,
            reihe,
          });
        }
      }
      if (maske.teile.some((teil) => teil.anker[0].teil.art === 'tiefe')) {
        for (const k of maskenZiele(maske, this.film, this.bezug)) tiefeZiele.add(k);
        tiefeMasken.push(maske.id);
        tiefeAktiv ||= maske.aktiv;
        tiefeReihe = Math.min(tiefeReihe, reihe);
        for (const teil of maske.teile) {
          if (teil.anker[0].teil.art === 'tiefe') for (const a of teil.anker) tiefenAnker.add(a.id);
        }
      }
    });
    /*
     * Ein Fehler der Tiefe gilt, bis ein NEUER Tiefenanker kommt – wie bei
     * den Inhaltsketten, deren Fehler am Anker hängt. Die Tiefe hat nur
     * einen gemeinsamen Auftrag; ohne das sperrte ein einziger Aussetzer
     * (ein Netzfehler beim Laden des Modells, die Tiefe erst in den
     * Einstellungen eingeschaltet) jede Tiefe bis zum Schliessen des Blatts,
     * auch für eine neu angelegte Maske.
     */
    if ([...tiefenAnker].some((id) => !this.tiefenAnker.has(id))) this.tiefeFehler = null;
    this.tiefenAnker = tiefenAnker;

    const jobs = new Map<string, Job>();
    for (const [schluessel, gruppe] of gruppen) {
      const teil = gruppe.bedarf.grenze.anker.teil;
      const bedarf: Kettenbedarf = {
        ...gruppe.bedarf,
        grenze: { anker: gruppe.bedarf.grenze.anker, lo: gruppe.lo, hi: gruppe.hi },
        ziele: [...gruppe.ziele].sort((x, y) => x - y),
      };
      const grob = bedarf.art === 'inhalt' && mitGrobpass(teil);
      const plan = kettenPlan(
        kettenAuftrag(bedarf, {
          K,
          fenster: this.fensterBilder,
          film: this.film,
          ...(grob ? { kGrob: this.kGrob } : {}),
        }),
      );
      const verfahren = verfahrenVon(teil);
      jobs.set(schluessel, {
        art: bedarf.art,
        schluessel,
        anker: bedarf.grenze.anker,
        plan,
        ohne: { vor: new Set(plan.vor.ohne), rueck: new Set(plan.rueck.ohne) },
        verfahren,
        grob,
        aktiv: gruppe.aktiv,
        reihe: gruppe.reihe,
        masken: gruppe.masken,
        ...(verfahren === 'object' || verfahren === 'birefnet'
          ? { wiederBilder: Math.round(WIEDER_MS / s) }
          : {}),
        ruheMs:
          verfahren === 'birefnet'
            ? 1000
            : verfahren === 'person' || verfahren === 'face'
              ? 500
              : 0,
      });
    }
    if (tiefeZiele.size > 0) {
      const ziele = [...tiefeZiele].sort((x, y) => x - y);
      const karten = new Set<number>();
      for (const k of ziele) {
        karten.add(K * Math.floor(k / K));
        karten.add(this.kGrob * Math.floor(k / this.kGrob));
      }
      jobs.set('tiefe', {
        art: 'tiefe',
        schluessel: 'tiefe',
        verfahren: 'tiefe',
        fein: tiefenLaeufe(ziele, K),
        grob: tiefenLaeufe(ziele, this.kGrob),
        ziele: tiefeZiele,
        karten,
        aktiv: tiefeAktiv,
        reihe: tiefeReihe,
        masken: tiefeMasken,
      });
    }
    this.jobs = jobs;
    this.vorrat.aktuellSetzen([...jobs.keys()].filter((schluessel) => schluessel !== 'tiefe'));

    /*
     * Wer wegen des Speichers anhält, bleibt angehalten, bis der Vorrat
     * wieder unter das Budget kommt – `speicherPruefen` fragt den Speicher,
     * nicht, ob `setzen` kam. Pauschal freigeben hiesse: jeder Reglerschritt
     * ein Fenster mehr über dem Budget. Gleich hier geprüft, weil eine
     * gelöschte Maske Platz schafft und ein wartendes `spurenFertig` das
     * sofort sehen soll.
     */
    this.speicherPruefen();

    // Ein laufendes Fenster, dessen Kette niemand mehr braucht, wird verworfen.
    if (this.laufend && !jobs.has(this.laufend.wahl.job.schluessel)) this.laufend.steuer.abort();
    this.melden();
    this.wecken();
  }

  /* ---------- Steuerung ---------- */

  vorziehen(k: number): void {
    if (this.geschlossen || this.kopf === k) return;
    this.kopf = k;
    const laufend = this.laufend;
    if (laufend) {
      const beste = this.waehlen();
      if (beste && !gleicherKandidat(beste, laufend.wahl)) laufend.unterbrechen = true;
    }
    this.wecken();
  }

  verfolgungRuhen(grund: RuheGrund, an: boolean): void {
    this.tor.setzen(grund, an);
  }

  abonnieren = (fn: () => void): (() => void) => {
    this.hoerer.add(fn);
    return () => {
      this.hoerer.delete(fn);
    };
  };

  stand = (): VerfolgerStand => this.standWert;

  spurenFertig(
    abbruch?: AbortSignal,
    fortschritt?: (anteil: number, text: string) => void,
  ): Promise<void> {
    return new Promise<void>((erfuellen, ablehnen) => {
      let beendet = false;
      const ende = (fehler?: unknown) => {
        if (beendet) return;
        beendet = true;
        abmelden();
        abbruch?.removeEventListener('abort', pruefen);
        this.wartendeFertig.delete(ende);
        if (fehler === undefined) erfuellen();
        else ablehnen(fehler);
      };
      const pruefen = () => {
        if (beendet) return;
        if (abbruch?.aborted || this.geschlossen) {
          ende(new AbbruchError());
          return;
        }
        const aktive = this.masken.filter((maske) => maske.aktiv);
        let fertig = 0;
        let gesamt = 0;
        let rest = 0;
        for (const maske of aktive) {
          const fehler = this.maskenFehler(maske);
          if (fehler) {
            ende(new Error(`Die Maske ‚${maske.name}' liess sich nicht verfolgen: ${fehler}`));
            return;
          }
          const zahl = this.maskenZahlen(maske);
          fertig += zahl.fein;
          gesamt += zahl.ziele;
          rest += zahl.restMs;
        }
        if (fertig >= gesamt) {
          ende();
          return;
        }
        fortschritt?.(
          gesamt > 0 ? fertig / gesamt : 1,
          `Masken zu Ende verfolgen – noch ${dauerText(rest)}`,
        );
      };
      const abmelden = this.abonnieren(pruefen);
      abbruch?.addEventListener('abort', pruefen, { once: true });
      this.wartendeFertig.add(ende);
      pruefen();
    });
  }

  /**
   * Alles anhalten und freigeben: das laufende Fenster, Wartende von
   * `spurenFertig` (mit `AbbruchError`), die Bildschirmsperre, die
   * Tiefensitzung, der Vorrat. Ein späteres `setzen` fängt von vorn an
   * (siehe `anlaufen`).
   */
  schliessen(): void {
    this.geschlossen = true;
    for (const ende of [...this.wartendeFertig]) ende(new AbbruchError());
    if (!this.laeuft) return;
    this.laeuft = false;
    this.laufend?.steuer.abort();
    this.laufend = null;
    if (this.meldung) clearTimeout(this.meldung);
    this.meldung = null;
    if (this.wachZeitgeber) clearTimeout(this.wachZeitgeber);
    this.wachZeitgeber = null;
    void this.wachSperre?.release().catch(() => undefined);
    this.wachSperre = null;
    if (this.sichtbarkeit && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.sichtbarkeit);
    }
    this.sichtbarkeit = null;
    this.angehalten = new Set();
    this.tiefeAngehalten = false;
    this.tiefeFehler = null;
    this.stillstand.clear();
    const sitzung = this.tiefensitzung;
    this.tiefensitzung = null;
    if (sitzung) {
      sitzungFreigeberSetzen('tiefe', null);
      void sitzung.then((offen) => offen.schliessen()).catch(() => undefined);
    }
    this.vorrat.leeren();
    this.wecken();
  }

  /* ---------- SpurQuelle ---------- */

  kette(anker: Anker, richtung: Richtung, k: number): KettenBild {
    const gefunden = this.aufloesen(anker, richtung, k, true);
    if (!gefunden) return OFFEN_BILD;
    if (gefunden === 'verloren') return VERLOREN_BILD;
    const { eintrag, stand } = gefunden;
    return {
      stand,
      meta: eintrag.meta,
      marke: eintrag.marke,
      ...(eintrag.punkte ? { punkte: eintrag.punkte } : {}),
    };
  }

  maske(anker: Anker, richtung: Richtung, k: number): Uint8Array | null {
    const gefunden = this.aufloesen(anker, richtung, k, true);
    if (!gefunden || gefunden === 'verloren') return null;
    const { eintrag } = gefunden;
    let maske = this.ausgepackt.holen(eintrag.marke);
    if (!maske) {
      maske = rleDekodieren(eintrag.rle, this.b * this.h);
      this.ausgepackt.ablegen(eintrag.marke, maske, maske.byteLength);
    }
    return maske;
  }

  lage(a: number, k: number): LageAntwort {
    const kamera = this.vorrat.kamera;
    if (a === k) return { stand: 'fein', lage: LAGE_RUHE, faktor: kamera.faktor };
    const lage = kamera.lage(a, k);
    if (lage) return { stand: 'fein', lage, faktor: kamera.faktor };
    for (const job of this.jobs.values()) {
      if (job.art !== 'kamera' || job.anker.k !== a) continue;
      if (job.ohne.vor.has(k) || job.ohne.rueck.has(k)) return { stand: 'vorlaeufig' };
    }
    return { stand: 'offen' };
  }

  /**
   * Die Tiefe an k – `daten` erst, wenn jemand sie liest.
   *
   * # Warum erst dann
   *
   * Weil die Bahn für JEDES Filmbild fragt, bei jedem Neuzeichnen, und nur
   * den Stand braucht (Tiefe ist immer sichtbar). Die Karte zwischen zwei
   * Schlüsselbildern mit der Kamera zu ziehen kostet je Bild rund eine
   * Millisekunde; über 600 Bilder war das je Bahn eine halbe Sekunde auf dem
   * Rechner, auf einem Telefon zwei. Der Stand und die Marke kosten nichts.
   */
  tiefe(k: number): TiefenBild {
    for (const [stand, abstand] of [
      ['fein', this.K],
      ['grob', this.kGrob],
    ] as const) {
      const quelle = this.tiefeFinden(k, abstand);
      if (!quelle) continue;
      const bauen = () => this.tiefeZiehen(k, quelle);
      return {
        stand,
        marke: quelle.marke,
        get daten() {
          return bauen();
        },
      };
    }
    return { stand: 'offen' };
  }

  /* ---------- Innen: was gespeichert ist ---------- */

  private aufloesen(
    anker: Anker,
    richtung: Richtung,
    k: number,
    mitVorgaenger: boolean,
  ): Gefunden | null {
    const schluessel = kettenSchluessel(anker, this.s, this.b, this.h, this.K);
    /*
     * Erst was gerechnet ist, dann der Plan: Eine Kette, deren Geltung
     * schrumpfte, hat ihre Bilder weiter – auch dort, wo der neue Plan einen
     * Schnitt sähe. Gerechnetes wird nie nachträglich „verloren".
     */
    const eintrag = this.vorrat.holen(schluessel)?.bild(k);
    if (eintrag) return eintrag.verloren ? 'verloren' : { eintrag, stand: eintrag.guete };
    const job = this.jobs.get(schluessel);
    if (job && job.art !== 'tiefe' && job.ohne[richtung].has(k)) return 'verloren';
    if (!mitVorgaenger) return null;
    /*
     * Veraltet: die Kette eines Ankers, den dieser ersetzt hat – nur für
     * Vorschau und Bahn (`masken.ts` entscheidet, wer es nimmt). So weit
     * zurück, bis eine etwas hat: Wer einen Tipp mit fünf Plus- und
     * Minus-Tipps nachbessert, erzeugt fünf Anker, von denen die mittleren
     * wegen der Entprellung nie gerechnet werden – und die gerechnete Kette
     * des ersten ist das Beste, was die Vorschau hat. `besucht` gegen Kreise.
     */
    const besucht = new Set<string>([anker.id]);
    let vor = this.vorgaenger.get(anker.id);
    while (vor && !besucht.has(vor.id)) {
      besucht.add(vor.id);
      const alt = this.vorrat.holen(kettenSchluessel(vor, this.s, this.b, this.h, this.K))?.bild(k);
      if (alt && !alt.verloren) return { eintrag: alt, stand: 'veraltet' };
      vor = this.vorgaenger.get(vor.id);
    }
    return null;
  }

  /**
   * Wo die Tiefe an k herkommt: die Karte am Schlüsselbild davor und die
   * Kamera von dort bis k – ohne etwas zu ziehen. `marke` ist je (Karte, k)
   * dieselbe, auch wenn die gezogene Karte inzwischen verdrängt wurde: Der
   * Renderer erkennt eine Karte an ihr.
   */
  private tiefeFinden(
    k: number,
    abstand: number,
  ): { basis: number; karte: Tiefenkarte; lage: Lage | null; marke: number } | null {
    const basis = abstand * Math.floor(k / abstand);
    const karte = this.vorrat.tiefe.holen(basis);
    if (!karte) return null;
    if (basis === k) return { basis, karte, lage: null, marke: karte.marke };
    const lage = this.vorrat.kamera.lage(basis, k);
    if (!lage) return null;
    const schluessel = `${k}|${karte.marke}`;
    let marke = this.tiefenMarken.get(schluessel);
    if (marke === undefined) {
      marke = filmMarke();
      // Klein halten: Jede neue Karte bringt neue Schlüssel, alte braucht niemand.
      if (this.tiefenMarken.size > 8192) this.tiefenMarken.clear();
      this.tiefenMarken.set(schluessel, marke);
    }
    return { basis, karte, lage, marke };
  }

  private tiefeZiehen(
    k: number,
    quelle: { karte: Tiefenkarte; lage: Lage | null; marke: number },
  ): NeueDaten {
    if (!quelle.lage) return quelle.karte.daten;
    const schluessel = `${k}|${quelle.karte.marke}`;
    const da = this.gezogen.holen(schluessel);
    if (da) return da;
    const { breite, hoehe, werte } = quelle.karte.daten;
    // Die Karte liegt in Graugrösse, die Lage rechnet in Graupunkten: Faktor 1.
    const neu = { breite, hoehe, werte: maskeZiehen(werte, breite, hoehe, quelle.lage, 1) };
    this.gezogen.ablegen(schluessel, neu, werte.byteLength);
    return neu;
  }

  /** Wie weit eine Kette fein ist, 0 … 1 – unter 1 wächst sie noch (siehe `speicherPruefen`). */
  private fertigAnteil(schluessel: string): number {
    const job = this.jobs.get(schluessel);
    if (!job || job.art !== 'inhalt') return 1;
    const kette = this.vorrat.vorhanden(schluessel);
    let ziele = 0;
    let da = 0;
    for (const richtung of ['vor', 'rueck'] as const) {
      for (const lauf of job.plan[richtung].laeufe) {
        for (const k of lauf.ziele) {
          ziele += 1;
          // Erst fein ist fertig – eine Kette mit groben Bildern wächst im Feinpass noch.
          if (kette?.bild(k)?.guete === 'fein') da += 1;
        }
      }
    }
    return ziele === 0 ? 1 : da / ziele;
  }

  /** Hat die Kette dieses Ankers irgendetwas gerechnet? */
  private hatDaten(anker: Anker): boolean {
    const kette = this.vorrat.vorhanden(kettenSchluessel(anker, this.s, this.b, this.h, this.K));
    return (kette?.anzahl ?? 0) > 0;
  }

  private kettenFehler(job: Job): string | null {
    if (job.art === 'tiefe')
      return this.tiefeFehler ?? (this.tiefeAngehalten ? SPEICHER_VOLL : null);
    return this.vorrat.holen(job.schluessel)?.fehler ?? null;
  }

  private maskenFehler(maske: Maske): string | null {
    for (const job of this.jobs.values()) {
      if (!job.masken.includes(maske.id)) continue;
      const fehler = this.kettenFehler(job);
      if (fehler) return fehler;
    }
    return null;
  }

  /* ---------- Innen: wie fertig eine Maske ist ---------- */

  /**
   * Wie weit eine Maske an k ist – nach DENSELBEN Regeln wie
   * `bildDocAn(…, 'bild')`, aus derselben Funktion (`filmStandAn`). Eine
   * eigene Nachbildung hier liess Formen in Masken mit Inhalt aus: Der
   * Fortschritt meldete „fertig", und danach warf der Filmbau.
   */
  private maskeStand(maske: Maske, k: number): Fertig {
    return filmStandAn(maske, k, this, { ...this.bezug, b: this.b, h: this.h });
  }

  private kostenJeBild(maske: Maske): { fein: number; grob: number } {
    let fein = 0;
    let grob = 0;
    const mitInhalt = hatInhalt(maske);
    for (const teil of maske.teile) {
      const basis = teil.anker[0].teil;
      if (!mitInhalt && basis.art !== 'tiefe' && basis.art !== 'netz' && basis.art !== 'tipp') {
        fein += this.kostenVon('kamera', 'fein');
        grob += this.kostenVon('kamera', 'fein');
        continue;
      }
      if (basis.art !== 'netz' && basis.art !== 'tipp' && basis.art !== 'tiefe') continue;
      const verfahren = verfahrenVon(basis);
      const mitGrob = basis.art === 'tiefe' || mitGrobpass(basis);
      fein += this.kostenVon(verfahren, 'fein');
      grob += mitGrob ? this.kostenVon(verfahren, 'grob') : this.kostenVon(verfahren, 'fein');
    }
    return { fein, grob };
  }

  private kostenVon(verfahren: string, pass: Pass): number {
    return (
      this.kosten.get(`${verfahren}|${pass}`) ??
      (pass === 'grob' ? MS_JE_BILD_GROB[verfahren] : undefined) ??
      MS_JE_BILD[verfahren] ??
      300
    );
  }

  private maskenZahlen(maske: Maske): {
    ziele: number;
    fein: number;
    grob: number;
    restMs: number;
    grobRestMs: number;
  } {
    const ziele = maskenZiele(maske, this.film, this.bezug);
    let fein = 0;
    let grob = 0;
    for (const k of ziele) {
      const stand = this.maskeStand(maske, k);
      if (stand === 'fein') {
        fein += 1;
        grob += 1;
      } else if (stand === 'grob') grob += 1;
    }
    const kosten = this.kostenJeBild(maske);
    return {
      ziele: ziele.length,
      fein,
      grob,
      restMs: (ziele.length - fein) * kosten.fein,
      grobRestMs: (ziele.length - grob) * kosten.grob,
    };
  }

  private standRechnen(): VerfolgerStand {
    const jeMaske = new Map<string, MaskenFortschritt>();
    const laufend = this.laufend?.wahl.job.masken ?? [];
    for (const maske of this.masken) {
      const zahl = this.maskenZahlen(maske);
      const fehler = this.maskenFehler(maske);
      jeMaske.set(maske.id, {
        anteil: zahl.ziele > 0 ? zahl.fein / zahl.ziele : 1,
        grobAnteil: zahl.ziele > 0 ? zahl.grob / zahl.ziele : 1,
        restMs: zahl.restMs,
        grobRestMs: zahl.grobRestMs,
        laeuft: laufend.includes(maske.id),
        ...(fehler ? { fehler } : {}),
      });
    }
    return { version: this.standWert.version + 1, jeMaske };
  }

  /** Neuen Stand melden – höchstens alle `meldenMs`. */
  private melden(): void {
    if (this.meldung || this.geschlossen) return;
    const warten = Math.max(0, this.letzteMeldung + this.meldenMs - Date.now());
    this.meldung = setTimeout(() => {
      this.meldung = null;
      if (this.geschlossen) return;
      this.letzteMeldung = Date.now();
      this.standWert = this.standRechnen();
      for (const fn of [...this.hoerer]) fn();
    }, warten);
  }

  /* ---------- Innen: was als Nächstes dran ist ---------- */

  private entprellt(job: Job, jetzt: number): boolean {
    if (job.art === 'tiefe') return true;
    return jetzt - (this.ankerSeit.get(job.anker.id) ?? 0) >= this.entprellMs;
  }

  /** Wann der nächste noch wartende Anker drankommt – `null`, wenn keiner wartet. */
  private naechsteFreigabe(jetzt: number): number | null {
    let frueheste: number | null = null;
    for (const job of this.jobs.values()) {
      if (job.art === 'tiefe' || this.entprellt(job, jetzt)) continue;
      const ab = (this.ankerSeit.get(job.anker.id) ?? jetzt) + this.entprellMs;
      if (frueheste === null || ab < frueheste) frueheste = ab;
    }
    return frueheste;
  }

  private kandidaten(): Kandidat[] {
    const raus: Kandidat[] = [];
    const jetzt = Date.now();
    const kopf = this.kopf;
    for (const job of this.jobs.values()) {
      if (this.angehalten.has(job.schluessel) || this.kettenFehler(job)) continue;
      if (!this.entprellt(job, jetzt)) continue;
      const stufeFuer = (pass: Pass, fehltAmKopf: boolean): number => {
        if (fehltAmKopf) return 0;
        const sichtbar = pass === 'grob' || job.art === 'kamera' || !job.grob;
        return (sichtbar ? 1 : 2) + (job.aktiv ? 0 : 2);
      };
      if (job.art === 'inhalt') {
        const kette = this.vorrat.kette(job.schluessel, job.anker.k);
        for (const richtung of ['vor', 'rueck'] as const) {
          job.plan[richtung].laeufe.forEach((lauf, nummer) => {
            for (const pass of job.grob ? (['grob', 'fein'] as const) : (['fein'] as const)) {
              const plan = inhaltFensterSuchen(lauf, pass, richtung, kette, this.fensterBilder);
              if (!plan) continue;
              const fehltAmKopf = kopf !== null && lauf.ziele.includes(kopf) && !kette.bild(kopf);
              raus.push({
                job,
                richtung,
                lauf: nummer,
                pass,
                stufe: stufeFuer(pass, fehltAmKopf),
                start: plan.pfad[0],
                inhalt: plan,
              });
              break;
            }
          });
        }
      } else if (job.art === 'kamera') {
        for (const richtung of ['vor', 'rueck'] as const) {
          job.plan[richtung].laeufe.forEach((lauf, nummer) => {
            const pfad = kameraFensterSuchen(lauf, this.vorrat.kamera, this.fensterBilder);
            if (!pfad) return;
            const fehltAmKopf =
              kopf !== null &&
              lauf.ziele.includes(kopf) &&
              this.vorrat.kamera.lage(lauf.start, kopf) === null;
            raus.push({
              job,
              richtung,
              lauf: nummer,
              pass: 'fein',
              stufe: stufeFuer('fein', fehltAmKopf),
              start: pfad[0],
              pfad,
            });
          });
        }
      } else if (job.art === 'tiefe') {
        const tiefenjob = job;
        for (const pass of ['grob', 'fein'] as const) {
          const abstand = pass === 'grob' ? this.kGrob : this.K;
          const fenster = tiefenFensterSuchen(
            pass === 'grob' ? tiefenjob.grob : tiefenjob.fein,
            abstand,
            this.vorrat,
            this.fensterBilder,
          );
          if (!fenster) continue;
          const fehltAmKopf =
            kopf !== null &&
            tiefenjob.ziele.has(kopf) &&
            !tiefeBereit(kopf, this.kGrob, this.vorrat);
          raus.push({
            job,
            lauf: 0,
            pass,
            stufe: fehltAmKopf ? 0 : (pass === 'grob' ? 1 : 2) + (job.aktiv ? 0 : 2),
            start: fenster.pfad[0],
            pfad: fenster.pfad,
            schluessel: fenster.schluessel,
          });
          break;
        }
      }
    }
    return raus;
  }

  private waehlen(): Kandidat | null {
    const alle = this.kandidaten();
    if (alle.length === 0) return null;
    const stufe = Math.min(...alle.map((k) => k.stufe));
    const kopf = this.kopf;
    const abstand = (k: Kandidat) =>
      kopf !== null
        ? Math.abs(k.start - kopf)
        : k.job.art === 'tiefe'
          ? k.start
          : Math.abs(k.start - k.job.anker.k);
    const inStufe = alle
      .filter((k) => k.stufe === stufe)
      .sort(
        (a, b) =>
          abstand(a) - abstand(b) ||
          a.job.reihe - b.job.reihe ||
          Number(a.richtung === this.letzteRichtung) - Number(b.richtung === this.letzteRichtung),
      );
    const beste = inStufe[0];
    if (this.letztesVerfahren && beste.job.verfahren !== this.letztesVerfahren) {
      const treu = inStufe.find((k) => k.job.verfahren === this.letztesVerfahren);
      if (treu && abstand(treu) - abstand(beste) <= TREUE_MS / this.s) return treu;
    }
    return beste;
  }

  /* ---------- Innen: die Schleife ---------- */

  private wecken(): void {
    for (const weiter of [...this.weckRufe]) weiter();
    this.tor.wecken();
  }

  private warten(bisMs: number | null): Promise<void> {
    return new Promise((weiter) => {
      let zeitgeber: ReturnType<typeof setTimeout> | null = null;
      const fertig = () => {
        this.weckRufe.delete(fertig);
        if (zeitgeber) clearTimeout(zeitgeber);
        weiter();
      };
      this.weckRufe.add(fertig);
      if (bisMs !== null) zeitgeber = setTimeout(fertig, Math.max(0, bisMs - Date.now()));
    });
  }

  private async schleife(generation: number): Promise<void> {
    // Erst nach dem Anlaufen: Wer `setzen` gleich danach ruft, soll nicht gegen die Schleife laufen.
    await Promise.resolve();
    const aktuell = () => !this.geschlossen && generation === this.generation;
    while (aktuell()) {
      try {
        await this.tor.offen();
        if (!aktuell()) return;
        this.speicherPruefen();
        const wahl = this.waehlen();
        if (!wahl) {
          this.wachLassen();
          await this.warten(this.naechsteFreigabe(Date.now()));
          continue;
        }
        await this.ausfuehren(wahl);
      } catch {
        // Die Schleife darf nie sterben; Fehler einzelner Ketten stehen an der Kette.
        await this.warten(Date.now() + 100);
      }
    }
  }

  private async ausfuehren(wahl: Kandidat): Promise<void> {
    const steuer = new AbortController();
    this.laufend = { wahl, steuer, unterbrechen: false };
    const fenster = this.fensterBauen(wahl);
    const pfad = fenster.pfad;
    this.optionen.protokoll?.({
      kette: wahl.job.schluessel,
      art: fenster.art,
      ...(wahl.richtung ? { richtung: wahl.richtung } : {}),
      pass: wahl.pass,
      von: pfad[0],
      bis: pfad[pfad.length - 1],
      masken: wahl.job.masken,
    });
    this.letztesVerfahren = wahl.job.verfahren;
    if (wahl.richtung) this.letzteRichtung = wahl.richtung;
    this.wachHalten();
    this.melden();
    const beginn = Date.now();
    const gewartet = this.tor.gewartet;
    try {
      const ergebnis = await fensterRechnen(fenster, {
        leser: this.optionen.leser,
        vorrat: this.vorrat,
        s: this.s,
        b: this.b,
        h: this.h,
        tor: this.tor,
        abbruch: steuer.signal,
        unterbrechen: () => this.laufend?.unterbrechen === true,
        zaehler: this.zaehler,
      });
      /*
       * Ein Fenster, das weder etwas ablegt noch weiterkommt, würde sofort
       * wieder gewählt – eine Schleife, die das Telefon heizt, ohne dass sich
       * die Bahn je füllt. Das darf nach dieser Planung nicht vorkommen;
       * falls doch, steht es als Fehler an der Kette, statt still zu laufen.
       */
      const weiter = ergebnis.gespeichert > 0 || ergebnis.bis !== pfad[0];
      const stillstand = weiter ? 0 : (this.stillstand.get(wahl.job.schluessel) ?? 0) + 1;
      this.stillstand.set(wahl.job.schluessel, stillstand);
      if (stillstand >= 2) throw new Error('Die Verfolgung kommt an dieser Stelle nicht weiter.');
      /*
       * Die Schätzung lernt: Millisekunden je Pfadbild, gleitend gemittelt –
       * OHNE die Zeit am Tor. Wer mitten im Fenster anderthalb Sekunden
       * wischt, hat die Verfolgung nicht langsamer gemacht; mit der Wandzeit
       * gelernt, verdreifachte das die Restzeit, und die Anzeige „noch ~…"
       * war nach jedem Wischen minutenlang zu hoch.
       */
      const schluessel = `${wahl.job.verfahren}|${wahl.job.art === 'inhalt' && !wahl.job.grob ? 'fein' : wahl.pass}`;
      const rechenMs = Date.now() - beginn - (this.tor.gewartet - gewartet);
      const jeBild = Math.max(0, rechenMs) / Math.max(1, pfad.length);
      const alt = this.kosten.get(schluessel);
      this.kosten.set(schluessel, alt === undefined ? jeBild : alt * 0.7 + jeBild * 0.3);
    } catch (fehler) {
      if (!(fehler instanceof AbbruchError) && !steuer.signal.aborted && !this.geschlossen) {
        const text =
          fehler instanceof EngineError || fehler instanceof Error
            ? fehler.message
            : 'Unbekannter Fehler';
        if (wahl.job.art === 'tiefe') this.tiefeFehler = text;
        else this.vorrat.kette(wahl.job.schluessel, wahl.job.anker.k).fehler = text;
      }
    } finally {
      // Nach einem `schliessen` samt neuem Anlaufen gehört `laufend` schon dem neuen Fenster.
      if (this.laufend?.steuer === steuer) this.laufend = null;
      if (!steuer.signal.aborted && !this.geschlossen) {
        this.speicherPruefen();
        this.melden();
      }
    }
  }

  /**
   * Unter das Budget kommen (`Vorrat.aufraeumen`) – und reicht das nicht,
   * hält JEDE Kette an, die noch wachsen würde, bis der Vorrat wieder
   * darunter ist. Vor jedem Fenster und nach jedem.
   *
   * # Warum alle, und warum hier
   *
   * Anhalten gibt nichts frei: Was eine Kette hat, bleibt. Hielte nur die am
   * weitesten von fertig an, wüchsen die anderen weiter über das Budget –
   * nachgestellt bis zum Doppelten. Und die Freigabe gehört hierher, an den
   * Speicher, nicht an `setzen`: Dort gab jeder Reglerschritt jeder
   * angehaltenen Kette ein weiteres Fenster, und der Vorrat wuchs mit jeder
   * Bewegung im Editor. Frei werden sie, sobald wieder Platz ist – ersetzte
   * Ketten verdrängt, eine Maske gelöscht, der Film gekürzt.
   */
  private speicherPruefen(): void {
    const tiefe = this.jobs.get('tiefe');
    const voll = this.vorrat.aufraeumen(
      tiefe && tiefe.art === 'tiefe' ? (k) => tiefe.karten.has(k) : () => false,
    );
    const neu = new Set<string>();
    let tiefeAn = false;
    if (voll) {
      for (const job of this.jobs.values()) {
        if (job.art === 'inhalt' && this.fertigAnteil(job.schluessel) < 1) neu.add(job.schluessel);
        if (job.art === 'tiefe') tiefeAn = this.tiefeHatArbeit(job);
      }
    }
    let geaendert = tiefeAn !== this.tiefeAngehalten;
    for (const schluessel of this.angehalten) {
      if (neu.has(schluessel)) continue;
      const kette = this.vorrat.vorhanden(schluessel);
      if (kette?.fehler === SPEICHER_VOLL) kette.fehler = null;
      geaendert = true;
    }
    for (const schluessel of neu) {
      const job = this.jobs.get(schluessel);
      if (!job || job.art === 'tiefe') continue;
      const kette = this.vorrat.kette(schluessel, job.anker.k);
      if (kette.fehler === null) {
        kette.fehler = SPEICHER_VOLL;
        geaendert = true;
      }
    }
    this.angehalten = neu;
    this.tiefeAngehalten = tiefeAn;
    if (geaendert) this.melden();
  }

  private tiefeHatArbeit(job: Tiefenjob): boolean {
    return (
      tiefenFensterSuchen(job.grob, this.kGrob, this.vorrat, this.fensterBilder) !== null ||
      tiefenFensterSuchen(job.fein, this.K, this.vorrat, this.fensterBilder) !== null
    );
  }

  private fensterBauen(wahl: Kandidat): Fenster {
    const job = wahl.job;
    if (job.art === 'tiefe') {
      return {
        art: 'tiefe',
        pfad: wahl.pfad ?? [],
        schluessel: wahl.schluessel ?? new Set(),
        tiefeRechnen: (_k, bild, abbruch) => this.tiefeRechnen(bild, abbruch),
      };
    }
    if (job.art === 'kamera') return { art: 'kamera', pfad: wahl.pfad ?? [] };
    const richtung = wahl.richtung as Richtung;
    const lauf: Lauf = job.plan[richtung].laeufe[wahl.lauf];
    const plan = wahl.inhalt as InhaltsFensterPlan;
    const teil = job.anker.teil;
    const punkte = teil.art === 'tipp' ? teil.punkte : null;
    const alpha =
      (teil.art === 'netz' || teil.art === 'tipp') && teil.alpha.length === this.b * this.h
        ? teil.alpha
        : null;
    const start: FensterStart = plan.rand
      ? { art: 'rand', zustand: plan.rand }
      : lauf.startRechnen
        ? { art: 'anker', maske: null, punkte: lauf.neustart ? null : punkte }
        : { art: 'anker', maske: alpha, punkte };
    return {
      art: 'inhalt',
      kette: this.vorrat.kette(job.schluessel, job.anker.k),
      richtung,
      pass: wahl.pass,
      pfad: plan.pfad,
      ziele: new Set(lauf.ziele),
      schluessel: new Set(wahl.pass === 'grob' ? lauf.grob : lauf.schluessel),
      laufStart: lauf.start,
      start,
      tipp: teil.art === 'tipp',
      ...(job.wiederBilder !== undefined ? { wiederBilder: job.wiederBilder } : {}),
      brauchtBild: (k) => !(teil.art === 'netz' && this.vorrat.netz.hat(teil.netz, k)),
      rechnen: (k, bild, gezogen, abbruch) =>
        this.rechnen(teil, k, bild, gezogen, abbruch, wahl.pass),
      ruheVorModellMs: job.ruheMs,
    };
  }

  /** Ein Modellauf – oder ein Treffer im Netzvorrat. */
  private async rechnen(
    teil: Maskenteil,
    k: number,
    bild: ImageData | null,
    punkte: readonly Punkt[] | null,
    abbruch?: AbortSignal,
    pass: Pass = 'fein',
  ): Promise<Uint8Array> {
    const laenge = this.b * this.h;
    if (teil.art === 'netz') {
      const da = this.vorrat.netz.holen(teil.netz, k, laenge);
      if (da) return da;
    }
    /*
     * Ohne Bild kommt nur, wessen Ergebnis beim Lesen noch im Netzvorrat lag.
     * Hat das Budget es seitdem verdrängt, wird das Bild eben jetzt gelesen –
     * ausser der Reihe, aber besser als ein Fehler an der Kette.
     */
    if (!bild) {
      const lesung = await this.optionen.leser.holen(bildMitte(k, this.s), 'hinten', {
        voll: true,
        abbruch,
      });
      this.zaehler.lesen += 1;
      bild = lesung.voll;
      if (!bild) throw new Error(`Für Bild ${k} fehlt das Bild`);
    }
    const maske = this.optionen.rechnen
      ? await this.optionen.rechnen(teil, bild, punkte, abbruch)
      : (
          await teilRechnen(
            { teil },
            { zeitMs: bildMitte(k, this.s), daten: bild },
            this.b,
            this.h,
            null,
            abbruch,
            punkte,
            'hinten',
          )
        ).werte;
    this.zaehler.laeufe += 1;
    // Genau die Maske, die ein späterer Treffer im Netzvorrat liefern wird – siehe `Netzvorrat.ablegen`.
    if (teil.art === 'netz') return this.vorrat.netz.ablegen(teil.netz, k, maske, pass);
    return maske;
  }

  /**
   * Eine Tiefenkarte – mit einer eigenen Sitzung, die bei `modellReihe`
   * angemeldet ist: Sie geht, wenn ein anderes schweres Verfahren an die
   * Reihe kommt oder 20 s lang keine Karte gebraucht wurde.
   */
  private async tiefeRechnen(bild: ImageData, abbruch?: AbortSignal): Promise<NeueDaten> {
    this.zaehler.laeufe += 1;
    if (this.optionen.tiefeRechnen) return this.optionen.tiefeRechnen(bild, abbruch);
    /*
     * Ein zweiter Versuch mit einer frischen Sitzung, falls die erste
     * freigegeben wurde, während ihr Auftrag noch in der Reihe stand – die
     * Reihe verhindert das (`modellReihe` zählt Wartende mit), aber ein
     * Fehler, der daran hängt, sperrte sonst die Tiefe (siehe `tiefeFehler`).
     */
    for (let versuch = 0; ; versuch += 1) {
      const offen = this.tiefeSitzung();
      const sitzung = await offen;
      try {
        const karte = await sitzung.karteFuer(bild, { vorrang: 'hinten', abbruch });
        return { breite: karte.breite, hoehe: karte.hoehe, werte: karte.feld };
      } catch (fehler) {
        const freigegeben = this.tiefensitzung !== offen;
        if (fehler instanceof AbbruchError || !freigegeben || versuch > 0) throw fehler;
      }
    }
  }

  /** Die Tiefensitzung der Verfolgung – geöffnet, wenn es keine gibt. */
  private tiefeSitzung(): Promise<Tiefensitzung> {
    if (this.tiefensitzung) return this.tiefensitzung;
    const versuch = import('../bild/tiefeNetz.js').then((modul) => modul.tiefensitzungOeffnen());
    this.tiefensitzung = versuch;
    versuch.then(
      (offen) => {
        sitzungFreigeberSetzen('tiefe', async () => {
          if (this.tiefensitzung === versuch) this.tiefensitzung = null;
          sitzungFreigeberSetzen('tiefe', null);
          await offen.schliessen();
        });
      },
      () => {
        if (this.tiefensitzung === versuch) this.tiefensitzung = null;
      },
    );
    return versuch;
  }

  /* ---------- Innen: der Bildschirm bleibt an, solange gerechnet wird ---------- */

  /**
   * Die Bildschirmsperre, solange ein Fenster läuft und die Seite sichtbar
   * ist: Ein Telefon, das nach dreissig Sekunden dunkel wird, hält die Seite
   * an – und mit ihr die Verfolgung, die der Anwender gerade abwartet.
   */
  private wachHalten(): void {
    if (this.wachZeitgeber) clearTimeout(this.wachZeitgeber);
    this.wachZeitgeber = null;
    if (this.wachSperre || this.wachAnfrage) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    this.wachAnfrage = true;
    navigator.wakeLock
      .request('screen')
      .then((sperre) => {
        if (this.geschlossen) {
          void sperre.release();
          return;
        }
        this.wachSperre = sperre;
        sperre.addEventListener('release', () => {
          if (this.wachSperre === sperre) this.wachSperre = null;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        this.wachAnfrage = false;
      });
  }

  /** Fünf Sekunden nach dem letzten Fenster darf er wieder dunkel werden. */
  private wachLassen(): void {
    if (!this.wachSperre || this.wachZeitgeber) return;
    this.wachZeitgeber = setTimeout(() => {
      this.wachZeitgeber = null;
      const sperre = this.wachSperre;
      this.wachSperre = null;
      void sperre?.release().catch(() => undefined);
    }, WACH_MS);
  }
}

function gleicherKandidat(a: Kandidat, b: Kandidat): boolean {
  return (
    a.job.schluessel === b.job.schluessel &&
    a.richtung === b.richtung &&
    a.lauf === b.lauf &&
    a.pass === b.pass
  );
}
