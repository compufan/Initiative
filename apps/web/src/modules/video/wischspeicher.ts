import { AbbruchError } from '../stickers/engines/index.js';
import type { KleinWunsch, Leserdienst, Mitschnitt } from './leserDienst.js';
import { BytesLru } from './lru.js';
import { bildMitte } from './raster.js';
import { Ruhetor, WEITER_MS } from './ruhetor.js';

/**
 * Kleine, komprimierte Bilder des ganzen Films – damit das Wischen durch die
 * Zeitleiste das Bild unter dem Finger zeigt.
 *
 * # Warum Bilder in der Hand und nicht Sprünge im Video
 *
 * Weil ein `<video>` ein Dekodierer ist und kein Bildspeicher. Ein Sprung
 * kostet 87 – 233 ms, bei langem Schlüsselbildabstand bis 584 ms; der Finger
 * legt beim schnellen Wischen 300 Bilder in der Sekunde zurück. Gemessen
 * (`messung-vorher.md`): Das Bild unter dem Finger kam im Mittel 6 – 126
 * Filmbilder zu spät, 2 – 11-mal je Sekunde. Schneller wird das mit
 * Sprüngen nie. Kleine Bilder aus dem Speicher dagegen: Entpacken 1 – 5 ms,
 * Zeichnen 0,2 – 2 ms – bis zum Anzeigetakt des Schirms.
 *
 * # Warum kleine, komprimierte Bilder
 *
 * Unkomprimiert wären es 0,52 MB je Bild bei 480 Punkten, 155 MB für 300
 * Bilder; dafür wirft ein Telefon den Reiter weg. WebP (Güte 0,75, wo
 * `toBlob` es kann, sonst JPEG) wiegt 10 KB je Bild – 300 Bilder 3 MB.
 * Beim Wischen ist das Bild dadurch etwas weich; sobald der Finger ruht,
 * kommt das scharfe Bild des Videos. Bei Schnittprogrammen mit Proxies ist
 * das Stand der Technik.
 *
 * # Warum Stufen: grob zu fein
 *
 * Jedes 16., dann jedes 8., 4., 2., und zuletzt alle übrigen Bilder
 * (`stufeVon`). Jedes Bild wird nur EINMAL gelesen – die Stufen kosten
 * keinen Sprung mehr als ein Durchlauf –, aber nach 2 – 5 s liegt zu jeder
 * Stelle schon ein Bild höchstens 4 Filmbilder daneben, statt dass die
 * erste Sekunde fertig ist und der Rest nichts hat. „Früh ungefähr richtig"
 * ist beim Wischen wichtiger als „hinten noch nichts".
 *
 * # Warum Vorfahrt nur für die groben Stufen
 *
 * Die Stufen 0 – 2 (rund 75 Bilder) laufen mit Vorfahrt vor der Verfolgung
 * (`'mitte'` im `leserDienst`): Wer den Editor aufmacht und wischt, will
 * sofort „ungefähr richtig". Die feinen Stufen 3 und 4 laufen abwechselnd mit
 * der Verfolgung (`'hinten'`) – „±1 Bild" und „genau" sind wichtig, aber nie
 * wichtiger als eine Maske, die der Anwender gerade erwartet. Dazu der
 * Mitschnitt: Jedes Bild, das die Verfolgung ohnehin liest, gibt der Dienst
 * als kleines Bild nebenher ab.
 *
 * # Warum beim Zug Ruhe
 *
 * Beim Zug zeichnet der Hauptfaden in jedem Anzeigetakt; das Standbild beim
 * Loslassen braucht den Dekodierer SOFORT – ein Sprung des Füllens, der
 * gerade läuft, hielte es bis zu 300 ms auf. Gleiche Gründe wie die
 * Verfolgung (`Ruhetor`): Zug, Wiedergabe, Filmbau, verborgenes Fenster. Dazu
 * `'speicher'`, wenn der Arbeitsspeicher knapp wird.
 *
 * # Warum das Rasterbild k und nicht die Zeit im Video
 *
 * Schlüssel ist das Rasterbild `k` der QUELLE (`raster.ts`), nicht die Stelle
 * im Film: Teilen, Kürzen und Umstellen ändern, WO im Film ein Quellbild
 * steht, nie, was darauf zu sehen ist – der Speicher bleibt dabei gültig.
 * Gelesen wird an `bildMitte(k)`, wie Verfolgung, Standbild und Filmbau:
 * Dasselbe `k` ist überall dasselbe Bild, und Bild und Maske beim Zeichnen
 * gehören zum selben `k`. Den Umweg über das `mediaTime` eines Videobildes
 * gibt es hier nicht – genau der hat einer 30er-Quelle jedes dritte Bild mit
 * der Maske des vorigen gezeigt.
 *
 * # Was nicht im Speicher liegt
 *
 * Nur das ROHE Bild: Regler, Masken und Schnitte ändern den Speicher nie,
 * bearbeitet wird erst beim Zeichnen. Und nichts im Gerätespeicher – der
 * Film eines Anwenders gehört nicht in eine dauerhafte Ablage.
 *
 * # Wenn etwas fehlt
 *
 * Ohne `toBlob` oder wenn nur PNG herauskommt (ein Vielfaches an Bytes), ist
 * der Speicher nicht verfügbar: `hat` antwortet immer `false`, der Zug läuft
 * wie ohne ihn – ohne Fehlerdialog, der Anwender hat nichts verloren, nur
 * etwas nicht gewonnen. Ohne `createImageBitmap` entpackt ein
 * `HTMLImageElement`.
 */

/** Die längere Kante der kleinen Bilder – scharf wird ohnehin das Video, sobald der Finger ruht. */
export const WISCH_KANTE = 480;
/** Güte für WebP. */
export const WISCH_GUETE = 0.75;
/** Güte für JPEG, wo kein WebP kodiert wird. */
export const WISCH_GUETE_JPEG = 0.8;
/** So viele Bytes höchstens an komprimierten Bildern. */
export const WISCH_BUDGET = 24 * 1024 * 1024;
/** Ein einzelnes Bild darüber wird verworfen – Schutz gegen Ausreisser der Kodierung. */
export const BILD_MAX_BYTES = 200 * 1024;
/** So viele entpackte Bilder höchstens (rund 0,5 MB das Stück bei 480 Punkten). */
export const ENTPACKT_MAX = 8;
/** So oft höchstens meldet `stand()` Neues. */
export const WISCH_MELDEN_MS = 250;
/** Die Stufen bis hierher laufen mit Vorfahrt vor der Verfolgung. */
export const MITTE_STUFE_MAX = 2;
/** So viele Kodierfehler in Folge beenden das Füllen. */
export const FEHLER_FOLGE_MAX = 3;

/**
 * Warum das Füllen ruht – Gründe wie bei der Verfolgung (siehe `Ruhetor`).
 *
 * - `'zug'`: ein Finger auf Leiste, Bahnen, Griffen oder der Bühne.
 * - `'wiedergabe'`: der Film läuft.
 * - `'bauen'`: der Filmbau läuft. Er schliesst den Leser und liest mit EINEM
 *   eigenen Dekodierer; ein Auftrag des Speichers öffnete den Leser sofort
 *   wieder – derselbe Fehler, den die Verfolgung schon einmal hatte.
 * - `'verborgen'`: das Fenster ist nicht zu sehen – nichts tun, was niemand
 *   sieht (Akku).
 * - `'speicher'`: der Arbeitsspeicher wird knapp.
 */
export type WischRuhe = 'zug' | 'wiedergabe' | 'bauen' | 'verborgen' | 'speicher';

/** In welchem Format die kleinen Bilder kodiert werden. */
export interface WischFormat {
  readonly typ: 'image/webp' | 'image/jpeg';
  readonly guete: number;
}

/** Ein entpacktes Bild – zeichenbar, und freizugeben, wo es `close` gibt. */
export type WischBild = ImageBitmap | HTMLImageElement;

export interface WischStand {
  /** Steigt bei jeder Änderung – für `useSyncExternalStore`. */
  readonly version: number;
  /** Wie viele Bilder gespeichert sind. */
  readonly bilder: number;
  /** Wie viele der Film braucht. */
  readonly von: number;
  readonly bytes: number;
  /** Bis zu welcher Stufe (0 … 4) alles da ist; -1: noch nicht einmal Stufe 0. */
  readonly stufe: number;
  readonly fertig: boolean;
  /** `false`: Dieser Browser kodiert keine kleinen Bilder, der Speicher bleibt leer. */
  readonly verfuegbar: boolean;
}

/* ---------- Das Rechenbare ---------- */

/**
 * Der Schritt der groben Stufe: etwa ein halbe Sekunde, eine Zweierpotenz,
 * zwischen 4 und 32 – bei 25 Bildern je Sekunde 16, bei 60 jedes 32.
 *
 * Eine Zweierpotenz, weil jede feinere Stufe die vorige enthält: Jedes
 * 8. Bild ist auch ein 4. und 2. – und ein Bild wird nur einmal gelesen.
 */
export function grobSchritt(s: number): number {
  const roh = Math.ceil(Math.log2(500 / Math.max(1, s)));
  return 2 ** Math.min(5, Math.max(2, roh));
}

/** Wie weit ein Bild vom Wischen entfernt sein darf und noch als „ungefähr richtig" gilt. */
export function wischToleranz(s: number): number {
  return grobSchritt(s) / 2;
}

/**
 * In welcher Stufe Rasterbild k gefüllt wird: 0 – jedes `schritt`-te, 1 –
 * jedes halbe, 2 – jedes Viertel, 3 – jedes Achtel, 4 – alle übrigen.
 *
 * Nach dem ABSOLUTEN `k`, nicht nach der Stelle im Film: Die Stufen ändern
 * sich beim Kürzen und Verschieben nicht, und ein Bild behält seine Stufe.
 */
export function stufeVon(k: number, schritt: number): number {
  for (let stufe = 0; stufe < 4; stufe += 1) {
    const teiler = Math.max(1, Math.floor(schritt / 2 ** stufe));
    if (k % teiler === 0) return stufe;
  }
  return 4;
}

/**
 * Welches Bild als Nächstes gefüllt wird: aus der niedrigsten Stufe, in der
 * noch eines fehlt, aufsteigend ab `kopf` und danach von vorn bis dorthin.
 *
 * Aufsteigend, weil Vorwärtssprünge im selben Schlüsselbildabschnitt am
 * billigsten sind; ab dem Kopf, weil dort der Anwender steht.
 *
 * `film`: die Rasterbilder des Films, aufsteigend und ohne Doppelte.
 * `verbotenAb`: Stufen ab dieser Zahl werden nicht mehr gefüllt (das Budget
 * ist an ihnen gerissen – sonst würde dasselbe Bild gelesen, verdrängt,
 * wieder gelesen …).
 */
export function naechstesFehlendes(
  film: readonly number[],
  da: (k: number) => boolean,
  schritt: number,
  kopf: number | null,
  verbotenAb = 5,
): { readonly k: number; readonly stufe: number } | null {
  if (film.length === 0) return null;
  // Der erste Index, dessen Bild nicht vor dem Kopf liegt.
  let anfang = 0;
  if (kopf !== null) {
    let lo = 0;
    let hi = film.length;
    while (lo < hi) {
      const mitte = (lo + hi) >> 1;
      if (film[mitte] < kopf) lo = mitte + 1;
      else hi = mitte;
    }
    anfang = lo % film.length;
  }
  const grenze = Math.min(5, verbotenAb);
  for (let stufe = 0; stufe < grenze; stufe += 1) {
    for (let n = 0; n < film.length; n += 1) {
      const k = film[(anfang + n) % film.length];
      if (stufeVon(k, schritt) === stufe && !da(k)) return { k, stufe };
    }
  }
  return null;
}

/**
 * Das Filmbild in der Nähe von `i`, dessen Rasterbild der Speicher hat – das
 * nächste, bei gleichem Abstand das frühere.
 *
 * Im Raum der FILMbilder gesucht (`i ± d`) und nicht der Rasterbilder: Es
 * kommt der Index des Filmbildes heraus, dessen `k` der Speicher hat. Kommt
 * dasselbe `k` in zwei Abschnitten vor (derselbe Ausschnitt zweimal), ist
 * entscheidend, in welchem das Filmbild liegt.
 */
export function naechstesBild(
  bilder: readonly { readonly k: number }[],
  i: number,
  hat: (k: number) => boolean,
  toleranz: number,
): { readonly index: number; readonly abstand: number } | null {
  if (bilder.length === 0) return null;
  const mitte = Math.max(0, Math.min(bilder.length - 1, i));
  for (let d = 0; d <= toleranz; d += 1) {
    const vorn = mitte - d;
    if (vorn >= 0 && hat(bilder[vorn].k)) return { index: vorn, abstand: d };
    const hinten = mitte + d;
    if (d > 0 && hinten < bilder.length && hat(bilder[hinten].k)) {
      return { index: hinten, abstand: d };
    }
  }
  return null;
}

/**
 * Welches Bild weichen muss, wenn das Budget reisst: zuerst eines, das nicht
 * mehr im Film liegt (nach einem Kürzen), dann aus der feinsten Stufe, und
 * darin das, das am weitesten vom Kopf entfernt ist.
 *
 * Nicht „das am längsten nicht Gebrauchte": Ein Speicher, der nur das zuletzt
 * Gesehene behält, hätte beim Hin-und-her-Wischen Löcher, wo der Finger
 * vorher nicht war. Stufe 0 weicht erst, wenn nichts Feineres mehr da ist.
 */
export function zuVerdraengen(
  gespeichert: Iterable<number>,
  imFilm: ReadonlySet<number>,
  schritt: number,
  kopf: number,
): number | null {
  let opfer: number | null = null;
  let wert = -1;
  let weit = -1;
  for (const k of gespeichert) {
    const w = imFilm.has(k) ? stufeVon(k, schritt) : 10;
    const abstand = Math.abs(k - kopf);
    if (w > wert || (w === wert && abstand > weit)) {
      opfer = k;
      wert = w;
      weit = abstand;
    }
  }
  return opfer;
}

/**
 * Bis zu welcher Stufe alles da ist – -1, wenn nicht einmal Stufe 0, und bei
 * einem Film ohne Bilder: Wo nichts gebraucht wird, ist auch nichts „da“ –
 * sonst meldete der leere Speicher vor dem ersten `setzen` die höchste Stufe,
 * und wer auf eine Stufe wartet, liefe gleich los.
 */
export function stufeBis(
  film: readonly number[],
  da: (k: number) => boolean,
  schritt: number,
): number {
  if (film.length === 0) return -1;
  const fehlt = [false, false, false, false, false];
  for (const k of film) if (!da(k)) fehlt[stufeVon(k, schritt)] = true;
  let stufe = -1;
  for (let s = 0; s < 5; s += 1) {
    if (fehlt[s]) break;
    stufe = s;
  }
  return stufe;
}

/* ---------- Der Browser ---------- */

/**
 * Welches Format `toBlob` wirklich liefert – EINMAL beim Start geprüft, nicht
 * bei jedem Bild.
 *
 * Safari kodiert nach unserem Kenntnisstand kein WebP in der Leinwand und
 * gibt dann PNG zurück: ein Vielfaches an Bytes. Darum zählt, was
 * herauskommt (`blob.type`), nicht, was verlangt wurde. Liefert auch JPEG
 * nicht, ist der Speicher nicht verfügbar.
 */
export async function formatPruefen(): Promise<WischFormat | null> {
  if (typeof document === 'undefined') return null;
  const flaeche = document.createElement('canvas');
  flaeche.width = 8;
  flaeche.height = 8;
  const stift = flaeche.getContext('2d');
  if (!stift || typeof flaeche.toBlob !== 'function') return null;
  stift.fillStyle = '#808080';
  stift.fillRect(0, 0, 8, 8);
  const kodieren = (typ: string, guete: number) =>
    new Promise<Blob | null>((fertig) => {
      try {
        flaeche.toBlob((blob) => fertig(blob), typ, guete);
      } catch {
        fertig(null);
      }
    });
  const webp = await kodieren('image/webp', WISCH_GUETE);
  if (webp?.type === 'image/webp') return { typ: 'image/webp', guete: WISCH_GUETE };
  const jpeg = await kodieren('image/jpeg', WISCH_GUETE_JPEG);
  if (jpeg?.type === 'image/jpeg') return { typ: 'image/jpeg', guete: WISCH_GUETE_JPEG };
  return null;
}

/** Ein kodiertes Bild entpacken – `createImageBitmap`, sonst ein `HTMLImageElement`. */
export async function bildEntpacken(blob: Blob): Promise<WischBild> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const adresse = URL.createObjectURL(blob);
  try {
    const bild = new Image();
    bild.src = adresse;
    await bild.decode();
    return bild;
  } finally {
    URL.revokeObjectURL(adresse);
  }
}

function freigeben(bild: WischBild): void {
  if ('close' in bild) bild.close();
}

/** Die Prüfhaken für Tests – siehe `pruefhaken`. */
export interface WischHaken {
  verfuegbar: boolean;
  format: string | null;
  stufe: number;
  bilder: number;
  bytes: number;
  entpackt: number;
  fertig: boolean;
  ruhe: string[];
  zaehler: { gelesen: number; mitgeschnitten: number; kodiert: number; fehler: number };
  /** Für Tests: Der Speicher wird weder benutzt noch gefüllt. */
  aus: boolean;
  /** Für Tests: ein kleineres Budget, wenn VOR dem Anlegen des Speichers gesetzt. */
  budget?: number;
  /** Für Tests: das Füllen anhalten und wieder laufen lassen. */
  ruhen?: (grund: WischRuhe, an: boolean) => void;
}

/**
 * Der Prüfhaken `window.__wisch` – gesetzt beim ersten `setzen`, wie
 * `__verfolger`. Ein vorhandener bleibt erhalten (ein Test setzt `aus` und
 * `budget` vorher).
 */
function pruefhaken(): WischHaken {
  const neu = (): WischHaken => ({
    verfuegbar: true,
    format: null,
    stufe: -1,
    bilder: 0,
    bytes: 0,
    entpackt: 0,
    fertig: false,
    ruhe: [],
    zaehler: { gelesen: 0, mitgeschnitten: 0, kodiert: 0, fehler: 0 },
    aus: false,
  });
  if (typeof window === 'undefined') return neu();
  const fenster = window as unknown as { __wisch?: Partial<WischHaken> };
  const haken = (fenster.__wisch ??= {}) as Partial<WischHaken>;
  const vorgabe = neu();
  for (const [name, wert] of Object.entries(vorgabe)) {
    if (name === 'aus') haken.aus ??= false;
    else (haken as Record<string, unknown>)[name] = wert;
  }
  return haken as WischHaken;
}

export interface WischOptionen {
  /** Der Dienst der Sitzung – oder ein Ersatz mit `holen` und `mitschnittSetzen`. */
  readonly leser: Pick<Leserdienst, 'holen' | 'mitschnittSetzen'>;
  /** Die Schrittweite des Rasters, `1000 / bildrate`. */
  readonly s: number;
  readonly kante?: number;
  readonly budget?: number;
  readonly weiterMs?: number;
  readonly meldenMs?: number;
  /** Ersatz für die Prüfung des Formats – für Tests. */
  readonly format?: () => Promise<WischFormat | null>;
  /** Ersatz für das Entpacken – für Tests. */
  readonly entpacken?: (blob: Blob) => Promise<WischBild>;
}

/** Die Bilder, die der Film braucht, mit ihrem Rasterbild. */
interface FilmBildK {
  readonly k: number;
}

export class Wischspeicher {
  private readonly s: number;
  private readonly kante: number;
  private readonly schritt: number;
  private readonly leser: Pick<Leserdienst, 'holen' | 'mitschnittSetzen'>;
  private readonly tor: Ruhetor<WischRuhe>;
  private readonly meldenMs: number;
  private readonly entpacker: (blob: Blob) => Promise<WischBild>;
  private readonly formatSuchen: () => Promise<WischFormat | null>;
  private readonly budgetStart: number;
  private budget: number;
  private hakenWert: WischHaken | null = null;

  /** Die kodierten Bilder, nach Rasterbild. */
  private readonly blobs = new Map<number, Blob>();
  private summe = 0;
  /** Die Rasterbilder des Films, aufsteigend und ohne Doppelte. */
  private film: readonly number[] = [];
  private imFilm: ReadonlySet<number> = new Set();
  private kopfK: number | null = null;
  /** Bilder, die sich nicht kodieren oder nicht speichern liessen – nicht noch einmal versuchen. */
  private readonly aufgegeben = new Set<number>();
  private readonly verdorben = new Map<number, number>();
  /** Stufen ab hier werden nicht mehr gefüllt – das Budget ist an ihnen gerissen. */
  private verbotenAb = 5;
  private readonly entpackt: BytesLru<number, WischBild>;
  private readonly entpackend = new Map<number, Promise<WischBild | null>>();

  private format: WischFormat | null = null;
  private wunsch: KleinWunsch | null = null;
  private verfuegbarFlag = true;
  private fehlerFolge = 0;
  private laeuft = false;
  private generation = 0;
  private steuer = new AbortController();
  private wecker: (() => void) | null = null;
  private readonly ruhegruende = new Set<WischRuhe>();

  private standWert: WischStand;
  private version = 0;
  private letzteMeldung = 0;
  private meldeZeit: ReturnType<typeof setTimeout> | null = null;
  private readonly hoerer = new Set<() => void>();
  private sichtbarkeit: (() => void) | null = null;
  private einfrieren: (() => void) | null = null;

  /**
   * Der Konstruktor hat KEINE Nebenwirkungen – wie beim Verfolger: React
   * ruft im StrictMode Fabriken und Effekte doppelt, und eine Instanz, die
   * schon im Konstruktor Horcher anmeldet oder liest, hinterliesse einen
   * Geist. Prüfhaken, Mitschnitt, Horcher und Schleife kommen mit dem ersten
   * `setzen`.
   */
  constructor(optionen: WischOptionen) {
    this.s = optionen.s;
    this.kante = optionen.kante ?? WISCH_KANTE;
    this.schritt = grobSchritt(optionen.s);
    this.leser = optionen.leser;
    this.tor = new Ruhetor<WischRuhe>(optionen.weiterMs ?? WEITER_MS);
    this.meldenMs = optionen.meldenMs ?? WISCH_MELDEN_MS;
    this.entpacker = optionen.entpacken ?? bildEntpacken;
    this.formatSuchen = optionen.format ?? formatPruefen;
    this.budgetStart = optionen.budget ?? budgetVonTest() ?? budgetFuerGeraet();
    this.budget = this.budgetStart;
    this.entpackt = new BytesLru<number, WischBild>(
      // Ein entpacktes Bild: Breite · Höhe · 4 – bei 480 Punkten rund 0,5 MB.
      ENTPACKT_MAX * 4 * this.kante * this.kante * 0.5625,
      (_k, bild) => freigeben(bild),
    );
    this.standWert = this.standRechnen();
  }

  /** Der Prüfhaken – erst beim ersten Gebrauch angelegt, nicht im Konstruktor. */
  private get haken(): WischHaken {
    this.hakenWert ??= pruefhaken();
    return this.hakenWert;
  }

  /* ---------- Film und Kopf ---------- */

  /**
   * Die Bilder des Films – bei JEDER Änderung der Abschnitte. Rechnet den
   * Unterschied: Teilen, Kürzen, Umstellen kosten nichts, weil der Schlüssel
   * das Rasterbild der Quelle ist; neue Bilder kommen hinten in die Reihe,
   * nicht mehr gebrauchte weichen als Erste, wenn das Budget reisst.
   */
  setzen(filmBilder: readonly FilmBildK[]): void {
    const film = [...new Set(filmBilder.map((bild) => bild.k))].sort((a, b) => a - b);
    this.film = film;
    this.imFilm = new Set(film);
    // Ein kleinerer Film schafft Platz: Stufen, die am Budget gerissen sind, dürfen wieder.
    if (this.summe < this.budget * 0.8) this.verbotenAb = 5;
    if (film.length > 0) this.anlaufen();
    this.wecken();
    this.aenderung();
  }

  /** Wo der Anwender steht – für die Reihenfolge des Füllens. */
  kopf(k: number): void {
    this.kopfK = k;
  }

  /* ---------- Fragen ---------- */

  /** Hat der Speicher dieses Rasterbild? */
  hat(k: number): boolean {
    return this.verfuegbarFlag && !this.haken.aus && this.blobs.has(k);
  }

  /**
   * Das Bild entpacken, damit es beim Zeichnen schon da ist – beim
   * Zeigerereignis, nicht im Anzeigetakt. Gemessen (Messung 4.5): Entpacken
   * IM Takt gibt 35 – 46 Bilder/s mit Bildalter bis 400 ms; beim Ereignis
   * entpacken und im Takt zeichnen schafft den Takt des Schirms (49 – 59/s,
   * Bildalter Ø 9 – 14 ms).
   */
  vorladen(k: number): void {
    if (this.entpackt.hat(k)) {
      this.entpackt.holen(k);
      return;
    }
    if (this.entpackend.has(k)) return;
    void this.entpackenStarten(k);
  }

  /** Das entpackte Bild – synchron und nur aus dem Vorrat. */
  entpacktBild(k: number): WischBild | null {
    return this.entpackt.holen(k) ?? null;
  }

  /** Das entpackte Bild – wartet, bis es entpackt ist. */
  async bild(k: number): Promise<WischBild | null> {
    const da = this.entpackt.holen(k);
    if (da) return da;
    return (this.entpackend.get(k) ?? this.entpackenStarten(k)).then(
      (bild) => bild ?? this.entpackt.holen(k) ?? null,
    );
  }

  /* ---------- Ruhe ---------- */

  ruhen(grund: WischRuhe, an: boolean): void {
    if (an) this.ruhegruende.add(grund);
    else this.ruhegruende.delete(grund);
    this.tor.setzen(grund, an);
    this.haken.ruhe = [...this.ruhegruende];
  }

  /**
   * Der Arbeitsspeicher wird knapp: entpackte Bilder freigeben, das Budget
   * halbieren und das Füllen ruhen lassen. Auf iOS gibt es keine solche
   * Meldung – dort zählt die kleine Gesamtgrösse.
   */
  speicherKnapp(an: boolean): void {
    // Wiederholt gerufen (jede Meldung der Verfolgung): nichts Neues.
    if (an === this.ruhegruende.has('speicher')) return;
    if (an) {
      this.entpackt.leeren(true);
      this.entpackend.clear();
      this.budget = Math.max(1024 * 1024, Math.floor(this.budgetStart / 2));
      this.verdraengen();
    } else {
      this.budget = this.budgetStart;
      this.verbotenAb = 5;
    }
    this.ruhen('speicher', an);
    this.aenderung();
  }

  /* ---------- Stand ---------- */

  abonnieren = (rueckruf: () => void): (() => void) => {
    this.hoerer.add(rueckruf);
    return () => {
      this.hoerer.delete(rueckruf);
    };
  };

  stand = (): WischStand => this.standWert;

  /* ---------- Schliessen ---------- */

  /**
   * Alles zurücklegen: Schleife beenden, Aufträge abbrechen, entpackte Bilder
   * freigeben, beide Vorräte leeren, den Mitschnitt abmelden. Ein späteres
   * `setzen` fängt von vorn an – StrictMode führt Aufräumen und Effekt
   * doppelt aus, ein endgültiges Schliessen hinterliesse einen toten Speicher.
   */
  schliessen(): void {
    this.generation += 1;
    this.laeuft = false;
    this.steuer.abort();
    this.steuer = new AbortController();
    this.leser.mitschnittSetzen(null);
    this.blobs.clear();
    this.summe = 0;
    this.entpackt.leeren(true);
    this.entpackend.clear();
    this.aufgegeben.clear();
    this.verdorben.clear();
    this.verbotenAb = 5;
    this.fehlerFolge = 0;
    this.film = [];
    this.imFilm = new Set();
    if (typeof document !== 'undefined' && this.sichtbarkeit) {
      document.removeEventListener('visibilitychange', this.sichtbarkeit);
    }
    this.sichtbarkeit = null;
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && this.einfrieren) {
      window.removeEventListener('pagehide', this.einfrieren);
      document.removeEventListener('freeze', this.einfrieren);
    }
    this.einfrieren = null;
    if (this.meldeZeit) clearTimeout(this.meldeZeit);
    this.meldeZeit = null;
    for (const grund of [...this.ruhegruende]) this.ruhen(grund, false);
    this.wecken();
    this.aenderung(true);
  }

  /* ---------- Das Füllen ---------- */

  private anlaufen(): void {
    if (this.laeuft) return;
    this.laeuft = true;
    this.generation += 1;
    const generation = this.generation;
    this.haken.ruhen = (grund, an) => this.ruhen(grund, an);
    if (typeof document !== 'undefined') {
      this.sichtbarkeit = () => this.ruhen('verborgen', document.hidden);
      document.addEventListener('visibilitychange', this.sichtbarkeit);
      this.sichtbarkeit();
    }
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      // Die Seite geht in den Hintergrund oder wird eingefroren: entpackte Bilder freigeben.
      this.einfrieren = () => {
        this.entpackt.leeren(true);
        this.entpackend.clear();
        this.aenderung();
      };
      window.addEventListener('pagehide', this.einfrieren);
      document.addEventListener('freeze', this.einfrieren);
    }
    void this.schleife(generation);
  }

  private gilt(generation: number): boolean {
    return this.laeuft && generation === this.generation;
  }

  private async schleife(generation: number): Promise<void> {
    // Erst das Format: Ohne kodierbare kleine Bilder gibt es nichts zu füllen.
    const format = await this.formatSuchen().catch(() => null);
    if (!this.gilt(generation)) return;
    this.format = format;
    this.haken.format = format?.typ ?? null;
    if (!format) {
      this.verfuegbarFlag = false;
      this.laeuft = false;
      this.aenderung(true);
      return;
    }
    this.wunsch = { kante: this.kante, typ: format.typ, guete: format.guete };
    const wunsch = this.wunsch;
    this.leser.mitschnittSetzen(this.mitschnittFuer(wunsch));
    this.aenderung(true);

    while (this.gilt(generation)) {
      try {
        await this.tor.offen();
        if (!this.gilt(generation)) return;
        if (this.haken.aus) {
          await this.warten(200);
          continue;
        }
        const wahl = naechstesFehlendes(
          this.film,
          (k) => this.blobs.has(k) || this.aufgegeben.has(k),
          this.schritt,
          this.kopfK,
          this.verbotenAb,
        );
        if (!wahl) {
          this.aenderung(true);
          await this.schlafen();
          continue;
        }
        const prioritaet = wahl.stufe <= MITTE_STUFE_MAX ? 'mitte' : 'hinten';
        this.haken.zaehler.gelesen += 1;
        const lesung = await this.leser.holen(bildMitte(wahl.k, this.s), prioritaet, {
          klein: wunsch,
          abbruch: this.steuer.signal,
        });
        const blob = lesung.klein ? await lesung.klein : null;
        if (!this.gilt(generation)) return;
        if (blob) {
          this.fehlerFolge = 0;
          this.haken.zaehler.kodiert += 1;
          this.ablegen(wahl.k, blob);
        } else {
          this.fehlerMelden(wahl.k);
        }
      } catch (fehler) {
        if (!this.gilt(generation)) return;
        // Ein Abbruch kommt vom Schliessen des Dienstes (Filmbau) – kurz Luft holen.
        if (fehler instanceof AbbruchError) await this.warten(50);
        else this.fehlerMelden(null);
      }
      if (!this.verfuegbarFlag) return;
    }
  }

  /** Ein Bild liess sich nicht kodieren – dieses auslassen, drei in Folge beenden das Füllen. */
  private fehlerMelden(k: number | null): void {
    this.fehlerFolge += 1;
    this.haken.zaehler.fehler += 1;
    if (k !== null) this.aufgegeben.add(k);
    if (this.fehlerFolge >= FEHLER_FOLGE_MAX) {
      this.verfuegbarFlag = false;
      this.laeuft = false;
      this.aenderung(true);
    }
  }

  private mitschnittFuer(wunsch: KleinWunsch): Mitschnitt {
    return {
      wunsch,
      braucht: (k) =>
        this.verfuegbarFlag &&
        !this.haken.aus &&
        !this.tor.zu &&
        this.imFilm.has(k) &&
        !this.blobs.has(k) &&
        !this.aufgegeben.has(k),
      ablegen: (k, blob) => {
        this.haken.zaehler.mitgeschnitten += 1;
        this.ablegen(k, blob);
      },
    };
  }

  /* ---------- Speichern und Verdrängen ---------- */

  private ablegen(k: number, blob: Blob): void {
    if (blob.size > BILD_MAX_BYTES) {
      // Ein Ausreisser der Kodierung: Das Nachbarbild füllt die Stelle.
      this.aufgegeben.add(k);
      return;
    }
    const alt = this.blobs.get(k);
    if (alt) this.summe -= alt.size;
    this.blobs.set(k, blob);
    this.summe += blob.size;
    // Ein neues Bild gilt: das entpackte alte (falls es eines gab) ist überholt.
    const entpackt = this.entpackt.holen(k);
    if (entpackt) {
      this.entpackt.loeschen(k);
      freigeben(entpackt);
    }
    this.verdraengen();
    this.druckPruefen();
    this.aenderung();
    this.wecken();
  }

  private verdraengen(): void {
    while (this.summe > this.budget) {
      const opfer = zuVerdraengen(this.blobs.keys(), this.imFilm, this.schritt, this.kopfK ?? 0);
      if (opfer === null) break;
      const stufe = this.imFilm.has(opfer) ? stufeVon(opfer, this.schritt) : null;
      this.entfernen(opfer);
      if (stufe !== null) this.verbotenAb = Math.min(this.verbotenAb, stufe);
    }
  }

  private entfernen(k: number): void {
    const blob = this.blobs.get(k);
    if (blob) this.summe -= blob.size;
    this.blobs.delete(k);
    const bild = this.entpackt.holen(k);
    if (bild) {
      this.entpackt.loeschen(k);
      freigeben(bild);
    }
    this.entpackend.delete(k);
  }

  /** Chromium meldet den Heap – ab 80 % wird gespart, ab unter 60 % wieder gefüllt. */
  private druckPruefen(): void {
    if (typeof performance === 'undefined') return;
    const speicher = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;
    if (!speicher || !speicher.jsHeapSizeLimit) return;
    const anteil = speicher.usedJSHeapSize / speicher.jsHeapSizeLimit;
    const knapp = this.ruhegruende.has('speicher');
    if (!knapp && anteil > 0.8) this.speicherKnapp(true);
    else if (knapp && anteil < 0.6) this.speicherKnapp(false);
  }

  /* ---------- Entpacken ---------- */

  private entpackenStarten(k: number): Promise<WischBild | null> {
    const blob = this.blobs.get(k);
    if (!blob) return Promise.resolve(null);
    const generation = this.generation;
    const auftrag: Promise<WischBild | null> = this.entpacker(blob).then(
      (bild) => {
        if (this.entpackend.get(k) === auftrag) this.entpackend.delete(k);
        // Inzwischen geschlossen, ersetzt oder verdrängt: das Bild gehört niemandem mehr.
        if (generation !== this.generation || this.blobs.get(k) !== blob) {
          freigeben(bild);
          return null;
        }
        this.entpackt.ablegen(k, bild, bild.width * bild.height * 4);
        this.haken.entpackt = this.entpackt.anzahl;
        return bild;
      },
      () => {
        if (this.entpackend.get(k) === auftrag) this.entpackend.delete(k);
        if (generation === this.generation) this.verdorbenMelden(k);
        return null;
      },
    );
    this.entpackend.set(k, auftrag);
    return auftrag;
  }

  /** Ein Bild liess sich nicht entpacken: verwerfen und neu lesen – beim zweiten Mal auslassen. */
  private verdorbenMelden(k: number): void {
    const mal = (this.verdorben.get(k) ?? 0) + 1;
    this.verdorben.set(k, mal);
    this.entfernen(k);
    if (mal >= 2) this.aufgegeben.add(k);
    this.aenderung();
    this.wecken();
  }

  /* ---------- Warten und Wecken ---------- */

  private schlafen(): Promise<void> {
    return new Promise((weiter) => {
      this.wecker = weiter;
    });
  }

  private warten(ms: number): Promise<void> {
    return new Promise((weiter) => {
      const zeitgeber = setTimeout(weiter, ms);
      this.wecker = () => {
        clearTimeout(zeitgeber);
        weiter();
      };
    });
  }

  private wecken(): void {
    const weiter = this.wecker;
    this.wecker = null;
    weiter?.();
  }

  /* ---------- Stand melden ---------- */

  private standRechnen(): WischStand {
    const da = (k: number) => this.blobs.has(k);
    const fertig =
      this.film.length > 0 && this.film.every((k) => this.blobs.has(k) || this.aufgegeben.has(k));
    return {
      version: this.version,
      bilder: this.film.reduce((n, k) => n + (this.blobs.has(k) ? 1 : 0), 0),
      von: this.film.length,
      bytes: this.summe,
      stufe: stufeBis(this.film, da, this.schritt),
      fertig,
      verfuegbar: this.verfuegbarFlag,
    };
  }

  /**
   * Höchstens `meldenMs` zwischen zwei Meldungen: Jedes Bild meldete sonst
   * 300 Mal in einer Minute und liess jede Anzeige, die am Stand hängt,
   * neu rechnen. Der Prüfhaken dagegen stimmt immer.
   */
  private aenderung(sofort = false): void {
    const h = this.haken;
    h.verfuegbar = this.verfuegbarFlag;
    h.bytes = this.summe;
    h.bilder = this.blobs.size;
    h.entpackt = this.entpackt.anzahl;
    h.ruhe = [...this.ruhegruende];
    const neu = this.standRechnen();
    h.stufe = neu.stufe;
    h.fertig = neu.fertig;
    const jetzt = Date.now();
    const warten = this.letzteMeldung + this.meldenMs - jetzt;
    if (!sofort && warten > 0) {
      if (!this.meldeZeit) {
        this.meldeZeit = setTimeout(() => {
          this.meldeZeit = null;
          this.aenderung(true);
        }, warten);
      }
      return;
    }
    if (this.meldeZeit) clearTimeout(this.meldeZeit);
    this.meldeZeit = null;
    this.letzteMeldung = jetzt;
    this.version += 1;
    this.standWert = { ...neu, version: this.version };
    for (const rueckruf of [...this.hoerer]) rueckruf();
  }
}

/** Ein kleineres Budget, das ein Test vor dem Anlegen in `window.__wisch.budget` setzt. */
function budgetVonTest(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const haken = (window as unknown as { __wisch?: { budget?: unknown } }).__wisch;
  return typeof haken?.budget === 'number' ? haken.budget : undefined;
}

/** Auf einem Gerät mit wenig Arbeitsspeicher (`deviceMemory`, wo es das gibt) halb so viel. */
function budgetFuerGeraet(): number {
  if (typeof navigator === 'undefined') return WISCH_BUDGET;
  const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return gb !== undefined && gb <= 2 ? WISCH_BUDGET / 2 : WISCH_BUDGET;
}
