import { AbbruchError, runEngine } from '../stickers/engines/index.js';
import type { GueteInfo } from './einstellungen.js';
import type { Fortschritt, GelesenesBild } from './bilderLesen.js';
import {
  BLOCK,
  bewegung,
  graustufen,
  maskeSchieben,
  zeitlichGlaetten,
  type Grau,
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
 * # Warum die Bewegung zwischen NACHBARN gemessen wird und nicht zum
 * Schlüsselbild
 *
 * Weil die Blocksuche nur acht Graupunkte weit schaut. Über drei Bilder
 * hinweg ist eine gehende Person weiter als das – die Suche fände dann nichts
 * und bliebe auf null stehen. Von Nachbar zu Nachbar bleibt sie im Bereich,
 * und die Versätze summieren sich von selbst, weil jeweils die schon
 * geschobene Maske weitergeschoben wird.
 */

export interface FolgeAuftrag {
  readonly guete: GueteInfo;
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
}

/**
 * Die Tipps mitschieben.
 *
 * Ein Punkt wandert mit dem, was unter ihm liegt – also entgegen dem
 * Rückwärtsvektor. `maskeSchieben` fragt „wo stand das?", hier wird gefragt
 * „wo ist das hin?", und das ist dasselbe mit umgekehrtem Vorzeichen.
 */
function tippsSchieben(
  tipps: readonly { x: number; y: number; dazu: boolean }[],
  vorher: Grau,
  nachher: Grau,
  breite: number,
  hoehe: number,
): { x: number; y: number; dazu: boolean }[] {
  const feld = bewegung(vorher, nachher, breite);
  const skala = breite / feld.grauBreite;
  return tipps.map((tipp) => {
    const gx = Math.min(feld.grauBreite - 1, Math.max(0, tipp.x / skala));
    const gy = Math.min(feld.grauHoehe - 1, Math.max(0, tipp.y / skala));
    const bs = Math.min(feld.spalten - 1, Math.floor(gx / BLOCK));
    const bz = Math.min(feld.zeilen - 1, Math.floor(gy / BLOCK));
    return {
      x: Math.min(
        breite - 1,
        Math.max(0, Math.round(tipp.x - feld.dx[bz * feld.spalten + bs] * skala)),
      ),
      y: Math.min(
        hoehe - 1,
        Math.max(0, Math.round(tipp.y - feld.dy[bz * feld.spalten + bs] * skala)),
      ),
      dazu: tipp.dazu,
    };
  });
}

export async function folgeMasken(
  bilder: readonly GelesenesBild[],
  auftrag: FolgeAuftrag,
): Promise<FolgeErgebnis> {
  if (bilder.length === 0) return { masken: [], netzlaeufe: 0 };
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

  const masken: Uint8Array[] = [];
  let tipps = auftrag.tipps ? [...auftrag.tipps] : undefined;
  let netzlaeufe = 0;
  const schritte = bilder.length;

  for (let i = 0; i < bilder.length; i += 1) {
    // Der Abbruch nimmt mit, was bis hierher fertig ist – siehe `FolgeAbbruch`.
    if (auftrag.abbruch?.aborted) throw new FolgeAbbruch(zeitlichGlaetten(masken));

    if (i > 0 && tipps) {
      tipps = tippsSchieben(tipps, grau[i - 1], grau[i], breite, hoehe);
    }

    if (netzBei.has(i)) {
      const maske = await runEngine(auftrag.guete.netz, {
        image: bilder[i].daten,
        seeds: tipps,
        seed: tipps?.find((tipp) => tipp.dazu),
        abbruch: auftrag.abbruch,
      });
      masken.push(maske);
      netzlaeufe += 1;
    } else {
      const feld = bewegung(grau[i - 1], grau[i], breite);
      masken.push(maskeSchieben(masken[i - 1], breite, hoehe, feld));
    }
    auftrag.fortschritt?.((i + 1) / schritte, `Freistellen: Bild ${i + 1} von ${schritte}`);
  }

  /*
   * Geglättet wird ganz am Ende und nicht unterwegs: Das Fenster reicht auch
   * NACH VORN, und das nächste Bild gibt es unterwegs noch nicht.
   */
  return { masken: zeitlichGlaetten(masken), netzlaeufe };
}
