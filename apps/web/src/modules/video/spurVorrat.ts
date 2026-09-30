import { filmMarke, type NeueDaten } from './bildweise.js';
import { Kamerapfad } from './kamerapfad.js';
import { BytesLru } from './lru.js';
import type { Richtung, TippPunkte } from './masken.js';
import type { Punkt, SpurRand } from './objektFolge.js';
import { rleDekodieren, rleKodieren, type MaskenMeta } from './rle.js';
import type { Grau } from './verfolgung.js';

/**
 * Was die Verfolgung im Hintergrund gerechnet hat – und wie viel davon im
 * Speicher bleiben darf.
 *
 * Abgeleitete Daten, kein Zustand der Oberfläche: Alles hier lässt sich aus
 * dem Video und den Masken wieder rechnen, und nichts davon wird
 * gespeichert. Es gehört dem `Verfolger` (`verfolger.ts`), einer je Datei,
 * Kante und Bildrate.
 *
 * - `Kette`: je Anker (und Raster, Grösse, Schlüsselabstand) die Masken an
 *   den Filmbildern, als Lauflängen samt Messwerten, dazu die Ränder, an
 *   denen die nächste Spur weitermachen kann.
 * - `Netzvorrat`: rohe Ergebnisse der Freisteller je Verfahren und Bild –
 *   ein Modellauf hängt nur am Bild, nicht an der Kette. Der Grobpass legt
 *   hier ab, und der Feinpass findet es wieder.
 * - `Tiefenvorrat`: Tiefenkarten an Schlüsselbildern, in Graugrösse, geteilt
 *   von jedem Tiefenteil jeder Maske.
 * - `GrauLru`: die Graustufen der zuletzt gelesenen Bilder.
 * - `Kamerapfad`: siehe `kamerapfad.ts`.
 *
 * # Warum ein Budget
 *
 * Weil iOS eine Seite, die zu viel hält, kommentarlos neu lädt – und mit ihr
 * die ganze Bearbeitung. `SPUR_BUDGET` gilt für alles hier zusammen. Wird es
 * überschritten, geht zuerst, was niemand mehr braucht: Ketten ersetzter
 * Anker (die Vorschau zeigt sie noch als „veraltet", aber sie sind
 * entbehrlich), die am längsten nicht gebrauchten zuerst. Dann der
 * Netzvorrat. Reicht auch das nicht, hält die Kette an, die am weitesten von
 * fertig ist, und ihre Bahn sagt warum.
 */

/** Für alle Spuren zusammen. */
export const SPUR_BUDGET = 128 * 1024 * 1024;
/** Für die rohen Ergebnisse der Freisteller. */
export const NETZ_BUDGET = 16 * 1024 * 1024;
/** So viele Graubilder bleiben – bei 320 × 180 rund 5,5 MB. */
export const GRAU_ANZAHL = 96;
/** Was ein Eintrag über seine Nutzdaten hinaus kostet (Objekt, Schlüssel, Messwerte). */
const EINTRAG_BYTES = 96;

/** Grob- oder Feinpass – siehe `kettenPlan`. */
export type Pass = 'grob' | 'fein';

/**
 * Was eine Kette an einem Bild weiss.
 *
 * `verloren`: Ein Tipp hat keine Punkte mehr (alle haben das Bild
 * verlassen) – die Spur kann den Gegenstand nicht wiederfinden, auch wenn er
 * zurückkommt. Die Bahn sagt dort „hier neu antippen" statt „leer".
 */
export type KettenEintrag =
  | { readonly verloren: true; readonly guete: Pass }
  | {
      readonly verloren?: false;
      /** Die geglättete Maske in Rechengrösse als Lauflängen (`rle.ts`). */
      readonly rle: Uint8Array;
      readonly meta: MaskenMeta;
      /** Neu bei jedem Ablegen – die Ersatzidentität für die Zwischenspeicher. */
      readonly marke: number;
      readonly guete: Pass;
      /** Nur Tipp: die Punkte am nächsten Schlüsselbild Richtung Anker. */
      readonly punkte?: TippPunkte;
    };

/**
 * Wo eine Kette in einer Richtung weitermachen kann: der Stand der Spur an
 * einem Schlüsselbild, an dem ein Fenster endete.
 *
 * Dazu die ROHE Maske dort (die geglättete taugt nicht als Anker – eine
 * zweite Glättung über sie hinweg verschmierte die Kante) und die rohe Maske
 * des Nachbarn im alten Fenster: Mit ihr wird das Randbild neu geglättet,
 * sobald der Nachbar auf der anderen Seite bekannt ist (Nahtglättung).
 */
export interface Randzustand {
  readonly k: number;
  readonly rand: SpurRand;
  /** Die rohe Maske an `k`, als Lauflängen. */
  readonly roh: Uint8Array;
  readonly mitte: Punkt | null;
  readonly punkte: readonly Punkt[] | null;
  readonly innen: {
    readonly k: number;
    readonly roh: Uint8Array;
    readonly mitte: Punkt | null;
  } | null;
}

function randBytes(rand: Randzustand): number {
  return EINTRAG_BYTES * 2 + rand.roh.byteLength + (rand.innen?.roh.byteLength ?? 0);
}

function eintragBytes(eintrag: KettenEintrag): number {
  return EINTRAG_BYTES + (eintrag.verloren ? 0 : eintrag.rle.byteLength);
}

/** Die Daten EINES Ankers – der Schlüssel ist `kettenSchluessel`. */
export class Kette {
  private readonly bilder = new Map<number, KettenEintrag>();
  private readonly raender = new Map<string, Map<number, Randzustand>>();
  private summe = 0;
  /** Steigt mit jedem Ablegen – für die Bahnen und den Merkzettel. */
  version = 0;
  /** Wann zuletzt gebraucht (ein Zähler des Vorrats) – für die Verdrängung. */
  zuletzt = 0;
  /** Warum diese Kette nicht weiterkommt – ein Modell fiel aus, der Speicher ist voll. */
  fehler: string | null = null;

  constructor(
    readonly schluessel: string,
    readonly ankerK: number,
  ) {}

  get bytes(): number {
    return this.summe;
  }

  get anzahl(): number {
    return this.bilder.size;
  }

  bild(k: number): KettenEintrag | undefined {
    return this.bilder.get(k);
  }

  /**
   * Ein Bild ablegen – ausser, es läge dort schon Feineres: Der Grobpass
   * überschreibt nie, was der Feinpass (etwa nach einem `vorziehen`) schon
   * gerechnet hat. Gibt zurück, ob abgelegt wurde.
   */
  ablegen(k: number, eintrag: KettenEintrag): boolean {
    const alt = this.bilder.get(k);
    if (alt && alt.guete === 'fein' && eintrag.guete === 'grob') return false;
    if (alt) this.summe -= eintragBytes(alt);
    this.bilder.set(k, eintrag);
    this.summe += eintragBytes(eintrag);
    this.version += 1;
    return true;
  }

  randAblegen(richtung: Richtung, pass: Pass, rand: Randzustand): void {
    const schluessel = `${richtung}|${pass}`;
    let liste = this.raender.get(schluessel);
    if (!liste) {
      liste = new Map();
      this.raender.set(schluessel, liste);
    }
    const alt = liste.get(rand.k);
    if (alt) this.summe -= randBytes(alt);
    liste.set(rand.k, rand);
    this.summe += randBytes(rand);
  }

  rand(richtung: Richtung, pass: Pass, k: number): Randzustand | undefined {
    return this.raender.get(`${richtung}|${pass}`)?.get(k);
  }
}

/**
 * Rohe Ergebnisse der Freisteller, je Verfahren und Quellbild.
 *
 * Ein Modellauf hängt nur am Bild: Motiv an Bild 240 ist Motiv an Bild 240,
 * gleich welche Kette fragt. Der Grobpass legt seine Läufe hier ab, und der
 * Feinpass, dessen Schlüsselbilder die groben einschliessen, rechnet sie
 * nicht noch einmal – zusammen kosten beide so viele Modelläufe wie der
 * Feinpass allein. Nicht für „Antippen": Dessen Maske hängt an den Punkten,
 * und die hängen an der Kette.
 */
export class Netzvorrat {
  private readonly lru: BytesLru<string, Uint8Array>;

  constructor(maxBytes = NETZ_BUDGET) {
    this.lru = new BytesLru(maxBytes);
  }

  hat(verfahren: string, k: number): boolean {
    return this.lru.hat(`${verfahren}|${k}`);
  }

  holen(verfahren: string, k: number, laenge: number): Uint8Array | undefined {
    const rle = this.lru.holen(`${verfahren}|${k}`);
    return rle ? rleDekodieren(rle, laenge) : undefined;
  }

  ablegen(verfahren: string, k: number, maske: Uint8Array): void {
    const rle = rleKodieren(maske);
    this.lru.ablegen(`${verfahren}|${k}`, rle, rle.byteLength + EINTRAG_BYTES);
  }

  /** Das am längsten nicht Gebrauchte vergessen, bis höchstens `bytes` übrig sind. */
  schrumpfen(bytes: number): void {
    this.lru.begrenzen(bytes);
  }

  leeren(): void {
    this.lru.leeren();
  }

  get bytes(): number {
    return this.lru.bytes;
  }
}

/** Eine Tiefenkarte an einem Schlüsselbild – in Graugrösse. */
export interface Tiefenkarte {
  readonly daten: NeueDaten;
  readonly marke: number;
}

/**
 * Tiefenkarten an Schlüsselbildern, geteilt von allen Tiefenteilen.
 *
 * Eine Tiefenkarte beschreibt die SZENE, keinen Gegenstand: Zwei Masken mit
 * Tiefe an denselben Bildern brauchen dieselbe Karte, und ein neuer Anker an
 * einem Tiefenteil ändert an ihr nichts. Abgelegt in Graugrösse (320 × 180
 * bei 16 : 9, 57,6 KB) – für eine Unschärfe, die ohnehin weich verläuft,
 * genug, und bei sechshundert Bildern 8,6 MB statt 90.
 */
export class Tiefenvorrat {
  private readonly karten = new Map<number, Tiefenkarte>();
  private summe = 0;

  hat(k: number): boolean {
    return this.karten.has(k);
  }

  holen(k: number): Tiefenkarte | undefined {
    return this.karten.get(k);
  }

  ablegen(k: number, daten: NeueDaten): Tiefenkarte {
    const alt = this.karten.get(k);
    if (alt) this.summe -= alt.daten.werte.byteLength + EINTRAG_BYTES;
    const karte = { daten, marke: filmMarke() };
    this.karten.set(k, karte);
    this.summe += daten.werte.byteLength + EINTRAG_BYTES;
    return karte;
  }

  leeren(): void {
    this.karten.clear();
    this.summe = 0;
  }

  get bytes(): number {
    return this.summe;
  }
}

/**
 * Die Graustufen der zuletzt gelesenen Bilder – geteilt von allen Fenstern.
 *
 * Abgelegt als ganze Zahlen (ein Byte statt vier je Punkt), und JEDES Grau,
 * das in eine Spur geht, kommt auf diese ganzen Zahlen gerundet – auch das
 * frisch gelesene. Sonst hinge das Ergebnis einer Spur davon ab, ob ihre
 * Graustufen gerade aus dem Speicher kamen oder neu gelesen wurden.
 */
export class GrauLru {
  private readonly lru: BytesLru<number, { breite: number; hoehe: number; werte: Uint8Array }>;

  constructor(
    private readonly anzahl = GRAU_ANZAHL,
    groesse = 320 * 180,
  ) {
    this.lru = new BytesLru(anzahl * (groesse + EINTRAG_BYTES));
  }

  holen(k: number): Grau | undefined {
    const g = this.lru.holen(k);
    if (!g) return undefined;
    return { breite: g.breite, hoehe: g.hoehe, werte: Float32Array.from(g.werte) };
  }

  hat(k: number): boolean {
    return this.lru.hat(k);
  }

  /** Ablegen – und das gerundete Grau zurück, das die Spur bekommt. */
  ablegen(k: number, grau: Grau): Grau {
    const werte = new Uint8Array(grau.werte.length);
    for (let i = 0; i < werte.length; i += 1) {
      werte[i] = Math.max(0, Math.min(255, Math.round(grau.werte[i])));
    }
    this.lru.ablegen(
      k,
      { breite: grau.breite, hoehe: grau.hoehe, werte },
      werte.byteLength + EINTRAG_BYTES,
    );
    return { breite: grau.breite, hoehe: grau.hoehe, werte: Float32Array.from(werte) };
  }

  leeren(): void {
    this.lru.leeren();
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  get kapazitaet(): number {
    return this.anzahl;
  }
}

/** Alles zusammen, mit einem Budget. */
export class Vorrat {
  readonly netz: Netzvorrat;
  readonly tiefe = new Tiefenvorrat();
  readonly grau: GrauLru;
  kamera = new Kamerapfad();
  private readonly ketten = new Map<string, Kette>();
  private aktuell = new Set<string>();
  private uhr = 0;

  constructor(
    readonly budget = SPUR_BUDGET,
    grauGroesse = 320 * 180,
    netzBudget = NETZ_BUDGET,
  ) {
    this.grau = new GrauLru(GRAU_ANZAHL, grauGroesse);
    this.netz = new Netzvorrat(netzBudget);
  }

  /** Die Kette zu diesem Schlüssel – angelegt, wenn es sie noch nicht gibt. */
  kette(schluessel: string, ankerK: number): Kette {
    let kette = this.ketten.get(schluessel);
    if (!kette) {
      kette = new Kette(schluessel, ankerK);
      this.ketten.set(schluessel, kette);
    }
    this.uhr += 1;
    kette.zuletzt = this.uhr;
    return kette;
  }

  /** Eine vorhandene Kette – auch eine ersetzte, solange sie nicht verdrängt ist. */
  holen(schluessel: string): Kette | undefined {
    const kette = this.ketten.get(schluessel);
    if (kette) {
      this.uhr += 1;
      kette.zuletzt = this.uhr;
    }
    return kette;
  }

  /** Welche Ketten die Masken gerade brauchen – alle anderen sind ersetzt. */
  aktuellSetzen(schluessel: Iterable<string>): void {
    this.aktuell = new Set(schluessel);
  }

  istAktuell(schluessel: string): boolean {
    return this.aktuell.has(schluessel);
  }

  get anzahlKetten(): number {
    return this.ketten.size;
  }

  get bytes(): number {
    let summe = this.netz.bytes + this.tiefe.bytes + this.grau.bytes + this.kamera.bytes;
    for (const kette of this.ketten.values()) summe += kette.bytes;
    return summe;
  }

  /**
   * Unter das Budget kommen – in der Reihenfolge aus dem Kopf.
   *
   * Gibt die Schlüssel der Ketten zurück, die anhalten müssen, weil selbst
   * die gebrauchten allein zu viel sind: die, die am weitesten von fertig ist
   * (`fertig` je Schlüssel, 0 … 1), eine nach der anderen, bis der Rest ins
   * Budget passte. Angehaltene wachsen nicht mehr; was sie haben, bleibt.
   */
  aufraeumen(fertig: (schluessel: string) => number = () => 0): string[] {
    let zuviel = this.bytes - this.budget;
    if (zuviel <= 0) return [];
    const ersetzt = [...this.ketten.values()]
      .filter((kette) => !this.aktuell.has(kette.schluessel))
      .sort((a, b) => a.zuletzt - b.zuletzt);
    for (const kette of ersetzt) {
      if (zuviel <= 0) break;
      this.ketten.delete(kette.schluessel);
      zuviel -= kette.bytes;
    }
    if (zuviel > 0) {
      const netz = this.netz.bytes;
      this.netz.schrumpfen(Math.max(0, netz - zuviel));
      zuviel -= netz - this.netz.bytes;
    }
    if (zuviel <= 0) return [];
    const gebraucht = [...this.ketten.values()]
      .filter((kette) => kette.fehler === null)
      .sort((a, b) => fertig(a.schluessel) - fertig(b.schluessel));
    const anhalten: string[] = [];
    for (const kette of gebraucht) {
      if (zuviel <= 0) break;
      anhalten.push(kette.schluessel);
      zuviel -= kette.bytes;
    }
    return anhalten;
  }

  leeren(): void {
    this.ketten.clear();
    this.aktuell.clear();
    this.netz.leeren();
    this.tiefe.leeren();
    this.grau.leeren();
    this.kamera = new Kamerapfad();
  }
}
