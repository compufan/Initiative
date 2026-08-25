/**
 * Holt die Bausteine fuer das Freistellen ins `public/`-Verzeichnis.
 *
 * Warum ein Skript und nicht einfach im Git ablegen: die WASM-Laufzeit von
 * MediaPipe ist rund 22 MB, die Modelle noch einmal ein halbes. Das gehoert
 * nicht in die Versionsverwaltung – jedes `git clone` waere sonst dauerhaft
 * belastet. Stattdessen laeuft dieses Skript vor jedem Build (auch bei
 * Vercel) und legt die Dateien frisch ab.
 *
 * Nichts davon landet im JavaScript-Bundle. Die App laedt eine Datei erst,
 * wenn jemand das jeweilige Verfahren zum ersten Mal benutzt.
 */
import { createRequire } from 'node:module';
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const publicDir = join(hier, '..', 'public');
const require = createRequire(import.meta.url);

/** Die WASM-Laufzeit von MediaPipe. Beide Varianten: mit und ohne SIMD. */
const WASM_DATEIEN = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  // Ohne diese beiden scheitert der Start auf iOS vor 16.4: MediaPipe fragt
  // die "nosimd"-Namen an, bekommt 404 und bricht ab.
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

/**
 * Die Modelle. Feste Versionsnummer statt "latest", damit ein Build von
 * heute dieselben Dateien bekommt wie einer von naechster Woche.
 */
const MODELLE = [
  {
    name: 'selfie-segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    mindestGroesse: 200_000,
  },
  {
    name: 'blaze-face-short-range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    mindestGroesse: 150_000,
  },
  {
    // U^2-Net, kleine Fassung. Apache-2.0 (github.com/xuebinqin/U-2-Net).
    // Bewusst NICHT RMBG-1.4 oder @imgly/background-removal: das eine ist
    // ausdruecklich nicht fuer kommerzielle Nutzung freigegeben, das andere
    // steht unter AGPL – bei einer ausgelieferten Web-App hiesse das, den
    // gesamten Quelltext offenlegen zu muessen.
    name: 'u2netp.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    mindestGroesse: 4_000_000,
  },
];

async function vorhanden(pfad, mindestGroesse = 1) {
  try {
    return (await stat(pfad)).size >= mindestGroesse;
  } catch {
    return false;
  }
}

async function wasmKopieren() {
  // `package.json` steht nicht in den "exports" des Pakets – deshalb ueber
  // den Haupteinstieg gehen und dessen Verzeichnis nehmen.
  const quelle = dirname(require.resolve('@mediapipe/tasks-vision'));
  const ziel = join(publicDir, 'mediapipe');
  await mkdir(ziel, { recursive: true });
  for (const datei of WASM_DATEIEN) {
    await copyFile(join(quelle, 'wasm', datei), join(ziel, datei));
  }
  console.log(`  MediaPipe-Laufzeit: ${WASM_DATEIEN.length} Dateien nach public/mediapipe/`);
}

async function modelleLaden() {
  const ziel = join(publicDir, 'models');
  await mkdir(ziel, { recursive: true });
  for (const modell of MODELLE) {
    const pfad = join(ziel, modell.name);
    if (await vorhanden(pfad, modell.mindestGroesse)) {
      console.log(`  ${modell.name}: schon da`);
      continue;
    }
    const antwort = await fetch(modell.url);
    if (!antwort.ok) throw new Error(`${modell.name}: HTTP ${antwort.status} von ${modell.url}`);
    const daten = Buffer.from(await antwort.arrayBuffer());
    if (daten.length < modell.mindestGroesse) {
      // Ein Fehlerbild oder eine HTML-Seite statt des Modells – lieber laut
      // scheitern als eine kaputte Datei ausliefern.
      throw new Error(`${modell.name}: nur ${daten.length} Bytes erhalten, das kann nicht stimmen`);
    }
    await writeFile(pfad, daten);
    console.log(`  ${modell.name}: ${(daten.length / 1024).toFixed(0)} KB geladen`);
  }
}

console.log('Freistell-Bausteine bereitlegen …');
await wasmKopieren();
await modelleLaden();
console.log('Fertig.');
