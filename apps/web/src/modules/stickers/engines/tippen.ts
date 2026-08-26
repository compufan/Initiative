/**
 * „Antippen (genau)“ – NanoSAM über ONNX Runtime.
 *
 * Das vorhandene „Antippen“ flutet vom angetippten Punkt aus über ähnliche
 * Farben. Das trägt bei einem Motiv vor gleichmässigem Grund und versagt
 * überall sonst: Ein Hund vor einer Wiese hat dieselben Grüntöne im Fell wie
 * daneben, und das Glanzlicht auf einer Flasche fällt aus der Auswahl heraus,
 * weil es weiss ist und der Rest braun.
 *
 * Dieses Verfahren tut dasselbe, versteht aber, was ein Gegenstand ist – ohne
 * eine Liste von Gegenständen zu kennen. Man tippt auf die Flasche, und die
 * Flasche kommt, samt Glanzlicht.
 *
 * # Warum das trotz 27 MB als „Antippen“ taugt
 *
 * Weil das Netz zweigeteilt ist. Der **Encoder** sieht das Bild an und macht
 * daraus eine Einbettung – das ist der teure Teil und passiert einmal je Foto.
 * Der **Decoder** bekommt diese Einbettung plus den angetippten Punkt und
 * liefert die Maske; er ist winzig und läuft in Millisekunden.
 *
 * Deshalb wird die Einbettung hier gehalten, solange dasselbe Bild bearbeitet
 * wird. Der erste Tipp kostet, jeder weitere ist umsonst.
 *
 * # Die Falle, an der so ein Einbau scheitert
 *
 * Das Bild geht mit **512** Kantenlänge hinein, die Punkte aber im Maßstab
 * **1024**, und die Antwort kommt auf einem **256er** Gitter. Drei Zahlen, die
 * alle nach „Auflösung“ aussehen und verschiedene Dinge meinen. Wer sie
 * verwechselt, bekommt keine Fehlermeldung, sondern eine Maske, die um das
 * Seitenverhältnis danebenliegt – und hält dann das Netz für schlecht.
 *
 * Nachgeprüft, nicht angenommen: Die Kette wurde vor dem Einbau ausserhalb des
 * Browsers gegen ein Bild mit bekannter Antwort gerechnet (helles Rechteck auf
 * dunklem Grund, absichtlich nicht quadratisch). IoU 0,972.
 *
 * Zur Lizenz: Apache-2.0, durchgehend – die ONNX-Fassung von
 * `dragonSwing/nanosam`, deren Vorlage `binh234/nanosam` und
 * `NVIDIA-AI-IOT/nanosam`, der Decoder aus MobileSAM bzw. Segment Anything.
 * Keine Auflage zur Offenlegung, keine Einschränkung auf nicht-kommerzielle
 * Nutzung.
 */

import type { InferenceSession, Tensor } from 'onnxruntime-web';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { briefkasten, type Bildpunkte } from './prepare.js';

/** Kantenlänge, mit der das **Bild** in den Encoder geht. */
const BILD = 512;
/** Maßstab, in dem die **Punkte** erwartet werden. Nicht BILD! */
const PUNKT = 1024;
/** Kantenlänge der Maske, die der Decoder zurückgibt. Auch nicht BILD. */
const MASKE = 256;

const ENCODER_URL = '/models/nanosam-encoder.onnx';
const DECODER_URL = '/models/nanosam-decoder.onnx';

export type Fortschritt = (anteil: number, text: string) => void;

let encoder: InferenceSession | null = null;
let decoder: InferenceSession | null = null;
let ladend: Promise<void> | null = null;

/**
 * Die Einbettung des zuletzt angesehenen Bildes.
 *
 * Absichtlich hier und **nicht** im Sticker-Dokument: Das wird bei jedem
 * Rückgängig-Schritt kopiert, und bei dreissig Schritten wären das dreissigmal
 * vier Megabyte. Hier liegt sie einmal, am Bild festgemacht, und wird von
 * `releaseTippen()` wieder freigegeben.
 */
let letztesBild: Bildpunkte | null = null;
let letzteEinbettung: Tensor | null = null;

async function laden(melden?: Fortschritt): Promise<void> {
  if (encoder && decoder) return;
  if (!ladend) {
    ladend = (async () => {
      melden?.(0, 'Rechenwerk wird geladen …');
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      ort.env.wasm.numThreads = 1;
      // In den Arbeiter, damit die Oberfläche während des Rechnens lebt.
      //
      // Bewusst nicht über `ort-laufzeit.ts`: Jenes entscheidet für
      // `onnxruntime-web/webgpu`, eine andere, in sich geschlossene Fassung
      // der Laufzeit mit eigener Umgebung. Hier gibt es nichts zu entscheiden
      // – dieses Verfahren rechnet immer auf dem Prozessor, und `proxy` darf
      // deshalb nie auf `false` fallen.
      ort.env.wasm.proxy = true;

      melden?.(0.2, 'Modell wird geladen …');
      const [e, d] = await Promise.all([
        ort.InferenceSession.create(ENCODER_URL, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        }),
        ort.InferenceSession.create(DECODER_URL, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        }),
      ]);
      encoder = e;
      decoder = d;
    })().catch((fehler: unknown) => {
      ladend = null;
      throw fehler;
    });
  }
  await ladend;
}

/**
 * Die Maske zu den angetippten Punkten.
 *
 * Die Punkte liegen in Bildpunkten des übergebenen Bildes – nicht in
 * Koordinaten der Sticker-Fläche. Das Umrechnen erledigt der Aufrufer.
 *
 * `dazu: false` heisst „das ausdrücklich nicht“. Das ist der Unterschied zur
 * Farbflutung: Wer bei einer Flasche das Etikett nicht mitnehmen will, tippt
 * es weg, statt an der Toleranz zu drehen und zu hoffen.
 */
export async function tippenMask(
  image: ImageData,
  punkte: { x: number; y: number; dazu: boolean }[],
  melden?: Fortschritt,
): Promise<Uint8Array> {
  if (punkte.length === 0) {
    throw new Error('Tippe auf das, was bleiben soll.');
  }
  if (!punkte.some((p) => p.dazu)) {
    // Nur Minus-Tipps ergeben nichts: Das Netz braucht mindestens einen Punkt,
    // von dem aus es wachsen kann.
    throw new Error('Tippe zuerst auf das, was bleiben soll – dann kannst du wegnehmen.');
  }
  await laden(melden);
  const ort = await import('onnxruntime-web/wasm');
  if (!encoder || !decoder) throw new Error('Das Modell steht nicht bereit.');

  const { width, height } = image;

  // --- Der teure Teil, einmal je Bild --------------------------------------
  if (letztesBild !== image || !letzteEinbettung) {
    melden?.(0.6, 'Bild wird angesehen …');
    const { tensor } = briefkasten(image, BILD);
    const eingabe = new ort.Tensor('float32', tensor, [1, 3, BILD, BILD]);
    const antwort = await encoder.run({ [encoder.inputNames[0]]: eingabe });
    letzteEinbettung = antwort[encoder.outputNames[0]] as Tensor;
    letztesBild = image;
  }

  // --- Der billige Teil, je Tipp -------------------------------------------
  // Genau hier liegt der Gewinn: Der zweite und jeder weitere Tipp kostet nur
  // noch diesen Aufruf. Deshalb werden IMMER alle Punkte frisch geschickt,
  // statt auf der vorigen Antwort aufzubauen – das ist billig, und es macht
  // Rückgängig trivial: Punkt aus der Liste nehmen, neu rechnen. Ein
  // mitgeführtes `mask_input` müsste bei jedem Rückgängig verworfen werden,
  // weil es dann nicht mehr zur Punktliste passt.
  melden?.(0.9, 'Wird freigestellt …');

  // Punkte im 1024er Maßstab – der Decoder stammt aus MobileSAM und rechnet
  // in dessen Koordinaten, nicht in denen des Encoders.
  const massstab = PUNKT / Math.max(width, height);
  const koordinaten = new Float32Array(punkte.length * 2);
  const marken = new Float32Array(punkte.length);
  punkte.forEach((punkt, i) => {
    koordinaten[i * 2] = punkt.x * massstab;
    koordinaten[i * 2 + 1] = punkt.y * massstab;
    // 1 = gehört dazu, 0 = gehört ausdrücklich nicht dazu.
    marken[i] = punkt.dazu ? 1 : 0;
  });

  const ergebnis = await decoder.run({
    image_embeddings: letzteEinbettung,
    point_coords: new ort.Tensor('float32', koordinaten, [1, punkte.length, 2]),
    point_labels: new ort.Tensor('float32', marken, [1, punkte.length]),
    mask_input: new ort.Tensor('float32', new Float32Array(MASKE * MASKE), [1, 1, MASKE, MASKE]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
  });

  const iou = ergebnis.iou_predictions.data as Float32Array;
  const roh = ergebnis.low_res_masks.data as Float32Array;

  // Das Netz schlägt vier Masken vor – „nur das Glas“, „Glas mit Inhalt“,
  // „der ganze Tisch“. Der iou-Kopf sagt, welche es für die beste hält.
  //
  // Aber nur beim ERSTEN Punkt: Sobald jemand nachgebessert hat, ist die
  // Mehrdeutigkeit ja gerade aufgelöst – dann würde ein Wechsel des Kopfes
  // die Auswahl bei jedem Tipp umspringen lassen, statt sie zu verfeinern.
  // Die Referenzimplementierungen von SAM machen es genauso.
  let beste = 0;
  if (punkte.length === 1) {
    for (let i = 1; i < iou.length; i += 1) if (iou[i] > iou[beste]) beste = i;
  }

  return maskeAusLogits(roh, beste, width, height);
}

/**
 * Aus den Logits des Decoders eine Maske in Bildgrösse machen.
 *
 * Ausgelagert und getrennt geprüft, weil hier die dritte der drei Zahlen
 * lauert: Die Antwort liegt auf einem 256er Gitter, und **gültig ist davon nur
 * der Ausschnitt**, der dem Seitenverhältnis des Bildes entspricht. Der Rest
 * ist der Rand der Briefkasten-Einbettung und enthält Unsinn. Wer ihn
 * mitskaliert, staucht die Maske gegen das Bild.
 */
export function maskeAusLogits(
  roh: Float32Array,
  index: number,
  breite: number,
  hoehe: number,
): Uint8Array {
  const s = MASKE / Math.max(breite, hoehe);
  const lx = Math.max(1, Math.round(breite * s));
  const ly = Math.max(1, Math.round(hoehe * s));
  const versatz = index * MASKE * MASKE;

  // Bilinear aus dem gültigen Ausschnitt. Die Logits sind roh; die Grenze
  // zwischen „drin“ und „draussen“ liegt bei 0, deshalb wird um sie herum
  // weich abgestuft statt hart geschnitten – das gibt eine Kante, die auf
  // einem Sticker nicht ausgerissen aussieht.
  const links = new Int32Array(breite);
  const rechts = new Int32Array(breite);
  const anteilX = new Float32Array(breite);
  for (let x = 0; x < breite; x += 1) {
    const genau = Math.min(lx - 1, Math.max(0, ((x + 0.5) * lx) / breite - 0.5));
    const l = Math.floor(genau);
    links[x] = l;
    rechts[x] = Math.min(lx - 1, l + 1);
    anteilX[x] = genau - l;
  }

  const alpha = new Uint8Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    const genau = Math.min(ly - 1, Math.max(0, ((y + 0.5) * ly) / hoehe - 0.5));
    const oben = Math.floor(genau);
    const unten = Math.min(ly - 1, oben + 1);
    const ay = genau - oben;
    const zOben = versatz + oben * MASKE;
    const zUnten = versatz + unten * MASKE;
    const ziel = y * breite;

    for (let x = 0; x < breite; x += 1) {
      const l = links[x];
      const r = rechts[x];
      const ax = anteilX[x];
      const o = roh[zOben + l] + (roh[zOben + r] - roh[zOben + l]) * ax;
      const u = roh[zUnten + l] + (roh[zUnten + r] - roh[zUnten + l]) * ax;
      const wert = o + (u - o) * ay;
      // Ein flacher Übergang um die Null: ab +2 ganz drin, ab −2 ganz draussen.
      alpha[ziel + x] = Math.max(0, Math.min(255, Math.round((wert / 4 + 0.5) * 255)));
    }
  }
  return alpha;
}

/** Gibt Modelle und Einbettung wieder frei – zusammen rund 31 MB. */
export async function releaseTippen(): Promise<void> {
  await encoder?.release();
  await decoder?.release();
  encoder = null;
  decoder = null;
  ladend = null;
  letztesBild = null;
  letzteEinbettung = null;
}
