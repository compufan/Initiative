import { AbbruchError, runEngine } from '../stickers/engines/index.js';
import { TOLERANZ_VORGABE } from '../bild/doc.js';
import { tippNetzVerfuegbar, tippTeilRechnen, vereinigen } from '../bild/tippMaske.js';
import type { GueteInfo } from './einstellungen.js';
import type { Fortschritt, GelesenesBild } from './bilderLesen.js';
import {
  LAGE_RUHE,
  bewegung,
  graustufen,
  lageSchaetzen,
  lageVerketten,
  maskePasst,
  maskeZiehen,
  punktVor,
  zeitlichGlaetten,
  type Grau,
  type Lage,
} from './verfolgung.js';

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
 * # Warum die Bewegung zwischen NACHBARN gemessen, aber AUFSUMMIERT angewandt
 * wird
 *
 * Gemessen zwischen Nachbarn, weil die Blocksuche nur eine begrenzte Weite
 * hat: Über drei Bilder hinweg ist eine gehende Person weiter als das, und
 * die Suche fände nichts. Angewandt wird die Summe, weil jede Abtastung die
 * Maske aufweicht – nachgemessen verliert eine Maske, die 33-mal nacheinander
 * gezogen wird, 58 % ihrer Fläche. Gezogen wird deshalb immer aus dem letzten
 * NETZLAUF, mit einer einzigen Abbildung.
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
  const netzBei = new Set<number>();
  for (let i = 0; i < bilder.length; i += abstand) netzBei.add(i);
  /*
   * Das LETZTE Bild ist immer ein Schlüsselbild.
   *
   * Sonst endet jedes GIF, dessen Länge kein Vielfaches des Abstandes ist,
   * mit bis zu drei geschobenen Masken – und gerade am Ende, wo die Bewegung
   * am weitesten vom letzten Netzlauf entfernt ist, sitzt der Rand am
   * schlechtesten. Das Ende eines GIF sieht man aber besonders oft: Es läuft
   * in einer Schleife.
   */
  netzBei.add(bilder.length - 1);

  /*
   * Die Graustufen werden EINMAL gerechnet und gemerkt.
   *
   * Jedes Bild ist an zwei Übergängen beteiligt – als „nachher" und als
   * „vorher". Zweimal gerechnet wären das bei 150 Bildern 150 überflüssige
   * Durchläufe zu je einer Millisekunde.
   */
  const grau: Grau[] = bilder.map((bild) => graustufen(bild.daten));

  /*
   * Die Lage jedes Bildes gegenüber dem ERSTEN.
   *
   * Aufsummiert aus den Nachbarschritten und danach in einem Zug angewandt –
   * die Begründung steht im Kopf von `verfolgung.ts`: Wer eine Maske Schritt
   * für Schritt weiterzieht, legt Abtastung auf Abtastung, und sie verliert
   * gemessen 58 % ihrer Fläche über 33 Schritte.
   */
  const faktor = bilder.length > 1 ? breite / grau[0].breite : 1;
  const lagen: Lage[] = [LAGE_RUHE];
  for (let i = 1; i < bilder.length; i += 1) {
    lagen.push(lageVerketten(lagen[i - 1], lageSchaetzen(bewegung(grau[i - 1], grau[i], breite))));
  }

  const masken: Uint8Array[] = [];
  let netzlaeufe = 0;
  let verworfen = 0;
  let letzterNetzlauf = 0;
  const schritte = bilder.length;

  for (let i = 0; i < bilder.length; i += 1) {
    // Der Abbruch nimmt mit, was bis hierher fertig ist – siehe `FolgeAbbruch`.
    if (auftrag.abbruch?.aborted) throw new FolgeAbbruch(zeitlichGlaetten(masken));

    /*
     * Die angetippten Punkte wandern mit – gerechnet aus der Lage gegenüber
     * dem ERSTEN Bild, nicht von Nachbar zu Nachbar aufsummiert. Beides
     * beschreibt denselben Weg; über die Lage bleibt der Fehler der eines
     * einzigen Schrittes statt der Summe aller.
     */
    const tipps = auftrag.tipps?.map((tipp) => {
      const gezogen = punktVor(lagen[i], faktor, tipp.x, tipp.y);
      return {
        x: Math.min(breite - 1, Math.max(0, Math.round(gezogen.x))),
        y: Math.min(hoehe - 1, Math.max(0, Math.round(gezogen.y))),
        dazu: tipp.dazu,
      };
    });

    if (netzBei.has(i)) {
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
      let maske = await runEngine(auftrag.guete.netz, {
        image: bilder[i].daten,
        abbruch: auftrag.abbruch,
      });
      if (tipps && tipps.length > 0) {
        maske = await tippsAnwenden(
          maske,
          bilder[i].daten,
          tipps,
          auftrag.mitNetz,
          auftrag.toleranz,
        );
      }
      /*
       * Gegen das halten, was aus dem vorigen Netzlauf zu erwarten war.
       *
       * Am Film eines Anwenders gemessen sprang die Fläche auf jedem vierten
       * Bild um den Faktor dreizehn – die Maske wanderte nicht weg, sie
       * platzte auf. Die Begründung steht bei `maskePasst`.
       */
      const erwartet =
        i > 0
          ? maskeZiehen(
              masken[letzterNetzlauf],
              breite,
              hoehe,
              lageVerketten(lageKehren(lagen[letzterNetzlauf]), lagen[i]),
              faktor,
            )
          : null;
      const befund = maskePasst(maske, erwartet);
      if (!befund.haelt && erwartet) {
        verworfen += 1;
        masken.push(erwartet);
      } else {
        masken.push(maske);
      }
      netzlaeufe += 1;
      letzterNetzlauf = i;
    } else {
      // Aus dem letzten Netzlauf ziehen, nicht aus dem Vorgänger.
      const seitDort = lageVerketten(lageKehren(lagen[letzterNetzlauf]), lagen[i]);
      masken.push(maskeZiehen(masken[letzterNetzlauf], breite, hoehe, seitDort, faktor));
    }
    auftrag.fortschritt?.((i + 1) / schritte, `Freistellen: Bild ${i + 1} von ${schritte}`);
  }

  /*
   * Geglättet wird ganz am Ende und nicht unterwegs: Das Fenster reicht auch
   * NACH VORN, und das nächste Bild gibt es unterwegs noch nicht.
   */
  return { masken: zeitlichGlaetten(masken), netzlaeufe, verworfen };
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

/**
 * Eine Lage umkehren – erst zurück, dann vorwärts.
 *
 * Damit wird aus „Bild 0 nach a" und „Bild 0 nach b" die Lage „a nach b".
 */
function lageKehren(lage: Lage): Lage {
  const nenner = lage.s * lage.s + lage.w * lage.w;
  if (nenner === 0) return LAGE_RUHE;
  const s = lage.s / nenner;
  const w = -lage.w / nenner;
  return {
    s,
    w,
    tx: -(s * lage.tx - w * lage.ty),
    ty: -(w * lage.tx + s * lage.ty),
    sicher: lage.sicher,
  };
}
