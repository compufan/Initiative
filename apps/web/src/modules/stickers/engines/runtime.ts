/**
 * Die gemeinsame Laufzeit für „Person“ und „Gesicht“.
 *
 * Beide Verfahren stecken im selben Paket und teilen sich dieselbe
 * WASM-Laufzeit. Die ist rund 11 MB gross – deshalb wird sie genau einmal
 * geladen, gemerkt, und wer danach von „Person“ auf „Gesicht“ wechselt,
 * zahlt nur noch die 224 KB für das zweite Modell.
 *
 * Ausgeliefert wird alles vom eigenen Server (`/mediapipe/`, `/models/`),
 * nicht von einem fremden Netz. Der Service Worker legt die Dateien nach dem
 * ersten Laden dauerhaft ab.
 */

import type { FilesetResolver as FilesetResolverType } from '@mediapipe/tasks-vision';

/** Wo die WASM-Dateien liegen. Ohne Schrägstrich am Ende – MediaPipe hängt an. */
const WASM_BASE = '/mediapipe';

export const MODEL_URLS = {
  person: '/models/selfie-segmenter.tflite',
  face: '/models/blaze-face-short-range.tflite',
} as const;

type Fileset = Awaited<ReturnType<typeof FilesetResolverType.forVisionTasks>>;

let filesetPromise: Promise<Fileset> | null = null;

/**
 * Lädt die WASM-Laufzeit – beim zweiten Aufruf sofort aus dem Gedächtnis.
 *
 * Schlägt das Laden fehl, wird der gemerkte Versuch verworfen, damit ein
 * späterer Anlauf (etwa nach kurzem Netzaussetzer) es erneut probiert und
 * nicht auf ewig am ersten Fehlschlag hängt.
 */
export async function loadFileset(): Promise<Fileset> {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      const { FilesetResolver } = await import('@mediapipe/tasks-vision');
      return FilesetResolver.forVisionTasks(WASM_BASE);
    })().catch((error: unknown) => {
      filesetPromise = null;
      throw error;
    });
  }
  return filesetPromise;
}

/**
 * Ob dieses Gerät die nötigen Bausteine mitbringt.
 *
 * WebAssembly gibt es seit iOS 11 überall – die Prüfung ist trotzdem da,
 * damit ein sehr altes Gerät sauber auf „Antippen“ zurückfällt statt mit
 * einer Fehlermeldung stehenzubleiben.
 */
export function runtimeSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}
