/**
 * „Person freistellen“ – MediaPipe Image Segmenter mit dem Selfie-Modell.
 *
 * Das Modell liefert für jeden Bildpunkt eine Wahrscheinlichkeit, dass er zu
 * einer Person gehört. Genau das ist schon die Maske, die wir brauchen: keine
 * Farbschwellen, keine Toleranz, kein Antippen.
 *
 * Rechnet vollständig im Gerät. Der Server sieht das Bild nie.
 */

import type { ImageSegmenter } from '@mediapipe/tasks-vision';
import { MODEL_URLS, loadFileset } from './runtime.js';

let segmenter: ImageSegmenter | null = null;
let ladend: Promise<ImageSegmenter> | null = null;

async function loadSegmenter(): Promise<ImageSegmenter> {
  if (segmenter) return segmenter;
  if (!ladend) {
    ladend = (async () => {
      const fileset = await loadFileset();
      const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
      const created = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URLS.person },
        runningMode: 'IMAGE',
        // Weiche Werte statt harter Klassen – sonst bekommt der Sticker eine
        // Treppenkante.
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      segmenter = created;
      return created;
    })().catch((error: unknown) => {
      ladend = null;
      throw error;
    });
  }
  return ladend;
}

/**
 * Baut die Maske für ein Bild.
 *
 * Rückgabe: ein Wert je Bildpunkt, 0 = weg, 255 = bleibt, in derselben Grösse
 * wie das übergebene Bild.
 */
export async function personMask(image: ImageData): Promise<Uint8Array> {
  const runner = await loadSegmenter();
  const result = runner.segment(image);
  const masks = result.confidenceMasks ?? [];

  // Nachgemessen am echten Modell (selfie_segmenter.tflite, float16): es
  // liefert GENAU EINE Karte, und deren Werte sind die Person – am Bildrand
  // 0, im Gesicht 1. Sie zu invertieren waere der klassische Fehlgriff: dann
  // bleibt der Hintergrund stehen und die Person verschwindet.
  // Modellfassungen mit zwei Karten legen den Hintergrund auf 0 und die
  // Person auf 1, deshalb dort der zweite Eintrag.
  const mask = masks[masks.length > 1 ? 1 : 0];
  if (!mask) {
    result.close();
    throw new Error('Das Modell hat keine Maske geliefert.');
  }

  const werte = mask.getAsFloat32Array();
  const alpha = new Uint8Array(image.width * image.height);
  const skaliert = resample(werte, mask.width, mask.height, image.width, image.height);
  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = Math.max(0, Math.min(255, Math.round(skaliert[i] * 255)));
  }

  result.close();
  return alpha;
}

/**
 * Bringt die Maske auf die Bildgrösse.
 *
 * MediaPipe liefert sie meist schon passend; bei einem sehr kleinen oder sehr
 * grossen Bild kann sie abweichen. Nächster-Nachbar reicht, weil die Werte
 * gleich danach ohnehin weichgezeichnet werden.
 */
function resample(
  werte: Float32Array,
  von: number,
  vonHoehe: number,
  nach: number,
  nachHoehe: number,
): Float32Array {
  if (von === nach && vonHoehe === nachHoehe) return werte;
  const out = new Float32Array(nach * nachHoehe);
  for (let y = 0; y < nachHoehe; y += 1) {
    const sy = Math.min(vonHoehe - 1, Math.floor((y * vonHoehe) / nachHoehe));
    for (let x = 0; x < nach; x += 1) {
      const sx = Math.min(von - 1, Math.floor((x * von) / nach));
      out[y * nach + x] = werte[sy * von + sx];
    }
  }
  return out;
}

/** Gibt die Modelldaten wieder frei – etwa wenn das Studio geschlossen wird. */
export function releasePerson(): void {
  segmenter?.close();
  segmenter = null;
  ladend = null;
}
