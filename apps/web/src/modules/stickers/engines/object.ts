/**
 * „Beliebiges Objekt freistellen“ – U²-Net über ONNX Runtime.
 *
 * Das Modell sucht nicht nach Menschen, sondern nach dem *auffälligsten*
 * Ding im Bild: Tasse, Hund, Auto, Blume. Genau dafür ist es da, wenn
 * „Person“ und „Gesicht“ nicht passen.
 *
 * Zur Wahl des Modells: naheliegend wären RMBG-1.4 oder
 * `@imgly/background-removal` gewesen – beide scheiden aus. RMBG ist
 * ausdrücklich nur für nicht-kommerzielle Nutzung freigegeben, und
 * `@imgly/background-removal` steht unter AGPL: bei einer Web-App, die an
 * jeden Besucher ausgeliefert wird, müsste dann der gesamte Quelltext
 * offengelegt werden. U²-Net steht unter Apache-2.0, ONNX Runtime unter MIT –
 * beides ohne solche Auflagen. Nebenbei ist die kleine Fassung mit 4,5 MB
 * ein Zehntel so gross wie die ursprünglich geplante Variante.
 *
 * Standardmässig abgeschaltet: es ist mit Abstand das schwerste der drei
 * Verfahren. Alles rechnet trotzdem im Gerät.
 */

import type { InferenceSession } from 'onnxruntime-web';
// Die beiden Laufzeitdateien ueber `?url` einbinden statt sie nach `public/`
// zu kopieren: Vite gibt uns die fertige Adresse, kuemmert sich um den
// Inhalts-Hash – und der Entwicklungsserver liefert sie korrekt aus. Aus
// `public/` importiert, verweigert Vite den Dienst ("This file is in /public
// and will be copied as-is"). Die Bytes wandern dabei nicht ins Bundle, nur
// die Adresse.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { flaechenMittel } from './prepare.js';

/** Kantenlänge, mit der U²-Net trainiert wurde. */
const EINGABE = 320;
const MODEL_URL = '/models/u2netp.onnx';

/** Normalisierung wie im Original – andere Werte liefern eine graue Maske. */
const MITTEL = [0.485, 0.456, 0.406];
const ABWEICHUNG = [0.229, 0.224, 0.225];

let session: InferenceSession | null = null;
let ladend: Promise<InferenceSession> | null = null;

export type Fortschritt = (anteil: number, text: string) => void;

async function loadSession(melden?: Fortschritt): Promise<InferenceSession> {
  if (session) return session;
  if (!ladend) {
    ladend = (async () => {
      // Vor dem Import melden, nicht danach: Die Laufzeit selbst sind rund
      // 14 MB. Wer bis hierher nichts hört, sieht einen Knopf, der nichts tut.
      melden?.(0, 'Rechenwerk wird geladen …');
      const ort = await import('onnxruntime-web/wasm');
      // Die Laufzeit liegt beim eigenen Server, nicht bei einem fremden CDN.

      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      // Mehrere Threads brauchten die Kopfzeilen COOP/COEP. Die setzen wir
      // nicht – sie würden eingebettete Inhalte lahmlegen. Also einer.
      ort.env.wasm.numThreads = 1;
      // In einen Arbeiter auslagern. Ein einzelner Faden auf der CPU rechnet
      // hier ein paar Sekunden – im Hauptfaden sind das ein paar Sekunden, in
      // denen sich nichts mehr bewegt, kein Text wechselt und kein Abbrechen
      // möglich ist. Das ist der Unterschied zwischen „dauert“ und „hängt“.
      //
      // Das bleibt hier stehen und geht **nicht** über `ort-laufzeit.ts`.
      // Jenes entscheidet für `onnxruntime-web/webgpu`, und das ist eine
      // andere, in sich geschlossene Fassung der Laufzeit mit eigener
      // Umgebung (nachgeprüft: die beiden Dateien teilen sich keinen Import).
      // Hier gibt es nichts zu entscheiden – dieses Verfahren rechnet immer
      // auf dem Prozessor. Wer es dort anschlösse, holte es bei jedem Gerät
      // mit Grafikeinheit in den Hauptfaden zurück.
      ort.env.wasm.proxy = true;
      const created = await ort.InferenceSession.create(MODEL_URL, {
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

/**
 * Bringt das Bild auf 320×320 und in die Form, die das Modell erwartet:
 * drei Farbkanäle nacheinander (nicht verschränkt), normalisiert.
 */
function vorbereiten(image: ImageData): Float32Array {
  // Verkleinern als Flächenmittel, nicht durch Herausgreifen einzelner
  // Punkte: Sonst wirft man auf dem Weg von 1024 auf 320 rund neun von zehn
  // Bildpunkten ungesehen weg – und damit genau die dünnen Strukturen, die
  // hier den Unterschied machen.
  const { data } = flaechenMittel(image, EINGABE);
  const flaeche = EINGABE * EINGABE;
  const tensor = new Float32Array(3 * flaeche);

  // Das Original teilt vor dem Normalisieren durch den hellsten Wert – und
  // zwar den des BEREITS verkleinerten Bildes, genau wie die Referenz-
  // Umsetzung (rembg: erst skalieren, dann `im / np.max(im)`). Bei einem
  // dunklen Foto macht dieser Schritt den Unterschied zwischen Maske und
  // grauem Brei.
  let hellster = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > hellster) hellster = data[i];
    if (data[i + 1] > hellster) hellster = data[i + 1];
    if (data[i + 2] > hellster) hellster = data[i + 2];
  }
  if (hellster === 0) hellster = 255;

  for (let i = 0; i < flaeche; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 3; k += 1) {
      const wert = data[at + k] / hellster;
      tensor[k * flaeche + i] = (wert - MITTEL[k]) / ABWEICHUNG[k];
    }
  }
  return tensor;
}

/**
 * Rechnet die Maske aus.
 *
 * Rückgabe: ein Wert je Bildpunkt, 0 = weg, 255 = bleibt, in Bildgrösse.
 */
export async function objectMask(image: ImageData, melden?: Fortschritt): Promise<Uint8Array> {
  const runner = await loadSession(melden);
  melden?.(1, 'Wird freigestellt …');
  const ort = await import('onnxruntime-web/wasm');

  const eingabe = new ort.Tensor('float32', vorbereiten(image), [1, 3, EINGABE, EINGABE]);
  const name = runner.inputNames[0];
  const ergebnis = await runner.run({ [name]: eingabe });

  // U²-Net gibt sieben Karten aus; die erste ist die feinste.
  const ausgabe = ergebnis[runner.outputNames[0]];
  const roh = ausgabe.data as Float32Array;

  // Die Werte liegen nicht garantiert in 0…1 – erst dehnen, dann umrechnen.
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

/** Gibt die Modelldaten wieder frei. */
export async function releaseObject(): Promise<void> {
  await session?.release();
  session = null;
  ladend = null;
}
