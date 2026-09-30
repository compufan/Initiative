import { PRUEFMASS, maskePasst, maskeVerschieben, type Grau } from './verfolgung.js';

/**
 * Eine Maske, die ihrem GEGENSTAND folgt – nicht der Kamera.
 *
 * # Was vorher falsch war
 *
 * Drei Dinge, alle nachgemessen an einer roten Scheibe, die vor einem
 * ruhenden, gemusterten Hintergrund wandert (echte Farbflutung, 320 × 180):
 *
 * 1. Angetippte Punkte wurden mit der Bewegung des GANZEN Bildes mitgezogen.
 *    Bei ruhender Kamera ist das keine – der Punkt blieb, wo getippt wurde,
 *    und die Flutung griff nach dem Hintergrund, sobald die Scheibe weg war.
 * 2. Zwischen den Schlüsselbildern wurde die Maske ebenfalls mit der
 *    Bildbewegung geschoben, also gar nicht.
 * 3. Die Plausibilitätsprüfung verglich jedes frische Schlüsselbild mit der
 *    Maske am Anfang des Stücks. Sobald der Gegenstand weiter als rund 70 %
 *    seiner eigenen Breite von dort weg war, galt jede richtige Maske als
 *    unplausibel – und die Startmaske blieb stehen, für immer.
 *
 * Mittlere Deckung mit der Wahrheit: 0,56 bei einem Punkt je Bild, 0,19 bei
 * drei Punkten je Bild.
 *
 * # Wie der Gegenstand gefunden wird
 *
 * Nicht über die Blöcke der Bewegungssuche. Die sind 24 Graupunkte gross,
 * und ein Gegenstand von der Grösse einer Hand liegt in kaum einem davon
 * ganz – der Rest des Blocks ist ruhender Hintergrund und stimmt für
 * Stillstand. Nachgemessen: Eine Scheibe von 44 Punkten, die 4 Punkte je
 * Bild wandert, kam aus den Blöcken in ihr mit −3,7, −2,0, −0,3 heraus.
 *
 * Stattdessen wird die MASKE SELBST gesucht: die Bildpunkte unter ihr, im
 * nächsten Bild an der Stelle, an der sie am besten passen. Das trägt auch
 * einen einfarbigen Gegenstand – seine Kante verrät ihn –, solange er sich
 * vom Hintergrund abhebt. Wo nichts eindeutig passt, trägt die zuletzt
 * gemessene Geschwindigkeit.
 *
 * # Der Weg von Schlüsselbild zu Schlüsselbild
 *
 * - **Vorhersage**: die Maske Bild für Bild gesucht, bis zum nächsten
 *   Schlüsselbild.
 * - **Punkte**: um denselben Weg mitgezogen und in die erwartete Maske
 *   eingerastet. Wer dabei das Bild verlässt, fällt weg.
 * - **Prüfung**: die frische Maske gegen die VORHERGESAGTE. Ein Leck oder
 *   ein Aussetzer fällt so weiterhin auf; ein Gegenstand, der sich bewegt,
 *   nicht mehr.
 * - **Dazwischen**: die beiden umgebenden Schlüsselmasken, jede um den
 *   gesuchten Weg ab IHREM Schlüsselbild geschoben und nach Nähe gemischt.
 *
 * # Was die Prüfung zusätzlich abfängt
 *
 * Nachgetragen nach einer Gegenlesung, jeder Punkt nachgestellt:
 *
 * - **Ein Gegenstand läuft aus dem Bild.** Die Punkte blieben am Rand
 *   stehen, die Flutung griff dort nach dem Hintergrund, und nach drei
 *   Ablehnungen galt das Leck – 83 % des Bildes bis zum Ende. Jetzt fallen
 *   die Punkte weg, und eine leere Maske am Rand, in Laufrichtung, gilt
 *   sofort.
 * - **Ein Leck, das bleibt.** Eine Maske, die um mehr als das Dreifache
 *   wächst oder schrumpft, wird nie mehr durch blosses Warten angenommen.
 * - **Drift.** Jeder Schritt misst nur gegen den vorigen; ein Modell, das
 *   bei ruhendem Bild jedes Mal fünf Punkte daneben liegt, kam so über das
 *   halbe Bild. Deshalb wird aufsummiert, wie weit die angenommenen Masken
 *   von dem abweichen, was die Suche im Bild sah – mehr als 40 % der
 *   Ausdehnung des Gegenstandes, und die Maske gilt nicht.
 *
 * Eine Spur kann in beide Richtungen laufen: Angetippt wird an einem
 * beliebigen Bild (dem ANKER), verfolgt wird von dort rückwärts bis zum
 * Anfang und vorwärts bis zum Ende ihres Laufs.
 *
 * # In Fenstern (die Verfolgung im Hintergrund, `maskenVerfolgen.ts`)
 *
 * Eine Spur über sechshundert Bilder hielte alle ihre Masken zugleich. Die
 * Verfolgung im Hintergrund rechnet deshalb in FENSTERN von rund zwanzig
 * Bildern, und jedes setzt dort an, wo das vorige aufhörte:
 *
 * - `randAn(schlüsselbild)` gibt den Stand der Spur an einem gerechneten
 *   Schlüsselbild heraus – Geschwindigkeit, Ablehnungen, die letzte Fläche,
 *   die Drift, seit wann der Gegenstand fehlt.
 * - `fortsetzung` setzt die nächste Spur mit genau diesem Stand an, statt
 *   mit den Vorgaben eines Ankers. Ohne sie begänne jedes Fenster mit der
 *   Fläche, die gerade zu sehen ist – nach einer leeren Maske also mit null,
 *   und jedes Leck wäre willkommen.
 * - `maskeBild(i)` liefert das Ergebnis Bild für Bild, damit der Aufrufer
 *   zwischen zwei Bildern die Seite zu Wort kommen lassen kann und für
 *   Brückenbilder gar keine Maske baut.
 *
 * # Wenn der Gegenstand geht, geht die Maske mit (`wiederBilder`)
 *
 * Nachgestellt an einem Freisteller, der immer „das Auffälligste" liefert
 * (u²-Net, BiRefNet): Verlässt der verfolgte Gegenstand das Bild, liefert er
 * nie eine leere Maske, sondern den NÄCHSTEN Gegenstand. Der kam auf zwei
 * Wegen durch: Lag die Vorhersage schon ganz ausserhalb, liess
 * `maskePasst` alles gelten; lag sie halb drin, galt das Fremde nach zwei
 * Ablehnungen. Die Maske sprang auf einen anderen Gegenstand – genau das,
 * was der Anwender nicht will.
 *
 * Mit `wiederBilder` wird deshalb jede frische Maske VOR jeder Prüfung auf
 * ihre Zusammenhangskomponenten zurückgeschnitten (`komponentenFiltern`):
 * Es bleibt nur, was die um die Hälfte gedehnte Vorhersage trifft – oder,
 * solange der Gegenstand fehlt, was vom Bildrand hereinkommt oder dort
 * auftaucht, wo er nach seiner letzten Geschwindigkeit sein müsste, und das
 * höchstens `wiederBilder` Bilder lang. Bleibt nichts, ist die Maske leer.
 * Das gilt für jeden Weg, auf dem eine Maske angenommen wird, auch für das
 * Nachgeben nach zwei Ablehnungen. Nur für Motiv und BiRefNet: Eine andere
 * Person ist immer noch „Person", und ein Tipp hat nach dem Austritt keine
 * Punkte mehr.
 *
 * Gemessen wird dabei am KERN (Deckung ab der Hälfte), nicht an allem über
 * null: Freisteller legen einen Dunst über das ganze Bild, und ein Kasten um
 * alles über null war das ganze Bild – dann traf jeder Gegenstand die
 * Vorhersage. Aus demselben Grund geht Blasses weit weg von jedem
 * behaltenen Kern immer, auch aus der Anfangsmaske.
 */

export interface Punkt {
  readonly x: number;
  readonly y: number;
}

/** Das Rechteck, in dem eine Maske überhaupt etwas hat – einschliesslich. */
export interface Kasten {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Der Stand einer Spur an einem gerechneten Schlüsselbild – alles, was die
 * nächste Spur braucht, um dort weiterzumachen, als liefe sie ohne Pause.
 *
 * Die Maske selbst steht nicht darin: Die kommt als `ankerMaske` (roh, so wie
 * die Spur sie an diesem Bild angenommen hat), die Punkte als `punkte`.
 * Alles hier ist unabhängig davon, an welcher Stelle eines Fensters das Bild
 * steht – deshalb `abwesendSeit` als Abstand und nicht als Bildnummer.
 */
export interface SpurRand {
  /** Weg je Bild in Laufrichtung, gemessen an den angenommenen Masken. */
  readonly tempo: Punkt | null;
  readonly abgelehnt: number;
  /** Die Fläche der letzten nicht leeren Maske – gegen ein Leck nach einer leeren. */
  readonly flaeche: number;
  readonly drift: Punkt;
  readonly vomAnker: Punkt;
  /**
   * Vor wie vielen Bildern ein Modell den Gegenstand zuletzt BESTÄTIGT hat –
   * `null`, wenn es das an diesem Bild tat.
   *
   * Bestätigt heisst: eine frische Maske, nicht leer, angenommen. Eine
   * Vorhersage, die nach einer Ablehnung weiterläuft, zählt nicht: Während
   * einer Verdeckung sieht die Suche den Verdecker oder den Grund, meldet
   * „steht still", und eine Vorhersage daraus bliebe an der Stelle stehen,
   * an der der Gegenstand verschwand.
   */
  readonly abwesendSeit: number | null;
  /**
   * Wo er zuletzt bestätigt wurde: der Kasten des KERNS dieser Maske
   * (`Vermessung.kern`) – nicht ihres Dunstes.
   */
  readonly letzterKasten: Kasten | null;
  /** Und wie schnell er dort war – daraus, wo er jetzt sein müsste. */
  readonly letztesTempo: Punkt | null;
}

export interface SpurAuftrag {
  /** Die Graustufenbilder, wie `graustufen` sie liefert – alle gleich gross. */
  readonly grau: readonly Grau[];
  readonly breite: number;
  readonly hoehe: number;
  /** Erstes und letztes Bild des Laufs, einschliesslich; kein Schnitt dazwischen. */
  readonly von: number;
  readonly bis: number;
  /** Wo das Teil festgelegt wurde – dort gelten seine Punkte. */
  readonly anker: number;
  /** Die Schlüsselbilder IM Lauf. `von`, `bis` und `anker` kommen von selbst dazu. */
  readonly schluessel: Iterable<number>;
  /** Angetippte Punkte am Anker – `null` für ein Teil ohne Punkte (Netz). */
  readonly punkte: readonly Punkt[] | null;
  /**
   * Die Maske am Anker, falls sie schon feststeht – dann wird dort nicht
   * gerechnet. So kommt sie aus dem Editor: genau die, die der Anwender
   * gesehen hat.
   */
  readonly ankerMaske?: Uint8Array;
  /**
   * Der Stand, mit dem die Spur am Anker ansetzt – aus `randAn` einer
   * vorigen Spur. Ohne Angabe gelten die Vorgaben eines echten Ankers.
   */
  readonly fortsetzung?: SpurRand;
  /**
   * Wie viele Bilder ein Gegenstand fehlen darf und trotzdem dort
   * wiedergefunden wird, wo er zu erwarten ist – und zugleich der Schalter
   * für den Komponentenfilter (siehe Kopf). Ohne Angabe: wie bisher.
   */
  readonly wiederBilder?: number;
  /**
   * Rechnet die frische Maske an einem Schlüsselbild.
   *
   * `weg` ist, wie weit der Gegenstand seit dem Anker gewandert sein
   * sollte – für Punkte, die die Spur nicht selbst führt (die Tipps beim GIF,
   * die zu einer anderen Maske gehören als der verfolgten).
   */
  readonly rechnen: (
    bild: number,
    punkte: readonly Punkt[] | null,
    weg: { readonly x: number; readonly y: number },
  ) => Promise<Uint8Array>;
}

export interface SpurErgebnis {
  /** Eine Maske je Bild von `von` bis `bis`. */
  readonly masken: Uint8Array[];
  /** Je Bild der Weg der Maske vom Bild davor – für `bewegtGlaetten`. */
  readonly versatz: { x: number; y: number }[];
  /** Wie oft eine frische Maske der Vorhersage weichen musste. */
  readonly verworfen: number;
}

interface Ort {
  readonly x: number;
  readonly y: number;
}

export interface Mitte extends Ort {
  readonly flaeche: number;
}

/** Was an einer Maske gebraucht wird, in EINEM Durchgang gemessen. */
interface Vermessung {
  /** Schwerpunkt, nach Deckung gewichtet – `null` für eine leere Maske. */
  readonly mitte: Mitte | null;
  /** Wo überhaupt etwas ist (Deckung über null) – `null` für eine leere Maske. */
  readonly kasten: Kasten | null;
  /**
   * Wo der KERN ist (Deckung ab `KERN_AB`) – `null`, wenn es keinen gibt.
   *
   * # Warum nicht `kasten`
   *
   * Für alles, was nach dem GEGENSTAND fragt (die Vorhersage des
   * Komponentenfilters, `letzterKasten`), taugt `kasten` nicht: Ein
   * Freisteller liefert ausserhalb des Gegenstands selten genau null, sondern
   * einen Dunst von ein paar Stufen über das ganze Bild. Ein einziger solcher
   * Bildpunkt in der Ecke dehnte `kasten` über das Bild – dann traf jede
   * Komponente die Vorhersage, und der Filter liess den nächsten Gegenstand
   * durch, sobald der verfolgte ging. Nachgestellt mit Dunst 1 … 12:
   * Ab dem Austritt lag die Maske ganz auf dem Fremden.
   */
  readonly kern: Kasten | null;
  /** An welchen Rändern die Maske (ab halber Deckung) anstösst. */
  readonly rand: { links: boolean; rechts: boolean; oben: boolean; unten: boolean };
}

interface Stand {
  bild: number;
  maske: Uint8Array;
  mass: Vermessung;
  punkte: Punkt[] | null;
  /** Weg je Bild in Laufrichtung, gemessen an den angenommenen Masken. */
  tempo: Ort | null;
  abgelehnt: number;
  /** Die Fläche der letzten nicht leeren Maske – gegen ein Leck nach einer leeren. */
  flaeche: number;
  /** Wie weit die angenommenen Masken von dem abgewichen sind, was die Suche sah. */
  drift: Ort;
  /** Wie weit der Gegenstand seit dem Anker gewandert ist. */
  vomAnker: Ort;
  /** Siehe `SpurRand`. */
  abwesendSeit: number | null;
  letzterKasten: Kasten | null;
  letztesTempo: Ort | null;
}

/** Was zwischen zwei Schlüsselbildern gebraucht wird – einmal je Strecke gemessen. */
interface Strecke {
  readonly a: number;
  readonly b: number;
  readonly ma: Vermessung;
  readonly mb: Vermessung;
  readonly massstab: number;
  readonly nurA: boolean;
  readonly nurB: boolean;
}

/** Ein Zwischenbild: wo der Gegenstand steht, gemessen ab beiden Enden seines Abschnitts. */
interface Zwischen {
  /** Das Schlüsselbild, von dem aus gesucht wurde. */
  readonly start: number;
  readonly vomStart: Ort;
  readonly vomEnde: Ort;
}

/**
 * Nach so vielen Ablehnungen in Folge gilt die frische Maske trotzdem – aber
 * nur, wenn sie an der Lage scheitert, nicht an der Grösse. Sonst hielte ein
 * einziger Fehlgriff der Vorhersage die Maske für den Rest des Films fest;
 * genau das war Fehler 3 oben.
 */
const NACH_ABLEHNUNGEN = 2;
/** Höchstens so viele Bildpunkte der Maske gehen in die Suche; mehr bringt keine Genauigkeit. */
const PROBEN_MAX = 900;
/** Suchweite je Bild, in Graupunkten – 42 Bildpunkte bei 960 Breite. */
const SUCHWEITE = 14;
/**
 * Mehr als diesen Anteil seiner Ausdehnung – je Achse – darf die Maske
 * nicht von der Suche wegdriften.
 *
 * Je Achse, weil ein schmaler, hoher Gegenstand (eine Person) seitlich viel
 * weniger Spiel hat als der Länge nach. Ein Wert unter einer halben Breite,
 * weil eine Person, die den Arm hebt, ihren Schwerpunkt um ein Fünftel bis
 * ein Viertel verschiebt – das soll gelten, ein Weggleiten nicht.
 */
const DRIFT_ANTEIL = 0.4;
/** … und nie weniger als so viele Bildpunkte – ein kleiner Gegenstand zittert sonst ständig darüber. */
const DRIFT_MINDEST = 6;

export class Spur {
  private readonly schluessel: number[];
  private readonly masken = new Map<number, Uint8Array>();
  private readonly messungen = new Map<number, Vermessung>();
  private readonly punkteJe = new Map<number, Punkt[] | null>();
  private readonly zwischen = new Map<number, Zwischen>();
  /** Der Stand an jedem gerechneten Schlüsselbild – für `randAn`. */
  private readonly staende = new Map<number, Stand>();
  private readonly strecken = new Map<number, Strecke>();
  private leerFeld: Uint8Array | null = null;
  private anfang: Stand | null = null;
  private readonly rueck: number[];
  private readonly vor: number[];
  private stand: Stand | null = null;
  private richtung: 1 | -1 = -1;
  private readonly faktor: number;
  verworfen = 0;

  constructor(private readonly auftrag: SpurAuftrag) {
    const menge = new Set<number>();
    for (const k of auftrag.schluessel) if (k >= auftrag.von && k <= auftrag.bis) menge.add(k);
    menge.add(auftrag.von);
    menge.add(auftrag.bis);
    menge.add(auftrag.anker);
    this.schluessel = [...menge].sort((a, b) => a - b);
    this.rueck = this.schluessel.filter((k) => k < auftrag.anker).reverse();
    this.vor = this.schluessel.filter((k) => k > auftrag.anker);
    this.faktor = auftrag.breite / (auftrag.grau[auftrag.anker]?.breite || auftrag.breite);
  }

  /** Alle Schlüsselbilder dieser Spur, aufsteigend. */
  plan(): readonly number[] {
    return this.schluessel;
  }

  /** Das nächste Schlüsselbild, das diese Spur braucht – `null`, wenn fertig. */
  naechstes(): number | null {
    if (!this.anfang) return this.auftrag.anker;
    if (this.rueck.length > 0) return this.rueck[0];
    if (this.vor.length > 0) return this.vor[0];
    return null;
  }

  /**
   * Bis wohin (ausschliesslich) diese Spur ihre Bilder schon kennt.
   *
   * Eine FERTIGE Spur begrenzt nichts mehr: Ihr Ende lag vor dem der
   * anderen, und als Grenze gezählt hielte sie die Meldung „so weit ist der
   * Film fertig" beim ersten Schnitt fest – das Angebot, aus den fertigen
   * Bildern trotzdem einen Film zu machen, wäre viel zu kurz ausgefallen.
   */
  fertigBis(): number {
    if (!this.anfang || this.rueck.length > 0) return this.auftrag.von;
    if (this.vor.length === 0) return Number.POSITIVE_INFINITY;
    return this.stand ? this.stand.bild + 1 : this.auftrag.von;
  }

  /** Die Maske an einem schon gerechneten Schlüsselbild. */
  maskeAn(bild: number): Uint8Array {
    return this.masken.get(bild) ?? new Uint8Array(this.auftrag.breite * this.auftrag.hoehe);
  }

  /** Die mitgewanderten Punkte an einem schon gerechneten Schlüsselbild. */
  punkteAn(bild: number): Punkt[] | null {
    return this.punkteJe.get(bild) ?? null;
  }

  /**
   * Der Stand an einem schon gerechneten Schlüsselbild – `null` an jedem
   * anderen Bild. Zusammen mit `maskeAn` und `punkteAn` genau das, was eine
   * nächste Spur als `fortsetzung` braucht, um dort weiterzumachen.
   */
  randAn(bild: number): SpurRand | null {
    const stand = this.staende.get(bild);
    if (!stand) return null;
    return {
      tempo: stand.tempo,
      abgelehnt: stand.abgelehnt,
      flaeche: stand.flaeche,
      drift: stand.drift,
      vomAnker: stand.vomAnker,
      abwesendSeit: stand.abwesendSeit,
      letzterKasten: stand.letzterKasten,
      letztesTempo: stand.letztesTempo,
    };
  }

  /** Das nächste Schlüsselbild rechnen. */
  async schritt(): Promise<void> {
    const { auftrag } = this;
    if (!this.anfang) {
      const { breite, hoehe } = auftrag;
      const vorgabe = auftrag.ankerMaske;
      const roh =
        vorgabe && vorgabe.length === breite * hoehe
          ? vorgabe
          : await auftrag.rechnen(auftrag.anker, auftrag.punkte, { x: 0, y: 0 });
      /*
       * Mit `wiederBilder` auch die Anfangsmaske ohne ihren Dunst: Jeder Kern
       * bleibt (der Anwender hat sie so angenommen), aber ein Hauch über dem
       * ganzen Bild zöge den Schwerpunkt zur Bildmitte – mit Dunst 3 bei
       * 320 × 120 um 17 Punkte, mehr als der Halbmesser der verfolgten
       * Scheibe –, und die Bilder bis zum ersten Schlüsselbild würden
       * dorthin überblendet.
       */
      const maske =
        auftrag.wiederBilder !== undefined
          ? komponentenFiltern(
              roh,
              breite,
              hoehe,
              [{ x0: 0, y0: 0, x1: breite - 1, y1: hoehe - 1 }],
              false,
            )
          : roh;
      const mass = vermessen(maske, breite, hoehe);
      /*
       * Eine Fortsetzung bringt den Stand mit, den die vorige Spur an diesem
       * Bild hatte. Ein echter Anker beginnt bei null – ausser bei der
       * Fläche: Die eines Ankers ist die, die er zeigt.
       */
      const f = auftrag.fortsetzung;
      this.anfang = {
        bild: auftrag.anker,
        maske,
        mass,
        punkte: auftrag.punkte ? [...auftrag.punkte] : null,
        tempo: f ? f.tempo : null,
        abgelehnt: f ? f.abgelehnt : 0,
        flaeche: f ? f.flaeche : (mass.mitte?.flaeche ?? 0),
        drift: f ? f.drift : { x: 0, y: 0 },
        vomAnker: f ? f.vomAnker : { x: 0, y: 0 },
        abwesendSeit: f ? f.abwesendSeit : mass.mitte ? null : 0,
        letzterKasten: f ? f.letzterKasten : mass.mitte ? gegenstandKasten(mass) : null,
        letztesTempo: f ? f.letztesTempo : null,
      };
      this.merken(auftrag.anker, this.anfang);
      this.stand = { ...this.anfang };
      this.richtung = this.rueck.length > 0 ? -1 : 1;
      return;
    }
    const rueckwaerts = this.rueck.length > 0;
    const richtung: 1 | -1 = rueckwaerts ? -1 : 1;
    if (richtung !== this.richtung) {
      // Vorwärts beginnt wieder am Anker, nicht dort, wo rückwärts aufhörte.
      this.richtung = richtung;
      this.stand = { ...(this.anfang as Stand) };
    }
    const ziel = (rueckwaerts ? this.rueck : this.vor).shift() as number;
    this.stand = await this.weiter(this.stand as Stand, ziel);
    this.merken(ziel, this.stand);
  }

  private merken(bild: number, stand: Stand) {
    this.masken.set(bild, stand.maske);
    this.messungen.set(bild, stand.mass);
    this.punkteJe.set(bild, stand.punkte ? [...stand.punkte] : null);
    this.staende.set(bild, stand);
  }

  /**
   * Die frische Maske auf das zurückschneiden, was zum verfolgten Gegenstand
   * gehören kann – siehe den Kopf der Datei.
   *
   * - Ist er da: was die um die Hälfte gedehnte Vorhersage trifft. Ein
   *   Gegenstand, der vom Rand hereinkommt, während der verfolgte noch im
   *   Bild ist, ist ein ANDERER.
   * - Fehlt er: was vom Bildrand hereinkommt (er kommt zurück), oder was
   *   dort auftaucht, wo er nach seiner letzten Geschwindigkeit sein müsste
   *   – das aber nur `wiederBilder` Bilder lang. Eine Verdeckung von einer
   *   Sekunde übersteht die Maske so, ein Gegenstand, der drei Sekunden
   *   später irgendwo in der Mitte steht, ist ein anderer.
   * - War nie etwas zu sehen, gibt es nichts, woran zu messen wäre: Die
   *   Maske bleibt, wie sie ist.
   */
  private filtern(
    frisch: Uint8Array,
    alt: Stand,
    erwartetKasten: Kasten | null,
    schritte: number,
  ): Uint8Array {
    const { breite, hoehe } = this.auftrag;
    const wiederBilder = this.auftrag.wiederBilder ?? 0;
    if (alt.mass.mitte) {
      return komponentenFiltern(
        frisch,
        breite,
        hoehe,
        erwartetKasten ? [kastenDehnen(erwartetKasten, 0.5)] : [],
        false,
      );
    }
    if (!alt.letzterKasten) return frisch;
    const seit = (alt.abwesendSeit ?? 0) + schritte;
    const stellen: Kasten[] = [];
    if (seit <= wiederBilder) {
      const tempo = alt.letztesTempo ?? { x: 0, y: 0 };
      const k = alt.letzterKasten;
      stellen.push(
        kastenDehnen(
          {
            x0: k.x0 + tempo.x * seit,
            y0: k.y0 + tempo.y * seit,
            x1: k.x1 + tempo.x * seit,
            y1: k.y1 + tempo.y * seit,
          },
          0.5,
        ),
      );
    }
    return komponentenFiltern(frisch, breite, hoehe, stellen, true);
  }

  private async weiter(alt: Stand, ziel: number): Promise<Stand> {
    const { breite, hoehe } = this.auftrag;
    const { weg, sicher } = this.suchen(alt, ziel);
    const gesamt = weg[weg.length - 1];
    const erwartet = maskeVerschieben(alt.maske, breite, hoehe, gesamt.x, gesamt.y);
    const altMitte = alt.mass.mitte;

    /*
     * Die Punkte wandern mit. Wer dabei das Bild verlässt, fällt WEG und
     * wird nicht an den Rand geklemmt: Dort läge er auf dem Hintergrund,
     * und die Flutung griffe nach allem, was dieselbe Farbe hat.
     */
    let punkte: Punkt[] | null = null;
    if (alt.punkte) {
      punkte = [];
      for (const p of alt.punkte) {
        const x = p.x + gesamt.x;
        const y = p.y + gesamt.y;
        if (x < 0 || y < 0 || x > breite - 1 || y > hoehe - 1) continue;
        punkte.push(
          altMitte ? einrasten({ x, y }, erwartet, breite, hoehe, altMitte.flaeche) : { x, y },
        );
      }
    }
    // Alle Punkte draussen: Der Gegenstand ist es auch. Nichts zu fluten.
    const ohnePunkte = punkte !== null && punkte.length === 0;
    const schritteGesamt = Math.abs(ziel - alt.bild);
    const filtern = this.auftrag.wiederBilder !== undefined;
    /*
     * Wo die Vorhersage liegt – verschoben wie `maskeVerschieben`, auf das
     * Bild beschnitten. Der Kasten des KERNS, nicht der ganzen Maske: siehe
     * `Vermessung.kern`.
     */
    const altKasten = filtern ? gegenstandKasten(alt.mass) : null;
    const erwartetKasten = altKasten
      ? kastenImBild(
          {
            x0: altKasten.x0 + Math.round(gesamt.x),
            y0: altKasten.y0 + Math.round(gesamt.y),
            x1: altKasten.x1 + Math.round(gesamt.x),
            y1: altKasten.y1 + Math.round(gesamt.y),
          },
          breite,
          hoehe,
        )
      : null;
    let frisch = ohnePunkte
      ? new Uint8Array(breite * hoehe)
      : await this.auftrag.rechnen(ziel, punkte, {
          x: alt.vomAnker.x + gesamt.x,
          y: alt.vomAnker.y + gesamt.y,
        });
    /*
     * VOR jeder Prüfung, damit jeder Weg zur Annahme – auch das Nachgeben
     * nach zwei Ablehnungen – nur noch sieht, was zum Gegenstand gehören
     * kann. Siehe den Kopf der Datei.
     */
    if (filtern && !ohnePunkte) frisch = this.filtern(frisch, alt, erwartetKasten, schritteGesamt);
    const frischMass = vermessen(frisch, breite, hoehe);
    const frischMitte = frischMass.mitte;

    let annehmen: boolean;
    let neuDrift: Ort = alt.drift;
    if (ohnePunkte) {
      annehmen = true;
    } else if (!altMitte) {
      /*
       * Nach einer leeren Maske gibt es nichts zu vergleichen – aber eine
       * Grösse, die der Gegenstand zuletzt hatte. Ein Tipp, dessen
       * Gegenstand verdeckt ist, flutet sonst den Verdecker, und das ohne
       * jede Prüfung.
       */
      annehmen =
        !frischMitte || alt.flaeche <= 0 || frischMitte.flaeche <= PRUEFMASS.flaeche * alt.flaeche;
    } else if (!frischMitte && hinaus(alt, gesamt)) {
      // Am Rand und in Laufrichtung verschwunden: Er ist hinausgelaufen.
      annehmen = true;
    } else {
      /*
       * Liegt die Vorhersage ganz ausserhalb, liesse `maskePasst` alles
       * gelten („nichts zu vergleichen"). Hier gibt es aber etwas: Der
       * Gegenstand WAR da und müsste jetzt draussen sein. Was trotzdem im
       * Bild auftaucht, ist ein anderer – es hält nicht, und auch Warten
       * macht es nicht passend.
       */
      const befund =
        filtern && !erwartetKasten && frischMitte
          ? { haelt: false, verhaeltnis: Infinity, deckung: 0 }
          : maskePasst(frisch, erwartet);
      /*
       * Die Drift zählt auch dann, wenn die frische Maske ohnehin nicht
       * passt: Sonst nähme das Nachgeben unten nach zwei Ablehnungen genau
       * die Maske an, die am weitesten weggeglitten ist.
       */
      let driftZuGross = false;
      if (sicher && frischMitte) {
        const k = korrektur(altMitte, gesamt, frischMitte, alt.mass, frischMass);
        neuDrift = { x: alt.drift.x + k.x, y: alt.drift.y + k.y };
        const kasten = alt.mass.kasten;
        const weit = kasten ? kasten.x1 - kasten.x0 + 1 : Math.sqrt(altMitte.flaeche);
        const hoch = kasten ? kasten.y1 - kasten.y0 + 1 : Math.sqrt(altMitte.flaeche);
        driftZuGross =
          Math.abs(neuDrift.x) > Math.max(DRIFT_MINDEST, DRIFT_ANTEIL * weit) ||
          Math.abs(neuDrift.y) > Math.max(DRIFT_MINDEST, DRIFT_ANTEIL * hoch);
      }
      if (driftZuGross) {
        // Drift ist kein Fehlgriff, der sich von selbst gibt: kein Nachgeben.
        annehmen = false;
      } else if (befund.haelt) {
        annehmen = true;
      } else {
        const nurLage =
          befund.verhaeltnis === 0 ||
          (befund.verhaeltnis >= 1 / PRUEFMASS.flaeche && befund.verhaeltnis <= PRUEFMASS.flaeche);
        annehmen = nurLage && alt.abgelehnt >= NACH_ABLEHNUNGEN;
      }
    }

    const maske = annehmen ? frisch : erwartet;
    const mass = annehmen ? frischMass : vermessen(erwartet, breite, hoehe);
    const mitte = mass.mitte;
    // Ein Modell hat den Gegenstand hier gesehen – siehe `SpurRand.abwesendSeit`.
    const bestaetigt = annehmen && mitte !== null;
    if (!annehmen) {
      this.verworfen += 1;
      neuDrift = alt.drift;
    } else if (!sicher) {
      // Ohne sichere Suche gibt es keinen Bezug, an dem Drift zu messen wäre:
      // Die angenommene Maske ist der neue.
      neuDrift = { x: 0, y: 0 };
    }

    /*
     * Wo die Suche den Gegenstand am Schlüsselbild sah, und wo die
     * angenommene Maske ihn wirklich hat: Der Unterschied wird über die
     * Zwischenbilder verteilt, damit die Überblendung dort ankommt, wo das
     * Schlüsselbild steht. Nicht auf einer Achse, auf der eine der beiden
     * Masken am Rand anstösst – dort bleibt der Schwerpunkt hinter dem
     * Gegenstand zurück, und die „Korrektur" zöge rückwärts.
     */
    const k =
      altMitte && mitte ? korrektur(altMitte, gesamt, mitte, alt.mass, mass) : { x: 0, y: 0 };
    if (altMitte) {
      const schritte = weg.length;
      const ende = { x: gesamt.x + k.x, y: gesamt.y + k.y };
      for (let m = 1; m < schritte; m += 1) {
        const anteil = m / schritte;
        const hier = { x: weg[m - 1].x + anteil * k.x, y: weg[m - 1].y + anteil * k.y };
        this.zwischen.set(alt.bild + m * this.richtung, {
          start: alt.bild,
          vomStart: hier,
          vomEnde: { x: hier.x - ende.x, y: hier.y - ende.y },
        });
      }
    }

    /*
     * Die Geschwindigkeit nur aus Masken, die ganz im Bild liegen: Ein
     * angeschnittener Gegenstand hat seinen Schwerpunkt hinter sich, und
     * wer daraus misst, bekam 4,5 statt 8 Punkte je Bild – und eine
     * Vorhersage, die im Bild stehen blieb, nachdem er gegangen war.
     */
    const schritte = Math.abs(ziel - alt.bild);
    const amRand = randIrgendwo(alt.mass) || randIrgendwo(mass);
    const tempo =
      altMitte && mitte && !amRand
        ? { x: (mitte.x - altMitte.x) / schritte, y: (mitte.y - altMitte.y) / schritte }
        : (alt.tempo ?? { x: gesamt.x / schritte, y: gesamt.y / schritte });

    return {
      bild: ziel,
      maske,
      mass,
      // Die Punkte um das mitnehmen, was die Vorhersage am Schlüsselbild
      // verfehlt hat – sonst blieben sie am hinteren Rand des Gegenstandes
      // zurück und fielen beim nächsten Mal von ihm herunter.
      punkte: punkte
        ? punkte.map((p) =>
            mitte
              ? einrasten({ x: p.x + k.x, y: p.y + k.y }, maske, breite, hoehe, mitte.flaeche)
              : p,
          )
        : null,
      tempo,
      abgelehnt: annehmen ? 0 : alt.abgelehnt + 1,
      /*
       * Mit `wiederBilder` zählt die Fläche einer am Rand angeschnittenen
       * Maske nicht als Mass: Beim Hinauslaufen bliebe sonst der letzte
       * Streifen stehen, und ein Gegenstand, der zurückkommt, wäre schon
       * nach wenigen Bildern „mehr als dreimal so gross" wie er.
       */
      flaeche: mitte
        ? filtern && randIrgendwo(mass) && alt.flaeche > 0
          ? Math.max(alt.flaeche, mitte.flaeche)
          : mitte.flaeche
        : alt.flaeche,
      drift: neuDrift,
      vomAnker: { x: alt.vomAnker.x + gesamt.x + k.x, y: alt.vomAnker.y + gesamt.y + k.y },
      abwesendSeit: bestaetigt
        ? null
        : alt.abwesendSeit === null
          ? schritteGesamt
          : alt.abwesendSeit + schritteGesamt,
      letzterKasten: bestaetigt ? gegenstandKasten(mass) : alt.letzterKasten,
      letztesTempo: bestaetigt ? tempo : alt.letztesTempo,
    };
  }

  /**
   * Die Maske von `alt` Bild für Bild bis `ziel` suchen.
   *
   * Gibt je Schritt den aufgelaufenen Weg zurück, in Bildpunkten; der letzte
   * Eintrag ist der ganze Weg bis zum Ziel. `sicher` heisst: Jeder Schritt
   * kam aus dem Bild, keiner aus der Geschwindigkeit.
   */
  private suchen(alt: Stand, ziel: number): { weg: Ort[]; sicher: boolean } {
    const { grau, breite } = this.auftrag;
    const { faktor } = this;
    const schritt = ziel > alt.bild ? 1 : -1;
    const weg: Ort[] = [];
    const proben = alt.mass.mitte ? probenAus(alt.maske, breite, this.auftrag.hoehe, faktor) : null;
    let sicher = proben !== null;
    let x = 0;
    let y = 0;
    for (let j = alt.bild; j !== ziel; j += schritt) {
      const nach = j + schritt;
      const fund = proben ? maskeSuchen(grau[j], grau[nach], proben, x / faktor, y / faktor) : null;
      if (fund) {
        x += fund.x * faktor;
        y += fund.y * faktor;
      } else {
        sicher = false;
        if (alt.tempo) {
          x += alt.tempo.x;
          y += alt.tempo.y;
        }
      }
      weg.push({ x, y });
    }
    return { weg, sicher };
  }

  /** Alle Bilder des Laufs: die Schlüsselbilder und dazwischen überblendet. */
  ergebnis(): SpurErgebnis {
    const { von, bis } = this.auftrag;
    const masken: Uint8Array[] = new Array(bis - von + 1);
    const mitten: (Ort | null)[] = new Array(bis - von + 1).fill(null);
    for (let i = von; i <= bis; i += 1) {
      const bild = this.maskeBild(i);
      masken[i - von] = bild.maske;
      mitten[i - von] = bild.mitte;
    }
    // Der Weg je Bild aus den schon bekannten Mitten – kein weiterer
    // Durchgang über hundertfünfzig volle Masken.
    const versatz = masken.map(() => ({ x: 0, y: 0 }));
    for (let i = 1; i < masken.length; i += 1) {
      const vorher = mitten[i - 1];
      const jetzt = mitten[i];
      if (vorher && jetzt) versatz[i] = { x: jetzt.x - vorher.x, y: jetzt.y - vorher.y };
    }
    return { masken, versatz, verworfen: this.verworfen };
  }

  /**
   * Die Maske an EINEM Bild des Laufs, samt Schwerpunkt: ein Schlüsselbild
   * so, wie es angenommen wurde, dazwischen überblendet.
   *
   * # Warum einzeln
   *
   * `ergebnis()` baut alle Bilder auf einmal – bei einem Fenster mit einer
   * Brücke von achtundvierzig Bildern sechzig volle Masken, dazu die
   * geglätteten, und das am Stück, ohne dass die Seite dazwischen zu Wort
   * kommt. Einzeln kann der Aufrufer nach jedem Bild Luft holen, und für ein
   * Brückenbild, das niemand zeigt, baut er gar keine.
   *
   * Gilt für Bilder zwischen zwei schon gerechneten Schlüsselbildern; ein
   * noch fehlendes Schlüsselbild zählt als leer, wie in `ergebnis()`.
   */
  maskeBild(i: number): { maske: Uint8Array; mitte: Mitte | null } {
    const { breite, hoehe } = this.auftrag;
    const leer = this.leer();
    const liste = this.schluessel;
    // Das letzte Schlüsselbild bis einschliesslich i.
    let lo = 0;
    let hi = liste.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (liste[m] <= i) lo = m;
      else hi = m - 1;
    }
    if (liste[lo] === i) {
      return { maske: this.masken.get(i) ?? leer, mitte: this.messungen.get(i)?.mitte ?? null };
    }
    if (liste[lo] > i || lo + 1 >= liste.length) return { maske: leer, mitte: null };

    const { a, b, ma, mb, massstab, nurA, nurB } = this.strecke(lo);
    const maskeA = this.masken.get(a) ?? leer;
    const maskeB = this.masken.get(b) ?? leer;
    const anteil = (i - a) / (b - a);
    const t = nurA ? 0 : nurB ? 1 : anteil;
    const z = this.zwischen.get(i);
    /*
     * Verschwindet der Gegenstand (oder taucht er auf), gilt bis zur
     * Hälfte die nähere Maske – aber nicht mehr stillstehend: Ist ihr
     * Weg bekannt, wandert sie ihn, und am Rand schneidet das Bild sie
     * von selbst ab. Über die Hälfte hinaus nicht: Die Suche sieht einen
     * Gegenstand, der gerade hinausgeht, kaum noch wandern, und ein Rest
     * bliebe am Rand kleben.
     */
    const allein =
      z && ma.mitte && ma.kasten && !mb.mitte && anteil < 0.5
        ? {
            maske: maskeA,
            mitte: ma.mitte,
            kasten: ma.kasten,
            weg: z.start === a ? z.vomStart : z.vomEnde,
          }
        : z && mb.mitte && mb.kasten && !ma.mitte && anteil > 0.5
          ? {
              maske: maskeB,
              mitte: mb.mitte,
              kasten: mb.kasten,
              weg: z.start === a ? z.vomEnde : z.vomStart,
            }
          : null;
    if (allein) {
      const eine = { ...allein, massstab: 1 };
      return ueberblenden(eine, eine, 0, breite, hoehe);
    }
    if (!ma.mitte || !mb.mitte || !ma.kasten || !mb.kasten || !z) {
      // Der Gegenstand taucht auf oder verschwindet: Es gilt die nähere
      // der beiden Masken. Eine halb durchsichtige wäre eine halbe
      // Wirkung, und die gibt es nicht.
      return anteil < 0.5 ? { maske: maskeA, mitte: ma.mitte } : { maske: maskeB, mitte: mb.mitte };
    }
    const ausA = z.start === a ? z.vomStart : z.vomEnde;
    const ausB = z.start === a ? z.vomEnde : z.vomStart;
    return ueberblenden(
      {
        maske: maskeA,
        mitte: ma.mitte,
        kasten: ma.kasten,
        weg: ausA,
        massstab: Math.pow(massstab, anteil),
      },
      {
        maske: maskeB,
        mitte: mb.mitte,
        kasten: mb.kasten,
        weg: ausB,
        massstab: Math.pow(massstab, anteil - 1),
      },
      t,
      breite,
      hoehe,
    );
  }

  /** Die Strecke zwischen dem n-ten und dem nächsten Schlüsselbild. */
  private strecke(n: number): Strecke {
    const da = this.strecken.get(n);
    if (da) return da;
    const { breite, hoehe } = this.auftrag;
    const a = this.schluessel[n];
    const b = this.schluessel[n + 1];
    const leer = this.leer();
    const ma = this.messungen.get(a) ?? vermessen(this.masken.get(a) ?? leer, breite, hoehe);
    const mb = this.messungen.get(b) ?? vermessen(this.masken.get(b) ?? leer, breite, hoehe);
    /*
     * Der Massstab nur zwischen zwei ganzen Masken: Stösst eine an den
     * Rand, misst ihre Fläche den Anschnitt und nicht die Grösse – und
     * die andere würde grundlos geschrumpft.
     */
    const massstab =
      ma.mitte && mb.mitte && !randIrgendwo(ma) && !randIrgendwo(mb)
        ? Math.min(2, Math.max(0.5, Math.sqrt(mb.mitte.flaeche / ma.mitte.flaeche)))
        : 1;
    /*
     * Ist nur EINE der beiden Masken angeschnitten, gilt die ganze allein,
     * geschoben: Sie weiss, wie gross der Gegenstand ist, und der Bildrand
     * schneidet sie von selbst richtig ab. Gemischt kam beim Hinauslaufen
     * ein Viertel der ganzen und drei Viertel des Rests heraus – die
     * Hälfte der sichtbaren Fläche.
     */
    const strecke: Strecke = {
      a,
      b,
      ma,
      mb,
      massstab,
      nurA: randIrgendwo(mb) && !randIrgendwo(ma),
      nurB: randIrgendwo(ma) && !randIrgendwo(mb),
    };
    // Erst gemerkt, wenn beide Enden gerechnet sind – ein Zwischenstand gälte sonst für immer.
    if (this.masken.has(a) && this.masken.has(b)) this.strecken.set(n, strecke);
    return strecke;
  }

  /** Eine leere Maske – eine je Spur, sie wird nie beschrieben. */
  private leer(): Uint8Array {
    if (!this.leerFeld) this.leerFeld = new Uint8Array(this.auftrag.breite * this.auftrag.hoehe);
    return this.leerFeld;
  }
}

/* ---------- Messen ---------- */

/** Ab dieser Deckung gehört ein Bildpunkt zum KERN einer Komponente (und von `Vermessung.kern`). */
const KERN_AB = 128;

function vermessen(maske: Uint8Array, breite: number, hoehe: number): Vermessung {
  let summe = 0;
  let sx = 0;
  let sy = 0;
  let x0 = breite;
  let y0 = hoehe;
  let x1 = -1;
  let y1 = -1;
  let kx0 = breite;
  let ky0 = hoehe;
  let kx1 = -1;
  let ky1 = -1;
  let links = false;
  let rechts = false;
  let oben = false;
  let unten = false;
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    for (let x = 0; x < breite; x += 1) {
      const a = maske[zeile + x];
      if (a === 0) continue;
      summe += a;
      sx += a * x;
      sy += a * y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (a >= KERN_AB) {
        if (x < kx0) kx0 = x;
        if (x > kx1) kx1 = x;
        if (y < ky0) ky0 = y;
        if (y > ky1) ky1 = y;
        if (x === 0) links = true;
        if (x === breite - 1) rechts = true;
        if (y === 0) oben = true;
        if (y === hoehe - 1) unten = true;
      }
    }
  }
  const flaeche = summe / 255;
  return {
    mitte: flaeche < 1 ? null : { x: sx / summe, y: sy / summe, flaeche },
    kasten: x1 < 0 ? null : { x0, y0, x1, y1 },
    kern: kx1 < 0 ? null : { x0: kx0, y0: ky0, x1: kx1, y1: ky1 },
    rand: { links, rechts, oben, unten },
  };
}

/**
 * Wo der Gegenstand einer Maske steht: der Kasten ihres Kerns – und nur,
 * wenn sie keinen hat (eine durchweg blasse Maske, etwa ein Anker aus dem
 * Editor), der ganze.
 */
function gegenstandKasten(mass: Vermessung): Kasten | null {
  return mass.kern ?? mass.kasten;
}

function randIrgendwo(mass: Vermessung): boolean {
  const { links, rechts, oben, unten } = mass.rand;
  return links || rechts || oben || unten;
}

/** Ein Kasten, um `anteil` seiner Breite und Höhe je Seite grösser. */
function kastenDehnen(k: Kasten, anteil: number): Kasten {
  const dx = (k.x1 - k.x0 + 1) * anteil;
  const dy = (k.y1 - k.y0 + 1) * anteil;
  return { x0: k.x0 - dx, y0: k.y0 - dy, x1: k.x1 + dx, y1: k.y1 + dy };
}

/** Ein Kasten auf das Bild beschnitten – `null`, wenn nichts davon im Bild liegt. */
function kastenImBild(k: Kasten, breite: number, hoehe: number): Kasten | null {
  const x0 = Math.max(0, k.x0);
  const y0 = Math.max(0, k.y0);
  const x1 = Math.min(breite - 1, k.x1);
  const y1 = Math.min(hoehe - 1, k.y1);
  return x0 > x1 || y0 > y1 ? null : { x0, y0, x1, y1 };
}

/**
 * Eine Maske auf die Zusammenhangskomponenten zurückschneiden, die eine der
 * `stellen` treffen – oder, mit `randErlaubt`, den Bildrand berühren.
 *
 * Komponenten sind die zusammenhängenden Kerne (Deckung ab der Hälfte, über
 * Ecken verbunden). Der weiche Saum darunter zählt nicht mit: Ein
 * Freisteller legt zwischen zwei nahe Gegenstände oft einen Hauch von
 * Zuversicht, und über den verbunden wären sie eine einzige Komponente. Der
 * Saum einer behaltenen Komponente bleibt, soweit er in ihrem etwas
 * gedehnten Kasten liegt – alles Blasse ausserhalb davon geht, AUCH wenn
 * jede Komponente trifft.
 *
 * # Warum auch dann
 *
 * Weil Freisteller ausserhalb des Gegenstands selten genau null liefern:
 * ein Dunst von ein paar Stufen über das ganze Bild, oder ein zweiter
 * Gegenstand, den das Modell nur halb sieht, solange der erste da ist.
 * Blieb das stehen, weil der eine Kern traf, stand es in der angenommenen
 * Maske – und ging der Gegenstand, war der Dunst das Letzte, was von ihm
 * „bestätigt" war, über das ganze Bild. Nachgestellt: Mit einem halb
 * gesehenen Zweitobjekt sprang die Maske beim Austritt auf dieses.
 *
 * Gibt die Maske selbst zurück, wenn alles bleibt, und eine leere, wenn
 * nichts bleibt.
 *
 * Nachgemessen bei 960 × 540 mit zwei Gegenständen und Rauschen im Grund:
 * 6,4 ms je Schlüsselbild in Node auf dem Rechner (auf dem Telefon rund das
 * Dreifache) – gegen zwei Sekunden für den Freisteller, der die Maske
 * geliefert hat.
 */
export function komponentenFiltern(
  maske: Uint8Array,
  breite: number,
  hoehe: number,
  stellen: readonly Kasten[],
  randErlaubt: boolean,
): Uint8Array {
  const n = breite * hoehe;
  const nummer = new Int32Array(n);
  const eltern: number[] = [0];
  const wurzel = (a: number): number => {
    let w = a;
    while (eltern[w] !== w) w = eltern[w];
    // Den Weg verkürzen, damit die nächste Suche nicht wieder so weit läuft.
    while (eltern[a] !== w) {
      const naechster = eltern[a];
      eltern[a] = w;
      a = naechster;
    }
    return w;
  };
  const vereinen = (a: number, b: number) => {
    const wa = wurzel(a);
    const wb = wurzel(b);
    if (wa !== wb) eltern[Math.max(wa, wb)] = Math.min(wa, wb);
  };

  // Erster Durchgang: vorläufige Nummern, Nachbarn links, links oben, oben, rechts oben.
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    for (let x = 0; x < breite; x += 1) {
      const p = zeile + x;
      if (maske[p] < KERN_AB) continue;
      let kleinste = x > 0 ? nummer[p - 1] : 0;
      if (y > 0) {
        const oben = p - breite;
        for (
          let q = x > 0 ? oben - 1 : oben, ende = x + 1 < breite ? oben + 1 : oben;
          q <= ende;
          q += 1
        ) {
          const m = nummer[q];
          if (m === 0) continue;
          if (kleinste === 0) kleinste = m;
          else if (m !== kleinste) vereinen(m, kleinste);
        }
      }
      if (kleinste === 0) {
        kleinste = eltern.length;
        eltern.push(kleinste);
      }
      nummer[p] = kleinste;
    }
  }
  if (eltern.length === 1) return new Uint8Array(n);

  // Je vorläufiger Nummer ihre Wurzel – einmal aufgelöst statt je Bildpunkt.
  const anzahl = eltern.length;
  const wurzeln = new Int32Array(anzahl);
  for (let m = 1; m < anzahl; m += 1) wurzeln[m] = wurzel(m);

  // Zweiter Durchgang: je Komponente, ob sie trifft, und ihr Kasten.
  const trifft = new Uint8Array(anzahl);
  const kx0 = new Int32Array(anzahl).fill(breite);
  const ky0 = new Int32Array(anzahl).fill(hoehe);
  const kx1 = new Int32Array(anzahl).fill(-1);
  const ky1 = new Int32Array(anzahl).fill(-1);
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    const amRand = y === 0 || y === hoehe - 1;
    for (let x = 0; x < breite; x += 1) {
      const p = zeile + x;
      if (nummer[p] === 0) continue;
      const w = wurzeln[nummer[p]];
      nummer[p] = w;
      if (x < kx0[w]) kx0[w] = x;
      if (x > kx1[w]) kx1[w] = x;
      if (y < ky0[w]) ky0[w] = y;
      if (y > ky1[w]) ky1[w] = y;
      if (trifft[w]) continue;
      if (randErlaubt && (amRand || x === 0 || x === breite - 1)) {
        trifft[w] = 1;
        continue;
      }
      for (const s of stellen) {
        if (x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) {
          trifft[w] = 1;
          break;
        }
      }
    }
  }
  let keine = true;
  for (let w = 1; w < anzahl; w += 1) {
    if (eltern[w] === w && trifft[w]) keine = false;
  }
  if (keine) return new Uint8Array(n);

  // Wo Blasses bleiben darf: im Kasten jeder behaltenen Komponente, um ein Zehntel gedehnt.
  const imSaum = new Uint8Array(n);
  for (let w = 1; w < anzahl; w += 1) {
    if (eltern[w] !== w || !trifft[w]) continue;
    const saum = Math.max(4, Math.round(0.1 * Math.max(kx1[w] - kx0[w], ky1[w] - ky0[w])));
    const x0 = Math.max(0, kx0[w] - saum);
    const x1 = Math.min(breite - 1, kx1[w] + saum);
    const y0 = Math.max(0, ky0[w] - saum);
    const y1 = Math.min(hoehe - 1, ky1[w] + saum);
    for (let y = y0; y <= y1; y += 1) imSaum.fill(1, y * breite + x0, y * breite + x1 + 1);
  }
  // Erst nachsehen, ob überhaupt etwas geht – sonst bleibt es dieselbe Maske.
  const bleibt = (p: number): boolean =>
    nummer[p] !== 0 ? trifft[nummer[p]] === 1 : imSaum[p] === 1;
  let etwasGeht = false;
  for (let p = 0; p < n; p += 1) {
    if (maske[p] !== 0 && !bleibt(p)) {
      etwasGeht = true;
      break;
    }
  }
  if (!etwasGeht) return maske;
  const raus = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    if (maske[p] !== 0 && bleibt(p)) raus[p] = maske[p];
  }
  return raus;
}

/**
 * Wie weit die angenommene Maske von dort abweicht, wo die Suche sie
 * erwartete – je Achse null, sobald eine der beiden Masken an dieser Achse
 * am Rand anstösst. Eine Person, die unten angeschnitten ist, hat einen
 * verlässlichen waagrechten Schwerpunkt, nur keinen senkrechten.
 */
function korrektur(
  altMitte: Ort,
  gesamt: Ort,
  neuMitte: Ort,
  altMass: Vermessung,
  neuMass: Vermessung,
): Ort {
  const seitlich =
    altMass.rand.links || altMass.rand.rechts || neuMass.rand.links || neuMass.rand.rechts;
  const senkrecht =
    altMass.rand.oben || altMass.rand.unten || neuMass.rand.oben || neuMass.rand.unten;
  return {
    x: seitlich ? 0 : neuMitte.x - (altMitte.x + gesamt.x),
    y: senkrecht ? 0 : neuMitte.y - (altMitte.y + gesamt.y),
  };
}

/**
 * Läuft der Gegenstand gerade aus dem Bild? Seine Maske stösst an einen
 * Rand, und die Bewegung zeigt dorthin – aber nicht an den gegenüber: Eine
 * Maske, die von Rand zu Rand reicht, verlässt das Bild auf der einen Seite
 * nicht, während sie auf der anderen hereinkommt.
 */
function hinaus(alt: Stand, gesamt: Ort): boolean {
  const richtung = alt.tempo ?? gesamt;
  const { links, rechts, oben, unten } = alt.mass.rand;
  const kaum = 0.05;
  return (
    (links && !rechts && richtung.x < -kaum) ||
    (rechts && !links && richtung.x > kaum) ||
    (oben && !unten && richtung.y < -kaum) ||
    (unten && !oben && richtung.y > kaum)
  );
}

/* ---------- Die Maske im nächsten Bild suchen ---------- */

interface Proben {
  /** Graupunkte der Maske im Schlüsselbild. */
  readonly x: Int32Array;
  readonly y: Int32Array;
}

/** Die Graupunkte unter der Maske, gleichmässig ausgedünnt auf höchstens `PROBEN_MAX`. */
function probenAus(maske: Uint8Array, breite: number, hoehe: number, faktor: number): Proben {
  const gb = Math.floor(breite / faktor);
  const gh = Math.floor(hoehe / faktor);
  const liste: number[] = [];
  for (let gy = 0; gy < gh; gy += 1) {
    const py = Math.min(hoehe - 1, Math.floor((gy + 0.5) * faktor));
    for (let gx = 0; gx < gb; gx += 1) {
      const px = Math.min(breite - 1, Math.floor((gx + 0.5) * faktor));
      if (maske[py * breite + px] >= 128) liste.push(gx, gy);
    }
  }
  const anzahl = liste.length / 2;
  const schritt = Math.max(1, Math.ceil(anzahl / PROBEN_MAX));
  const n = Math.ceil(anzahl / schritt);
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  for (let i = 0, k = 0; i < anzahl && k < n; i += schritt, k += 1) {
    x[k] = liste[i * 2];
    y[k] = liste[i * 2 + 1];
  }
  return { x, y };
}

/**
 * Wohin die Punkte unter der Maske von `vorher` nach `nachher` gewandert
 * sind – in Graupunkten, relativ zu `(ox, oy)`, dem Weg bis `vorher`.
 *
 * Grob in Zweierschritten über die ganze Weite, fein um den Fund herum, und
 * zuletzt zwischen den Punkten über eine Parabel. `null`, wenn kein Versatz
 * deutlich besser passt als die übrigen – dann verrät das Bild die Bewegung
 * nicht, und die Geschwindigkeit muss tragen.
 *
 * Die Stellen im alten Bild stehen fest, bevor gesucht wird; liegt ein
 * Versatz ganz im Bild, läuft die Summe ohne eine einzige Randprüfung – in
 * der Gegenlesung knapp dreimal schneller bei gleichem Fund.
 */
function maskeSuchen(
  vorher: Grau,
  nachher: Grau,
  proben: Proben,
  ox: number,
  oy: number,
): Ort | null {
  const n = proben.x.length;
  if (n < 12) return null;
  const bx = Math.round(ox);
  const by = Math.round(oy);
  const w = vorher.breite;
  const h = vorher.hoehe;
  const zw = nachher.breite;
  const zh = nachher.hoehe;
  // Nur Stellen, die im alten Bild liegen – die anderen zählen bei keinem Versatz.
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  const wert = new Float64Array(n);
  let m = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = proben.x[i] + bx;
    const y = proben.y[i] + by;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    qx[m] = x;
    qy[m] = y;
    wert[m] = vorher.werte[y * w + x];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    m += 1;
  }
  /*
   * Wie viele Stellen im neuen Bild mindestens noch liegen müssen, damit ein
   * Versatz zählt – bezogen auf die, die im alten lagen. Ein Gegenstand, der
   * gerade hinausläuft, verliert bei seinem wahren Weg einen Teil davon;
   * mit der Grenze bei 40 % ALLER Stellen war genau dieser Weg oft gar nicht
   * wählbar, und die Suche liess ihn im Bild stehen.
   */
  const mindest = Math.max(12, m * 0.3);
  if (m < 12) return null;
  const ziel = nachher.werte;
  const bewerten = (vx: number, vy: number): number => {
    if (minX + vx >= 0 && maxX + vx < zw && minY + vy >= 0 && maxY + vy < zh) {
      let summe = 0;
      for (let i = 0; i < m; i += 1) {
        summe += Math.abs(ziel[(qy[i] + vy) * zw + qx[i] + vx] - wert[i]);
      }
      return summe / m;
    }
    let summe = 0;
    let gueltig = 0;
    for (let i = 0; i < m; i += 1) {
      const zx = qx[i] + vx;
      const zy = qy[i] + vy;
      if (zx < 0 || zy < 0 || zx >= zw || zy >= zh) continue;
      summe += Math.abs(ziel[zy * zw + zx] - wert[i]);
      gueltig += 1;
    }
    return gueltig < mindest ? Infinity : summe / gueltig;
  };

  let besteX = 0;
  let besteY = 0;
  let bestes = Infinity;
  const grob: number[] = [];
  const naeher = (vx: number, vy: number) => vx * vx + vy * vy < besteX ** 2 + besteY ** 2;
  for (let vy = -SUCHWEITE; vy <= SUCHWEITE; vy += 2) {
    for (let vx = -SUCHWEITE; vx <= SUCHWEITE; vx += 2) {
      const bewertung = bewerten(vx, vy);
      if (!Number.isFinite(bewertung)) continue;
      grob.push(bewertung);
      // Bei Gleichstand gewinnt der kürzere Weg – auf einer glatten Fläche
      // ist das der Stillstand.
      if (bewertung < bestes - 1e-6 || (bewertung <= bestes + 1e-6 && naeher(vx, vy))) {
        bestes = bewertung;
        besteX = vx;
        besteY = vy;
      }
    }
  }
  if (!Number.isFinite(bestes)) return null;
  const fein = new Map<number, number>();
  const schluessel = (vx: number, vy: number) => (vy + 64) * 256 + vx + 64;
  const cx = besteX;
  const cy = besteY;
  for (let vy = cy - 2; vy <= cy + 2; vy += 1) {
    for (let vx = cx - 2; vx <= cx + 2; vx += 1) {
      const bewertung = bewerten(vx, vy);
      fein.set(schluessel(vx, vy), bewertung);
      if (bewertung < bestes - 1e-6) {
        bestes = bewertung;
        besteX = vx;
        besteY = vy;
      }
    }
  }
  /*
   * Eindeutig? Verglichen mit dem Median der groben Versätze: Ein Gegenstand
   * mit Kante oder Muster passt an EINER Stelle deutlich besser als
   * anderswo. Auf einer glatten Fläche, die vor glattem Grund liegt, passt
   * überall ungefähr gleich gut, und jeder Fund wäre gewürfelt.
   */
  grob.sort((a, b) => a - b);
  const median = grob[grob.length >> 1];
  if (median - bestes < 1.5) return null;

  const an = (vx: number, vy: number) => fein.get(schluessel(vx, vy)) ?? bewerten(vx, vy);
  const zwischen = (links: number, mitte: number, rechts: number) => {
    const nenner = links - 2 * mitte + rechts;
    if (!Number.isFinite(nenner) || nenner <= 0) return 0;
    return Math.max(-0.5, Math.min(0.5, (links - rechts) / (2 * nenner)));
  };
  const fx = zwischen(an(besteX - 1, besteY), bestes, an(besteX + 1, besteY));
  const fy = zwischen(an(besteX, besteY - 1), bestes, an(besteX, besteY + 1));
  return { x: besteX + fx, y: besteY + fy };
}

/* ---------- Punkte und Überblendung ---------- */

/**
 * Einen Punkt in die Maske ziehen, falls er daneben liegt.
 *
 * Gesucht wird in wachsenden Quadraten bis zur halben Kantenlänge der Maske
 * (aus ihrer schon bekannten Fläche); findet sich nichts, bleibt der Punkt,
 * wo er ist.
 *
 * Auch für den Editor an einem Bild ohne Anker (`masken.ts`): Die Punkte des
 * letzten Schlüsselbildes, mit der Maske verschoben, landen so IN ihr – und
 * ein weiterer Tipp dort rechnet mit Punkten, die auf dem Gegenstand liegen.
 */
export function einrasten(
  punkt: Punkt,
  maske: Uint8Array,
  breite: number,
  hoehe: number,
  flaeche: number,
): Punkt {
  const x = Math.round(punkt.x);
  const y = Math.round(punkt.y);
  const drin = (px: number, py: number) =>
    px >= 0 && py >= 0 && px < breite && py < hoehe && maske[py * breite + px] >= 128;
  if (drin(x, y)) return punkt;
  const weite = Math.max(8, Math.round(Math.sqrt(flaeche) / 2));
  for (let r = 1; r <= weite; r += 1) {
    let besteX = 0;
    let besteY = 0;
    let abstand = Infinity;
    const pruefen = (px: number, py: number) => {
      if (!drin(px, py)) return;
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < abstand) {
        abstand = d;
        besteX = px;
        besteY = py;
      }
    };
    for (let k = -r; k <= r; k += 1) {
      pruefen(x + k, y - r);
      pruefen(x + k, y + r);
      pruefen(x - r, y + k);
      pruefen(x + r, y + k);
    }
    if (abstand < Infinity) return { x: besteX, y: besteY };
  }
  return punkt;
}

interface Schluesselmaske {
  readonly maske: Uint8Array;
  readonly mitte: Mitte;
  readonly kasten: Kasten;
  /** Wie weit der Gegenstand seit DIESEM Schlüsselbild gewandert ist. */
  readonly weg: Ort;
  /** Um welchen Faktor er dabei gewachsen ist. */
  readonly massstab: number;
}

/**
 * Eine Maske zwischen zwei Schlüsselbildern: jede um den gesuchten Weg ab
 * ihrem EIGENEN Schlüsselbild geschoben, im Massstab angeglichen, nach Nähe
 * gemischt.
 *
 * Ab dem eigenen Schlüsselbild und nicht Schwerpunkt auf Schwerpunkt: Ragt
 * der Gegenstand an einem Ende über den Rand, liegt der sichtbare
 * Schwerpunkt dort nicht in seiner Mitte, und die andere Maske wäre an eine
 * falsche Stelle gelegt worden – nachgemessen Deckungen von 0,31 bis 0,75,
 * wo sonst 1,0 stand.
 *
 * Gerechnet wird nur im Rechteck, in dem eine der beiden etwas hat. Über das
 * ganze Bild waren es 25 ms je Zwischenbild, unabhängig von der Grösse des
 * Gegenstandes – bei 150 Bildern knapp drei Sekunden je Teil, in denen die
 * Seite stand.
 */
function ueberblenden(
  a: Schluesselmaske,
  b: Schluesselmaske,
  t: number,
  breite: number,
  hoehe: number,
): { maske: Uint8Array; mitte: Mitte | null } {
  const raus = new Uint8Array(breite * hoehe);
  const kastenA = abbilden(a);
  const kastenB = abbilden(b);
  const x0 = Math.max(0, Math.floor(Math.min(kastenA.x0, kastenB.x0)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(kastenA.y0, kastenB.y0)) - 2);
  const x1 = Math.min(breite - 1, Math.ceil(Math.max(kastenA.x1, kastenB.x1)) + 2);
  const y1 = Math.min(hoehe - 1, Math.ceil(Math.max(kastenA.y1, kastenB.y1)) + 2);
  const ia = 1 / a.massstab;
  const ib = 1 / b.massstab;
  // Wohin die Mitte jeder Maske in diesem Bild kommt.
  const zax = a.mitte.x + a.weg.x;
  const zay = a.mitte.y + a.weg.y;
  const zbx = b.mitte.x + b.weg.x;
  const zby = b.mitte.y + b.weg.y;
  let summe = 0;
  let sx = 0;
  let sy = 0;
  for (let y = y0; y <= y1; y += 1) {
    const zeile = y * breite;
    const pay = a.mitte.y + (y - zay) * ia;
    const pby = b.mitte.y + (y - zby) * ib;
    for (let x = x0; x <= x1; x += 1) {
      const va = abtasten(a.maske, a.mitte.x + (x - zax) * ia, pay, breite, hoehe);
      const vb = abtasten(b.maske, b.mitte.x + (x - zbx) * ib, pby, breite, hoehe);
      const v = Math.round((1 - t) * va + t * vb);
      if (v === 0) continue;
      raus[zeile + x] = v;
      summe += v;
      sx += v * x;
      sy += v * y;
    }
  }
  const flaeche = summe / 255;
  return {
    maske: raus,
    mitte: flaeche < 1 ? null : { x: sx / summe, y: sy / summe, flaeche },
  };
}

/** Wohin das Rechteck einer Schlüsselmaske in diesem Bild fällt. */
function abbilden(s: Schluesselmaske): Kasten {
  const zx = s.mitte.x + s.weg.x;
  const zy = s.mitte.y + s.weg.y;
  return {
    x0: zx + (s.kasten.x0 - s.mitte.x) * s.massstab,
    y0: zy + (s.kasten.y0 - s.mitte.y) * s.massstab,
    x1: zx + (s.kasten.x1 - s.mitte.x) * s.massstab,
    y1: zy + (s.kasten.y1 - s.mitte.y) * s.massstab,
  };
}

/**
 * Eine Maske an einer Zwischenstelle, aus den vier Nachbarn gemischt – wie
 * `maskeZiehen`, und aus demselben Grund: Die Maske hat weiche Ränder, und
 * der nächste Nachbar machte daraus bei jedem Bild einen härteren. Von
 * ausserhalb kommt nichts.
 */
function abtasten(
  maske: Uint8Array,
  px: number,
  py: number,
  breite: number,
  hoehe: number,
): number {
  if (px < 0 || py < 0 || px > breite - 1 || py > hoehe - 1) return 0;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(breite - 1, x0 + 1);
  const y1 = Math.min(hoehe - 1, y0 + 1);
  const ax = px - x0;
  const ay = py - y0;
  const oben = maske[y0 * breite + x0] * (1 - ax) + maske[y0 * breite + x1] * ax;
  const unten = maske[y1 * breite + x0] * (1 - ax) + maske[y1 * breite + x1] * ax;
  return oben * (1 - ay) + unten * ay;
}
