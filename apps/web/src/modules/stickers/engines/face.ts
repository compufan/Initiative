/**
 * „Gesicht freistellen“ – MediaPipe Face Detector.
 *
 * Der Detektor liefert Rechtecke, keine Maske. Für einen Sticker will man
 * aber keine harte Kiste, sondern einen Kopf: deshalb wird aus dem Rechteck
 * eine Ellipse, nach oben verlängert (Haare, Stirn) und mit weicher Kante.
 *
 * Wird angetippt, gewinnt das Gesicht an der angetippten Stelle. Ohne
 * Antippen nimmt es alle gefundenen Gesichter – ein Gruppenbild bleibt so
 * vollständig.
 */

import type { FaceDetector } from '@mediapipe/tasks-vision';
import { MODEL_URLS, loadFileset } from './runtime.js';

let detector: FaceDetector | null = null;
let ladend: Promise<FaceDetector> | null = null;

async function loadDetector(): Promise<FaceDetector> {
  if (detector) return detector;
  if (!ladend) {
    ladend = (async () => {
      const fileset = await loadFileset();
      const { FaceDetector } = await import('@mediapipe/tasks-vision');
      const created = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URLS.face },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.4,
      });
      detector = created;
      return created;
    })().catch((error: unknown) => {
      ladend = null;
      throw error;
    });
  }
  return ladend;
}

interface Kopf {
  mx: number;
  my: number;
  rx: number;
  ry: number;
}

/**
 * Macht aus dem Gesichts-Rechteck einen Kopf.
 *
 * Der Detektor umschliesst nur Augen bis Kinn. Ein Sticker ohne Stirn und
 * Haare sieht abgeschnitten aus, deshalb wird nach oben deutlich mehr
 * zugegeben als nach unten.
 */
function zuKopf(box: { originX: number; originY: number; width: number; height: number }): Kopf {
  const rx = box.width * 0.72;
  const ry = box.height * 0.95;
  return {
    mx: box.originX + box.width / 2,
    // Mittelpunkt nach oben schieben, damit die Ellipse Stirn und Haare fasst.
    my: box.originY + box.height * 0.42,
    rx,
    ry,
  };
}

/**
 * Baut die Maske: 255 innerhalb der Kopf-Ellipse, weich auslaufend nach aussen.
 */
export async function faceMask(
  image: ImageData,
  seed?: { x: number; y: number },
): Promise<Uint8Array> {
  const runner = await loadDetector();
  const { detections } = runner.detect(image);
  const boxen = detections
    .map((detection) => detection.boundingBox)
    .filter((box): box is NonNullable<typeof box> => Boolean(box));

  if (boxen.length === 0) {
    throw new Error('Kein Gesicht gefunden. Versuche „Person“ oder tippe das Motiv an.');
  }

  let koepfe = boxen.map(zuKopf);
  if (seed) {
    // Getippt heisst gemeint: das nächstgelegene Gesicht gewinnt, der Rest
    // fällt weg.
    let bester = koepfe[0];
    let beste = Number.POSITIVE_INFINITY;
    for (const kopf of koepfe) {
      const abstand = (kopf.mx - seed.x) ** 2 + (kopf.my - seed.y) ** 2;
      if (abstand < beste) {
        beste = abstand;
        bester = kopf;
      }
    }
    koepfe = [bester];
  }

  const { width, height } = image;
  const alpha = new Uint8Array(width * height);
  // Über wie viele Bildpunkte die Kante ausläuft – am kleineren Kopf weniger.
  const weich = Math.max(2, Math.min(...koepfe.map((k) => Math.min(k.rx, k.ry))) * 0.12);

  for (const kopf of koepfe) {
    const vonX = Math.max(0, Math.floor(kopf.mx - kopf.rx - weich));
    const bisX = Math.min(width - 1, Math.ceil(kopf.mx + kopf.rx + weich));
    const vonY = Math.max(0, Math.floor(kopf.my - kopf.ry - weich));
    const bisY = Math.min(height - 1, Math.ceil(kopf.my + kopf.ry + weich));

    for (let y = vonY; y <= bisY; y += 1) {
      for (let x = vonX; x <= bisX; x += 1) {
        const dx = (x - kopf.mx) / kopf.rx;
        const dy = (y - kopf.my) / kopf.ry;
        // 1 genau auf der Ellipse, kleiner innen, grösser aussen.
        const abstand = Math.sqrt(dx * dx + dy * dy);
        const rand = weich / Math.min(kopf.rx, kopf.ry);
        let wert: number;
        if (abstand <= 1) wert = 255;
        else if (abstand >= 1 + rand) wert = 0;
        else wert = Math.round(255 * (1 - (abstand - 1) / rand));
        const i = y * width + x;
        // Mehrere Gesichter addieren sich, überlappen sich also sauber.
        if (wert > alpha[i]) alpha[i] = wert;
      }
    }
  }

  return alpha;
}

/** Gibt die Modelldaten wieder frei. */
export function releaseFace(): void {
  detector?.close();
  detector = null;
  ladend = null;
}
