/**
 * „Hohe Qualität“ – BiRefNet-lite über ONNX Runtime.
 *
 * Dasselbe Ziel wie „Beliebiges Objekt“, nur genauer: BiRefNet trennt Haare,
 * Zaunlatten und Brillenbügel dort, wo U²-Net einen Klumpen macht. Der Preis
 * steht in der Beschreibung und wird nicht schöngeredet – knapp 94 MB einmalig
 * und auf einem älteren Telefon spürbar mehr Rechenzeit.
 *
 * Zur Lizenz: BiRefNet steht unter MIT, ebenso die hier verwendete
 * ONNX-Fassung (`studioludens/birefnet-lite-512`, abgeleitet von
 * `ZhengPeng7/BiRefNet_lite`). Keine Auflage zur Offenlegung, keine
 * Einschränkung auf nicht-kommerzielle Nutzung – anders als bei RMBG-1.4 oder
 * `@imgly/background-removal`.
 *
 * Die Datei liegt beim eigenen Server. Sie wird beim Bauen einmal geholt
 * (`scripts/prepare-models.mjs`); das Gerät des Anwenders spricht nie mit
 * Hugging Face.
 */

import type { InferenceSession } from 'onnxruntime-web';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { flaechenMittel } from './prepare.js';

/** Kantenlänge, auf die diese Fassung festgelegt ist. */
const EINGABE = 512;
const MODEL_URL = '/models/birefnet-lite-512.onnx';

/** Normalisierung wie bei BiRefNet: erst auf 0…1, dann ImageNet-Werte. */
const MITTEL = [0.485, 0.456, 0.406];
const ABWEICHUNG = [0.229, 0.224, 0.225];

export type Fortschritt = (anteil: number, text: string) => void;

let session: InferenceSession | null = null;
let ladend: Promise<InferenceSession> | null = null;

/**
 * Holt die Modelldatei und sagt dabei, wie weit sie ist.
 *
 * Ein Fortschritt ist bei 94 MB kein Schmuck: Ohne ihn steht der Anwender
 * eine Minute vor einem Knopf, der nichts tut, und drückt ihn noch einmal.
 * Deshalb holen wir die Datei selbst, statt der Laufzeit nur die Adresse zu
 * geben – im Speicher kostet das nichts extra, sie würde sie ohnehin ganz
 * einlesen.
 */
async function modellHolen(melden?: Fortschritt): Promise<Uint8Array> {
  const antwort = await fetch(MODEL_URL);
  if (antwort.status === 404) {
    throw new Error(
      'Das Modell für „Hohe Qualität“ ist in dieser Fassung der App nicht vorhanden. Nimm solange „Beliebiges Objekt“.',
    );
  }
  if (!antwort.ok) throw new Error(`Das Modell konnte nicht geladen werden (${antwort.status}).`);

  const gesamt = Number(antwort.headers.get('content-length') ?? 0);
  if (!antwort.body) return new Uint8Array(await antwort.arrayBuffer());

  const leser = antwort.body.getReader();
  const stuecke: Uint8Array[] = [];
  let gelesen = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    stuecke.push(value);
    gelesen += value.length;
    melden?.(
      gesamt > 0 ? gelesen / gesamt : 0,
      `Modell wird geladen … ${(gelesen / 1024 / 1024).toFixed(0)} MB`,
    );
  }

  const daten = new Uint8Array(gelesen);
  let versatz = 0;
  for (const stueck of stuecke) {
    daten.set(stueck, versatz);
    versatz += stueck.length;
  }
  return daten;
}

async function loadSession(melden?: Fortschritt): Promise<InferenceSession> {
  if (session) return session;
  if (!ladend) {
    ladend = (async () => {
      const daten = await modellHolen(melden);
      melden?.(1, 'Modell wird vorbereitet …');
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      // Mehrere Threads brauchten COOP/COEP – die setzen wir nicht.
      ort.env.wasm.numThreads = 1;
      const created = await ort.InferenceSession.create(daten, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      session = created;
      return created;
    })().catch((error: unknown) => {
      ladend = null;
      throw error;
    });
  }
  return ladend;
}

/** Bringt das Bild auf 512×512 und in die Form, die das Modell erwartet. */
function vorbereiten(image: ImageData): Float32Array {
  const { data } = flaechenMittel(image, EINGABE);
  const flaeche = EINGABE * EINGABE;
  const tensor = new Float32Array(3 * flaeche);
  for (let i = 0; i < flaeche; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 3; k += 1) {
      tensor[k * flaeche + i] = (data[at + k] / 255 - MITTEL[k]) / ABWEICHUNG[k];
    }
  }
  return tensor;
}

/**
 * Rechnet die Maske aus.
 *
 * Rückgabe: ein Wert je Bildpunkt, 0 = weg, 255 = bleibt, in Bildgrösse.
 */
export async function birefnetMask(image: ImageData, melden?: Fortschritt): Promise<Uint8Array> {
  const runner = await loadSession(melden);
  melden?.(1, 'Wird freigestellt …');
  const ort = await import('onnxruntime-web/wasm');

  const eingabe = new ort.Tensor('float32', vorbereiten(image), [1, 3, EINGABE, EINGABE]);
  const ergebnis = await runner.run({ [runner.inputNames[0]]: eingabe });
  const roh = ergebnis[runner.outputNames[0]].data as Float32Array;

  // Die Ausgabe ist eine Wahrscheinlichkeit je Punkt und liegt bereits in
  // 0…1. Trotzdem gedehnt: Bei einem Motiv, das nie ganz sicher erkannt wird,
  // bliebe die Maske sonst durchgehend halbdurchsichtig.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const wert of roh) {
    if (wert < min) min = wert;
    if (wert > max) max = wert;
  }
  const spanne = max - min || 1;

  const { width, height } = image;
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(EINGABE - 1, Math.floor((y * EINGABE) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(EINGABE - 1, Math.floor((x * EINGABE) / width));
      const wert = (roh[sy * EINGABE + sx] - min) / spanne;
      alpha[y * width + x] = Math.max(0, Math.min(255, Math.round(wert * 255)));
    }
  }
  return alpha;
}

/** Gibt die Modelldaten wieder frei – hier besonders wichtig, es sind 94 MB. */
export async function releaseBirefnet(): Promise<void> {
  await session?.release();
  session = null;
  ladend = null;
}
