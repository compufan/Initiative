/**
 * Die Brücke vom Foto-Editor zu den lokalen Netzen.
 *
 * Die Netze liegen längst im Haus: Das Sticker-Studio stellt damit Motive
 * frei, und sie geben genau das zurück, was ein Maskenteil braucht – ein Byte
 * je Bildpunkt. Es gibt also nichts nachzuladen und nichts nachzubauen; diese
 * Datei ist nur die Übersetzung zwischen zwei Formen desselben Dings.
 *
 * **Was ein Netz liefert und was nicht.** Es liefert eine Silhouette, keine
 * Tiefenkarte. Für „den Himmel dunkler“ oder „das Gesicht heller“ ist das
 * genau richtig. Für Tiefenschärfe heisst es: Alles ausserhalb des Motivs
 * wird gleich weich, der Busch einen Meter dahinter wie der Berg. Das ist
 * auch das, was der Porträtmodus eines Telefons überwiegend tut, aber es ist
 * keine echte Tiefe – und eine echte wäre ein weiteres Modell zum Laden.
 *
 * **Gemessen, bevor das hier entstand** (Chromium, synthetisches Foto):
 *
 *     Netz     512 × 384    1024 × 768    4000 × 3000
 *     Person     1096 ms*        36 ms         804 ms
 *     Motiv      4623 ms*      1605 ms        1768 ms
 *     (* der erste Lauf, in dem die Laufzeit selbst geladen wird)
 *
 * Zwei Folgerungen stecken darin:
 *
 * 1. Ein Netzlauf ist eine EINMALIGE Handlung mit Fortschrittsanzeige,
 *    niemals etwas, das an einem Regler hängt. Danach ist die Maske da, und
 *    jeder Regler läuft wieder flüssig.
 * 2. Die Kosten hängen kaum an der Bildgrösse – U²-Net rechnet intern immer
 *    auf 320 × 320, MediaPipe auf 256er Kacheln. Was zurückkommt, ist
 *    hochskaliert. Deshalb läuft das Netz hier auf einer VERKLEINERTEN
 *    Fassung (`vorlageAus`, höchstens 1536 Punkte Kante): Bei einem
 *    4000 × 3000-Foto sind das 1,77 MB Maske statt 12 MB, für keinen
 *    Fitzel weniger Information.
 */

import { EngineError, engineAvailable, engineInfo, runEngine } from '../stickers/engines/index.js';
import { kanteWeichzeichnen, maskeTraegt, vorlageAus } from '../stickers/engines/prepare.js';
import { naechsteMarke } from './maske.js';
import type { Maskenteil, NetzTeil } from './doc.js';

export type Netzart = 'person' | 'object';

/** Ob das Verfahren gerade benutzt werden darf – eingeschaltet und unterstützt. */
export function netzVerfuegbar(netz: Netzart): boolean {
  return engineAvailable(netz);
}

/** Der Satz, den man zeigt, wenn es nicht geht. */
export function netzGrund(netz: Netzart): string {
  return `„${engineInfo(netz).label}“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten.`;
}

/**
 * Die Vorlage je Quellbild gemerkt.
 *
 * Ein zweiter Netzlauf auf demselben Foto soll nicht noch einmal
 * verkleinern und auslesen. Im Sticker-Studio ist derselbe Griff nachgemessen
 * 0,25 s statt 1 s je Lauf wert.
 *
 * Eine `WeakMap`: Ist das Bild fort, geht die Vorlage mit – sie ist bei einem
 * grossen Foto mehrere Megabyte gross.
 */
const vorlagen = new WeakMap<CanvasImageSource, ReturnType<typeof vorlageAus>>();

function vorlageHolen(bild: HTMLImageElement) {
  const da = vorlagen.get(bild);
  if (da) return da;
  const neu = vorlageAus(bild, bild.naturalWidth, bild.naturalHeight);
  vorlagen.set(bild, neu);
  return neu;
}

/**
 * Lässt ein Netz laufen und macht aus seinem Ergebnis ein Maskenteil.
 *
 * Wirft `EngineError` mit einem Satz, den man dem Anwender zeigen kann – das
 * ist im Sticker-Studio schon die Regel und hier genauso richtig: „Fehler“
 * hilft niemandem, „ist abgeschaltet, du kannst es einschalten“ schon.
 */
export async function netzTeilRechnen(
  bild: HTMLImageElement,
  netz: Netzart,
  melden?: (text: string) => void,
): Promise<Maskenteil> {
  if (!netzVerfuegbar(netz)) throw new EngineError(netzGrund(netz), netz);

  melden?.('Bild wird vorbereitet …');
  const vorlage = vorlageHolen(bild);

  const roh = await runEngine(netz, {
    image: vorlage.image,
    fortschritt: (_anteil, text) => melden?.(text),
  });

  /*
   * Die Kante weichzeichnen, bevor daraus ein Maskenteil wird.
   *
   * Ein Netz liefert eine harte Entscheidung je Bildpunkt. Für einen
   * Freisteller ist das richtig; für eine Anpassung, die überblendet wird,
   * ist eine harte Kante das, was ein Bild künstlich aussehen lässt. Ein
   * Punkt Weichzeichner reicht – die Maske wird ohnehin auf ein gröberes
   * Raster gebracht und bilinear gelesen.
   */
  const weich = kanteWeichzeichnen(roh, vorlage.image.width, vorlage.image.height, 1);

  if (!maskeTraegt(weich)) {
    throw new EngineError(
      netz === 'person'
        ? 'Auf diesem Bild wurde niemand gefunden. Nimm eine der anderen Masken.'
        : 'Auf diesem Bild wurde kein Motiv gefunden. Nimm eine der anderen Masken.',
      netz,
    );
  }

  const teil: NetzTeil & { id: string; modus: 'dazu'; umkehren: boolean } = {
    id: `n${naechsteMarke()}`,
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz,
    // Die Grösse der VORLAGE, nicht die des Originals: Alles Weitere rechnet
    // über die Bildmitten um, und beide Räume sind über das Originalbild
    // verbunden.
    breite: vorlage.image.width,
    hoehe: vorlage.image.height,
    alpha: weich,
    /*
     * Die Ersatzidentität. Ein `Uint8Array` lässt sich nicht in einen
     * Schlüsselstring schreiben – es würde `[object Object]`, und der
     * Zwischenspeicher hielte zwei verschiedene Masken für dieselbe.
     */
    marke: naechsteMarke(),
  };
  return teil;
}
