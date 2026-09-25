import { AbbruchError, runEngine } from '../stickers/engines/index.js';
import { TOLERANZ_VORGABE } from '../bild/doc.js';
import { tippNetzVerfuegbar, tippTeilRechnen, vereinigen } from '../bild/tippMaske.js';
import type { GueteInfo } from './einstellungen.js';
import type { Fortschritt, GelesenesBild } from './bilderLesen.js';
import { Spur } from './objektFolge.js';
import { bewegtGlaetten, graustufen } from './verfolgung.js';

/**
 * Eine Maske über ein ganzes Video hinweg.
 *
 * Das Netz läuft auf jedem n-ten Bild, dazwischen wandert die Maske mit der
 * Bewegung mit, und am Ende glättet ein Fenster von drei Bildern das
 * Flackern. Was das kostet und warum es überhaupt so gemacht wird, steht im
 * Kopf von `einstellungen.ts`.
 *
 * # Warum streng nacheinander und nicht mehrere Bilder zugleich
 *
 * Weil dahinter EIN Arbeiter mit EINEM Modell steht. `birefnetKanal` weist
 * einen zweiten Auftrag ab, solange einer läuft – und selbst wenn er es nicht
 * täte, wäre nichts gewonnen: Zwei Durchläufe desselben Modells auf derselben
 * Grafikeinheit teilen sich dieselben Rechenwerke. Was sie sich nicht teilen,
 * ist der Speicher; zwei Modelle nebeneinander sind der sicherste Weg, auf
 * einem Telefon den Arbeiter zu verlieren.
 *
 * # Wie die Maske dem Motiv folgt
 *
 * Über die Spur aus `objektFolge.ts`, wie beim Film: Die Maske selbst wird
 * Bild für Bild gesucht, jede frische Maske gegen die Vorhersage geprüft,
 * und dazwischen wandern beide Schlüsselmasken den gesuchten Weg. Vorher
 * wanderte die Maske hier mit der Bewegung des GANZEN Bildes – bei ruhender
 * Kamera also gar nicht, während das Motiv darunter weglief. Dieselbe
 * Beschwerde, dieselbe Ursache wie beim Film.
 *
 * Die Tipps wandern um denselben Weg wie das Motiv, und zwar alle, auch die
 * zum Wegnehmen: Ein Schatten, der mit abgezogen werden soll, hängt am
 * Motiv, nicht an der Kamera.
 */

export interface FolgeAuftrag {
  readonly guete: GueteInfo;
  /**
   * Ob die Tipps durch das TIPPNETZ gehen oder durch die Farbflutung.
   *
   * Dieselbe Wahl wie im Sticker-Studio. Das Netz trifft ein Ding als Ganzes,
   * die Flutung nimmt, was farblich zusammenhängt – und die geht immer, auch
   * für einen Schatten auf einer Wand, für den kein Modell je trainiert wurde.
   */
  readonly mitNetz?: boolean;
  /**
   * Wie weit die Farbflutung von einem Tipp aus wandert, 0 … 255.
   *
   * Nur ohne Netz von Bedeutung, und dort entscheidend: Auf einer glatten
   * Fläche verschluckt schon eine kleine Toleranz das ganze Ding, auf einem
   * körnigen Grund reicht auch eine grosse nicht über den Rand.
   */
  readonly toleranz?: number;
  /**
   * Die angetippten Punkte – in Koordinaten des ERSTEN Bildes.
   *
   * Sie werden für die folgenden Schlüsselbilder mitgeschoben, damit ein Tipp
   * auf eine Person nicht plötzlich im Hintergrund landet, wenn sie sich
   * bewegt.
   */
  readonly tipps?: readonly { x: number; y: number; dazu: boolean }[];
  readonly fortschritt?: Fortschritt;
  readonly abbruch?: AbortSignal;
}

/**
 * Ein Abbruch, der mitbringt, was schon fertig war.
 *
 * Bei „Genau" steht nach anderthalb Minuten Arbeit einiges an Masken da. Wer
 * dann abbricht, weil es ihm zu lange dauert, will meistens nicht „gar
 * nichts", sondern „dann eben kürzer" – und genau das lässt sich damit
 * anbieten, ohne die Bilder ein zweites Mal durchs Netz zu schicken.
 *
 * Erbt von `AbbruchError`, damit jede bestehende Stelle, die auf
 * `instanceof AbbruchError` prüft, weiter greift und einen Abbruch still
 * behandelt statt als Fehler.
 */
export class FolgeAbbruch extends AbbruchError {
  constructor(readonly fertig: readonly Uint8Array[]) {
    super();
    this.name = 'FolgeAbbruch';
  }
}

export interface FolgeErgebnis {
  readonly masken: readonly Uint8Array[];
  /** Wie viele Bilder wirklich durch das Netz gegangen sind. */
  readonly netzlaeufe: number;
  /** Wie oft ein Netzlauf verworfen wurde, weil sein Ergebnis nicht passte. */
  readonly verworfen: number;
}

export async function folgeMasken(
  bilder: readonly GelesenesBild[],
  auftrag: FolgeAuftrag,
): Promise<FolgeErgebnis> {
  if (bilder.length === 0) return { masken: [], netzlaeufe: 0, verworfen: 0 };
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const breite = bilder[0].daten.width;
  const hoehe = bilder[0].daten.height;
  const abstand = Math.max(1, auftrag.guete.schluesselAbstand);
  const schluessel: number[] = [];
  for (let i = 0; i < bilder.length; i += abstand) schluessel.push(i);
  /*
   * Das LETZTE Bild ist immer ein Schlüsselbild.
   *
   * Sonst endet jedes GIF, dessen Länge kein Vielfaches des Abstandes ist,
   * mit bis zu drei geschobenen Masken – und gerade am Ende, wo die Bewegung
   * am weitesten vom letzten Netzlauf entfernt ist, sitzt der Rand am
   * schlechtesten. Das Ende eines GIF sieht man aber besonders oft: Es läuft
   * in einer Schleife. (Die Spur nimmt das letzte Bild ohnehin dazu.)
   */
  schluessel.push(bilder.length - 1);

  /*
   * Die Graustufen werden EINMAL gerechnet und gemerkt.
   *
   * Jedes Bild ist an zwei Übergängen beteiligt – als „nachher" und als
   * „vorher". Zweimal gerechnet wären das bei 150 Bildern 150 überflüssige
   * Durchläufe zu je einer Millisekunde.
   */
  const grau = bilder.map((bild) => graustufen(bild.daten));

  let netzlaeufe = 0;
  const spur = new Spur({
    grau,
    breite,
    hoehe,
    von: 0,
    bis: bilder.length - 1,
    anker: 0,
    schluessel,
    // Die Spur führt keine Punkte: Die Tipps ergänzen das Netz, sie SIND
    // nicht die Maske, und ein Tipp zum Wegnehmen liegt mit Absicht daneben.
    punkte: null,
    rechnen: async (nummer, _punkte, weg) => {
      /*
       * Das Motivnetz UND die Tipps – nicht das eine statt des anderen.
       *
       * Hier stand einmal ein `seeds` am Aufruf des Motivnetzes, und das war
       * wirkungslos: „Person", „Niedrige Qualität" und „Hohe Qualität" nehmen
       * gar keine Saatpunkte entgegen (siehe `engines/index.ts`) – sie suchen
       * das auffälligste Motiv und sonst nichts. Die Tipps verschwanden
       * lautlos, und in der Oberfläche stand trotzdem ein Punkt.
       *
       * Sie gehören durch ein eigenes Verfahren: `tippTeilRechnen` nimmt
       * entweder das Tippnetz oder die Farbflutung und liefert eine Maske, die
       * hier dazukommt oder abgezogen wird – dieselbe Aufteilung wie im
       * Sticker-Studio und im Fotoeditor.
       */
      netzlaeufe += 1;
      let maske = await runEngine(auftrag.guete.netz, {
        image: bilder[nummer].daten,
        abbruch: auftrag.abbruch,
      });
      const tipps = mitgewandert(auftrag.tipps, weg, breite, hoehe);
      if (tipps.length > 0) {
        maske = await tippsAnwenden(
          maske,
          bilder[nummer].daten,
          tipps,
          auftrag.mitNetz,
          auftrag.toleranz,
        );
      }
      return maske;
    },
  });

  const plan = spur.plan();
  let schritt = 0;
  while (spur.naechstes() !== null) {
    // Der Abbruch nimmt mit, was bis hierher fertig ist – siehe `FolgeAbbruch`.
    if (auftrag.abbruch?.aborted) throw new FolgeAbbruch(fertigeMasken(spur, breite, hoehe));
    try {
      await spur.schritt();
    } catch (ausfall) {
      if (ausfall instanceof AbbruchError) {
        throw new FolgeAbbruch(fertigeMasken(spur, breite, hoehe));
      }
      throw ausfall;
    }
    schritt += 1;
    auftrag.fortschritt?.(
      schritt / plan.length,
      `Freistellen: Schlüsselbild ${schritt} von ${plan.length}`,
    );
  }

  /*
   * Geglättet wird ganz am Ende und MIT der Bewegung: Die Nachbarn werden
   * dorthin verschoben, wo die Maske in diesem Bild steht – das blosse
   * Mittel legte um ein wanderndes Motiv einen Saum.
   */
  const lauf = spur.ergebnis();
  return {
    masken: bewegtGlaetten(lauf.masken, breite, hoehe, lauf.versatz),
    netzlaeufe,
    verworfen: lauf.verworfen,
  };
}

/**
 * Die Tipps um den Weg des Motivs verschoben. Wer dabei das Bild verlässt,
 * fällt weg – am Rand festgeklemmt läge er auf dem Hintergrund.
 */
function mitgewandert(
  tipps: FolgeAuftrag['tipps'],
  weg: { readonly x: number; readonly y: number },
  breite: number,
  hoehe: number,
): { x: number; y: number; dazu: boolean }[] {
  const raus: { x: number; y: number; dazu: boolean }[] = [];
  for (const tipp of tipps ?? []) {
    const x = Math.round(tipp.x + weg.x);
    const y = Math.round(tipp.y + weg.y);
    if (x < 0 || y < 0 || x >= breite || y >= hoehe) continue;
    raus.push({ x, y, dazu: tipp.dazu });
  }
  return raus;
}

/** Die Masken der Bilder, die bis zum Abbruch fertig geworden sind. */
function fertigeMasken(spur: Spur, breite: number, hoehe: number): Uint8Array[] {
  const bis = spur.fertigBis();
  if (bis <= 0) return [];
  const lauf = spur.ergebnis();
  const anzahl = Math.min(lauf.masken.length, bis);
  return bewegtGlaetten(lauf.masken.slice(0, anzahl), breite, hoehe, lauf.versatz.slice(0, anzahl));
}

/**
 * Eine Maske von einer anderen abziehen.
 *
 * Wortgleich zu `abziehenAlpha` in `stickers/render.ts` – und trotzdem hier
 * noch einmal. Der Grund ist der Modulgraph: Jene Datei ist der ganze
 * Sticker-Zeichner, und sie fünf Zeilen wegen in den Videopfad zu ziehen
 * hiesse, jedem, der ein GIF aus einem Video macht, den Sticker-Zeichner
 * mitzuliefern. Multipliziert und nicht abgezogen, damit ein weicher Rand
 * weich bleibt.
 */
function abziehen(a: Uint8Array, b: Uint8Array): Uint8Array {
  const raus = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) raus[i] = Math.round((a[i] * (255 - b[i])) / 255);
  return raus;
}

/**
 * Die Tipps auf eine schon gerechnete Maske legen.
 *
 * Je Vorzeichen EIN Aufruf und nicht einer je Punkt: `tippTeilRechnen`
 * behandelt alle Saatpunkte zusammen – beim Tippnetz teilen sie sich die
 * Einbettung des Bildes, bei der Farbflutung einen einzigen Durchgang.
 */
async function tippsAnwenden(
  maske: Uint8Array,
  bild: ImageData,
  tipps: readonly { x: number; y: number; dazu: boolean }[],
  mitNetzGewuenscht?: boolean,
  toleranz = TOLERANZ_VORGABE,
): Promise<Uint8Array> {
  // Ohne verfügbares Tippnetz wird nach Farbe getippt, statt zu scheitern.
  const mitNetz = (mitNetzGewuenscht ?? true) && tippNetzVerfuegbar();
  let raus = maske;

  for (const dazu of [true, false]) {
    const punkte = tipps.filter((tipp) => tipp.dazu === dazu).map(({ x, y }) => ({ x, y }));
    if (punkte.length === 0) continue;
    const teil = await tippTeilRechnen(bild, punkte, {
      modus: dazu ? 'dazu' : 'weg',
      mitNetz,
      toleranz,
    });
    if (!teil || teil.art !== 'tipp') continue;
    raus = dazu ? vereinigen(raus, teil.alpha) : abziehen(raus, teil.alpha);
  }
  return raus;
}
