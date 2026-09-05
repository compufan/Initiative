/**
 * Depth Anything V2 Small – eine echte Tiefenkarte aus einem gewöhnlichen Foto.
 *
 * # Warum ausgerechnet dieses Modell
 *
 * Weil es das einzige ist, das die Lizenzfrage besteht. Geprüft wurden Depth
 * Pro (apple-amlr, ausdrücklich nicht kommerziell), Marigold (~5 GB),
 * UniDepth (Code und Gewichte CC-BY-NC), Metric3D (Gewichte ganz ohne
 * Lizenz – die verbreitete CC0-Angabe stammt vom Umwandler, nicht vom
 * Urheber), Distill-Any-Depth (destilliert aus einem Modell mit
 * kommerziellem Vorbehalt) und MiDaS v2.1 small (sauber, aber 64 MB für eine
 * feste 256er Kante).
 *
 * **Die eine harte Auflage: nur `vits`.** Im Wortlaut des Urhebers:
 * „Depth-Anything-V2-Small model is under the Apache-2.0 license.
 * Depth-Anything-V2-Base/Large/Giant models are under the CC-BY-NC-4.0
 * license.“ Zwischen benutzbar und rechtswidrig liegt hier ein Zeichen im
 * Dateinamen. Dasselbe steht bei der URL in `scripts/prepare-models.mjs`, und
 * dort gehört es auch hin – wer das Modell einmal „nur zum Vergleich“ auf
 * `vitb` hochzieht, hat die Lizenz gebrochen.
 *
 * # Was es liefert
 *
 * Inverse relative Tiefe: ein grosser Wert heisst nah, ein kleiner fern, und
 * die Skala ist von Bild zu Bild verschieden. Am Probebild nachgemessen: 0,42
 * am Himmel, 1,75 am nahen Boden, 2,12 am nächsten Gegenstand. Das
 * Normalisieren übernimmt `tiefe.ts`.
 *
 * # Was es NICHT liefert
 *
 * Eine Silhouette. Kein monokulares Tiefenmodell erreicht die Kantenschärfe
 * einer Freistellmaske – in der Messreihe von Depth Pro (Tabelle 2, P3M)
 * kommt Depth Anything V2 auf einen Randtreffer von 0,131, wo eine
 * Freistellmaske praktisch 1 hat. Wer damit ein Porträt freistellt, verliert
 * an Haaren sichtbar. Die Tiefe gehört an den RADIUS der Unschärfe, die
 * Silhouette weiter an „Person“ oder „Motiv“. Beides zusammen ist die einzige
 * Kombination, die gegenüber einer reinen Maske gewinnt.
 *
 * # Nachgemessen (Chromium, WASM, ein Faden – wie im Gerät)
 *
 *     Laufzeit laden          54 ms
 *     Sitzung laden          783 ms
 *     Lauf bei 518 × 392    2528 / 2401 ms
 *
 * Zum Vergleich steht in derselben Umgebung U²-Net bei 320 × 320 mit rund
 * 1,4 s, und im Gerät (Flip 6) bei 1,7 s. Auf dem Telefon sind also rund
 * 3 Sekunden zu erwarten – ein Knopfdruck mit Fortschrittsanzeige, nichts,
 * was an einem Regler hängen darf.
 *
 * # Speicher
 *
 * Der eigentliche Grund für die beiden Besonderheiten unten. Bei 518 × 518
 * gemessen: die Sitzung kostet 230 MB, die Spitze während des Laufs 597 MB.
 * Daneben liegt im Editor ein Foto mit 4000 × 3000 – 48 MB je Kopie, und der
 * Editor hält mehrere. Deshalb:
 *
 * 1. **Seitenrichtig rechnen**, nicht quadratisch (spart bei 4:3 ein Viertel).
 * 2. **Die Sitzung nach dem Lauf freigeben**, anders als bei den
 *    Freistellern. Ein zweiter Lauf kostet dann wieder 0,8 s fürs Laden –
 *    das ist der Preis dafür, dass der Editor danach nicht am Speicher
 *    stirbt. Und ein zweiter Lauf ist selten: Die Karte hängt am Foto, nicht
 *    am Regler.
 */

import { EngineError, engineAvailable, engineInfo } from '../stickers/engines/index.js';
import { flaechenMittel, vorlageAus } from '../stickers/engines/prepare.js';
import type { InferenceSession } from 'onnxruntime-web';
// Die Laufzeitdateien ueber `?url`, nicht aus `public/`: Vite gibt uns die
// fertige Adresse samt Inhalts-Hash, und der Entwicklungsserver liefert sie
// aus. Die Bytes wandern dabei nicht ins Bundle, nur die Adresse.
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

import type { Maskenteil, TiefenTeil } from './doc.js';
import { naechsteMarke } from './maske.js';
import { netzGroesse, tiefeNormalisieren } from './tiefe.js';

const MODELL_URL = '/models/depth-anything-v2-small-uint8.onnx';

/** Normalisierung wie bei ImageNet – andere Werte geben eine flache Karte. */
const MITTEL = [0.485, 0.456, 0.406];
const ABWEICHUNG = [0.229, 0.224, 0.225];

export type Fortschritt = (text: string) => void;

/** Ob die Tiefenkarte gerade benutzt werden darf. */
export function tiefeVerfuegbar(): boolean {
  return engineAvailable('tiefe');
}

/** Der Satz, den man zeigt, wenn es nicht geht. */
export function tiefeGrund(): string {
  return `„${engineInfo('tiefe').label}“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten.`;
}

/**
 * Die Vorlage je Quellbild gemerkt – dieselbe wie bei den Freistellern.
 *
 * Eine `WeakMap`: Ist das Bild fort, geht die Vorlage mit.
 */
const vorlagen = new WeakMap<CanvasImageSource, ReturnType<typeof vorlageAus>>();

function vorlageHolen(bild: HTMLImageElement) {
  const da = vorlagen.get(bild);
  if (da) return da;
  const neu = vorlageAus(bild, bild.naturalWidth, bild.naturalHeight);
  vorlagen.set(bild, neu);
  return neu;
}

/** Bringt das Bild in die Form, die das Modell erwartet: drei Kanäle nacheinander. */
function vorbereiten(
  bild: ImageData | { width: number; height: number; data: Uint8ClampedArray },
  w: number,
  h: number,
): Float32Array {
  const { data } = flaechenMittel(bild, w, h);
  const flaeche = w * h;
  const tensor = new Float32Array(3 * flaeche);
  for (let i = 0; i < flaeche; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 3; k += 1)
      tensor[k * flaeche + i] = (data[at + k] / 255 - MITTEL[k]) / ABWEICHUNG[k];
  }
  return tensor;
}

/**
 * Rechnet die Tiefenkarte und macht daraus ein Maskenteil.
 *
 * Wirft `EngineError` mit einem Satz, den man dem Anwender zeigen kann.
 */
export async function tiefenTeilRechnen(
  bild: HTMLImageElement,
  melden?: Fortschritt,
): Promise<Maskenteil> {
  if (!tiefeVerfuegbar()) throw new EngineError(tiefeGrund(), 'tiefe');

  melden?.('Bild wird vorbereitet …');
  const vorlage = vorlageHolen(bild);
  const { w, h } = netzGroesse(vorlage.image.width, vorlage.image.height);

  // Vor dem Import melden, nicht danach: Die Laufzeit selbst sind rund 14 MB.
  // Wer bis hierher nichts hört, sieht einen Knopf, der nichts tut.
  melden?.('Rechenwerk wird geladen …');
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
  // Mehrere Fäden brauchten die Kopfzeilen COOP/COEP. Die setzen wir nicht –
  // sie würden eingebettete Inhalte lahmlegen. Also einer.
  ort.env.wasm.numThreads = 1;
  // In einen Arbeiter auslagern: Drei Sekunden im Hauptfaden sind drei
  // Sekunden, in denen sich nichts bewegt, kein Text wechselt und kein
  // Abbrechen möglich ist. Das ist der Unterschied zwischen „dauert“ und
  // „hängt“.
  ort.env.wasm.proxy = true;

  melden?.('Modell wird geladen …');
  let sitzung: InferenceSession | null = null;
  try {
    sitzung = await ort.InferenceSession.create(MODELL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    melden?.('Tiefe wird geschätzt …');
    const eingabe = new ort.Tensor('float32', vorbereiten(vorlage.image, w, h), [1, 3, h, w]);
    const ergebnis = await sitzung.run({ [sitzung.inputNames[0]]: eingabe });
    const roh = ergebnis[sitzung.outputNames[0]].data as Float32Array;
    const karte = tiefeNormalisieren(roh, w, h);

    const teil: TiefenTeil & { id: string; modus: 'dazu'; umkehren: boolean } = {
      id: `d${naechsteMarke()}`,
      modus: 'dazu',
      umkehren: false,
      art: 'tiefe',
      breite: karte.breite,
      hoehe: karte.hoehe,
      karte: karte.feld,
      /*
       * Vorgabe: Fokus ganz vorne, halbe Spanne.
       *
       * „Ganz vorne“ heisst: Was dem Betrachter am nächsten ist, bleibt
       * scharf – der übliche Fall, und der einzige, in dem die Vorgabe ohne
       * Nachjustieren schon etwas Sinnvolles zeigt. Die halbe Spanne lässt
       * die hintere Hälfte des Bildes voll unscharf werden.
       */
      fokus: 1,
      spanne: 0.5,
      /*
       * Die Ersatzidentität. Ein `Uint8Array` lässt sich nicht in einen
       * Schlüsselstring schreiben – es würde `[object Object]`, und der
       * Zwischenspeicher hielte zwei verschiedene Karten für dieselbe.
       */
      marke: naechsteMarke(),
    };
    return teil;
  } catch (fehler) {
    if (fehler instanceof EngineError) throw fehler;
    const grund = fehler instanceof Error ? fehler.message : 'Unbekannter Fehler';
    throw new EngineError(grund, 'tiefe');
  } finally {
    // Immer freigeben – auch nach einem Fehler. Siehe der Abschnitt über den
    // Speicher ganz oben.
    await sitzung?.release().catch(() => undefined);
  }
}
