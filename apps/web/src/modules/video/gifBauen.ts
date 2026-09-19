import { AbbruchError } from '../stickers/engines/index.js';
import { gifSchreibenSchrittweise, type Teilbild } from '../stickers/gif.js';
import { LeseAbbruch, videoBilderLesen, type GelesenesBild } from './bilderLesen.js';
import { dauerJeBildMs, zeitpunkte } from './ausschnitt.js';
import { FolgeAbbruch, folgeMasken } from './folgeMaske.js';
import { MAX_BILDER, phasenGewichte, type GueteInfo } from './einstellungen.js';

/**
 * Aus einem Video ein GIF – der ganze Weg an einer Stelle.
 *
 * Drei Abschnitte nacheinander: Bilder holen, freistellen, GIF schreiben.
 * Jeder meldet sich mit seinem Namen, und der Balken ist nach den gemessenen
 * Zeiten gewichtet (siehe `phasenGewichte`) – sonst stünde er bei „Genau"
 * minutenlang still und rauschte danach durch.
 *
 * # Warum die Maske hier angewandt wird und nicht in `renderSticker`
 *
 * `renderSticker` zeichnet immer auf 512 × 512. Für einen Sticker ist das
 * richtig; für ein Video von 16:9 hiesse es, zwei Drittel der Datei mit
 * Durchsichtigkeit zu füllen. Das GIF behält deshalb das Seitenverhältnis des
 * Videos. Wer daraus einen Sticker will, schickt es durch das Sticker-Studio –
 * das nimmt bewegte Bilder längst entgegen (`bewegtLesen.ts`).
 */

/**
 * Die Kante eines GIF OHNE Freistellen.
 *
 * Ohne Freistellen läuft kein Netz, und damit hat die Güte nichts mehr zu
 * sagen – ihre Kante zu benutzen hiesse, die Grösse des Ergebnisses von einer
 * Einstellung abhängig zu machen, die gar nicht mehr angezeigt wird. Wer
 * „Schnell" stehen hatte, bekäme 320; wer einmal „Sehr genau" probiert hat,
 * 512, und nichts erklärte den Unterschied.
 *
 * 384 ist die Mitte und für ein Vollbild-GIF ohnehin die Obergrenze des
 * Sinnvollen: Fünfzig Bilder à 512² wiegen gemessen 6,2 MB und passen damit
 * nicht einmal mehr als Bild in eine Nachricht.
 */
export const VOLLBILD_KANTE = 384;

export interface BauAuftrag {
  readonly datei: Blob;
  readonly vonMs: number;
  readonly bisMs: number;
  readonly bildrate: number;
  readonly guete: GueteInfo;
  readonly freistellen: boolean;
  /** Angetippte Stellen im ERSTEN Bild – sie wandern mit. */
  readonly tipps?: readonly { x: number; y: number; dazu: boolean }[];
  /** Ob die Tipps durch das Tippnetz gehen oder nach Farbe fluten. */
  readonly mitNetz?: boolean;
  /** Wie weit die Farbflutung wandert – nur ohne Netz von Bedeutung. */
  readonly toleranz?: number;
  /** Anteil 0…1, der Name des Abschnitts und ein Satz dazu. */
  readonly fortschritt?: (anteil: number, abschnitt: Abschnitt, text: string) => void;
  readonly abbruch?: AbortSignal;
}

export type Abschnitt = 'lesen' | 'freistellen' | 'schreiben';

export const ABSCHNITT_TITEL: Record<Abschnitt, string> = {
  lesen: 'Bilder holen',
  freistellen: 'Freistellen',
  schreiben: 'GIF schreiben',
};

export interface BauErgebnis {
  readonly blob: Blob;
  readonly bilder: number;
  readonly breite: number;
  readonly hoehe: number;
  /** Wie lange das fertige GIF läuft. */
  readonly laufzeitMs: number;
  /** Wie viele Bilder wirklich durch das Netz gegangen sind. */
  readonly netzlaeufe: number;
}

/**
 * Ein Abbruch, der sagt, wie weit es gekommen war.
 *
 * Damit die Oberfläche anbieten kann: „Aus den ersten 23 Bildern trotzdem ein
 * GIF machen?" Ohne diese Zahl bliebe nur „abgebrochen" – und die Minute
 * Rechnerei wäre umsonst gewesen.
 */
export class BauAbbruch extends AbbruchError {
  constructor(
    readonly abschnitt: Abschnitt,
    readonly fertigeBilder: number,
  ) {
    super();
    this.name = 'BauAbbruch';
  }
}

/** Die Maske auf ein Bild legen – aus Deckung wird Durchsichtigkeit. */
function maskeAnlegen(bild: ImageData, alpha: Uint8Array): ImageData {
  const d = bild.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
    /*
     * Multipliziert und nicht ersetzt: Ein Video kann selbst durchsichtige
     * Stellen haben – eine Aufnahme aus dieser App etwa, die schon einmal
     * durch den Sticker-Editor ging. Ersetzen machte die wieder deckend.
     */
    d[i + 3] = (d[i + 3] * alpha[p]) / 255;
  }
  return bild;
}

export async function gifAusVideo(auftrag: BauAuftrag): Promise<BauErgebnis> {
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const plan = zeitpunkte(auftrag.vonMs, auftrag.bisMs, auftrag.bildrate, MAX_BILDER);
  const kante = auftrag.freistellen ? auftrag.guete.kante : VOLLBILD_KANTE;
  const gewicht = phasenGewichte(plan.zeitpunkte.length, auftrag.guete, auftrag.freistellen, kante);
  const melden = (abschnitt: Abschnitt, anteil: number, text: string) => {
    const vorher =
      abschnitt === 'lesen'
        ? 0
        : abschnitt === 'freistellen'
          ? gewicht.lesen
          : gewicht.lesen + gewicht.freistellen;
    const breite =
      abschnitt === 'lesen'
        ? gewicht.lesen
        : abschnitt === 'freistellen'
          ? gewicht.freistellen
          : gewicht.schreiben;
    auftrag.fortschritt?.(Math.min(1, vorher + anteil * breite), abschnitt, text);
  };

  let gelesen: { bilder: readonly GelesenesBild[]; breite: number; hoehe: number };
  try {
    gelesen = await videoBilderLesen(auftrag.datei, {
      zeitpunkte: plan.zeitpunkte,
      kante,
      fortschritt: (anteil, text) => melden('lesen', anteil, text),
      abbruch: auftrag.abbruch,
    });
  } catch (ausfall) {
    if (ausfall instanceof LeseAbbruch) throw new BauAbbruch('lesen', ausfall.fertig.length);
    throw ausfall;
  }

  let netzlaeufe = 0;
  if (auftrag.freistellen) {
    try {
      const folge = await folgeMasken(gelesen.bilder, {
        guete: auftrag.guete,
        tipps: auftrag.tipps,
        mitNetz: auftrag.mitNetz,
        toleranz: auftrag.toleranz,
        fortschritt: (anteil, text) => melden('freistellen', anteil, text),
        abbruch: auftrag.abbruch,
      });
      netzlaeufe = folge.netzlaeufe;
      gelesen.bilder.forEach((bild, i) => maskeAnlegen(bild.daten, folge.masken[i]));
    } catch (ausfall) {
      if (ausfall instanceof FolgeAbbruch)
        throw new BauAbbruch('freistellen', ausfall.fertig.length);
      throw ausfall;
    }
  }

  const standzeit = dauerJeBildMs(auftrag.bildrate);
  const teilbilder: Teilbild[] = gelesen.bilder.map((bild) => ({
    daten: bild.daten,
    dauerMs: standzeit,
  }));

  let roh: Uint8Array;
  try {
    roh = await gifSchreibenSchrittweise(teilbilder, {
      fortschritt: (anteil, text) => melden('schreiben', anteil, text),
      abbruch: auftrag.abbruch,
    });
  } catch (ausfall) {
    if (ausfall instanceof AbbruchError) throw new BauAbbruch('schreiben', teilbilder.length);
    throw ausfall;
  }

  return {
    /*
     * `roh.slice()` gibt einen eigenen `ArrayBuffer` – `Blob` verlangt einen
     * `BlobPart`, und ein `Uint8Array<ArrayBufferLike>` zählt seit TypeScript
     * 5.7 nicht mehr dazu. Kopiert wird dabei nichts Nennenswertes: Der
     * Puffer ist nach `fertig()` ohnehin schon genau passend.
     */
    blob: new Blob([roh.slice().buffer], { type: 'image/gif' }),
    bilder: teilbilder.length,
    breite: gelesen.breite,
    hoehe: gelesen.hoehe,
    laufzeitMs: teilbilder.length * standzeit,
    netzlaeufe,
  };
}
