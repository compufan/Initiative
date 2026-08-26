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
// **Diese beiden Zeilen müssen zum Einstiegspunkt unten passen.**
//
// Hier stand die JSEP-Fassung, mit dem Kommentar, sie sei „dieselben
// Rechenwerke, zusätzlich der Weg auf die Grafikeinheit“. Für ältere
// ONNX-Runtime-Fassungen stimmte das. Seit 1.29 sind es zwei getrennte
// Laufzeiten: `onnxruntime-web/webgpu` ruft `webgpuInit` auf, und das gibt es
// **nur** im asyncify-Kleber – der jsep-Kleber kennt bloss `jsepInit`.
//
// Die Folge war nicht etwa ein Fehler, sondern Schweigen: WebGPU liess sich
// nie einrichten, ORT verwarf den Rechenweg mit einer blossen console-Warnung
// und rechnete auf der CPU weiter. Auf jedem Gerät, seit dem ersten Tag.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
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
 * Womit **tatsächlich** gerechnet wurde – und warum, wenn es die CPU wurde.
 *
 * Der Wert hier stand früher fest, sobald `navigator.gpu.requestAdapter()`
 * einen Adapter zurückgab: also bevor eine Sitzung existierte, bevor ein
 * Rechenweg gestartet war. Genau das hat den Fehler oben so lange verdeckt –
 * die Oberfläche meldete „webgpu“, während das Netz auf der CPU kroch, und
 * unterdrückte dabei ausgerechnet den Satz, der gestimmt hätte.
 *
 * Jetzt wird er erst gesetzt, wenn `InferenceSession.create` zurückgekommen
 * ist, und `grund` trägt den Originaltext des Fehlschlags.
 */
let rechenweg: { laufwerk: 'webgpu' | 'wasm'; grund?: string } = { laufwerk: 'wasm' };

export function birefnetRechenweg(): { laufwerk: 'webgpu' | 'wasm'; grund?: string } {
  return rechenweg;
}

/**
 * Ob die Grafikeinheit zur Verfügung steht.
 *
 * Nicht nur `navigator.gpu` abfragen: Den Eintrag gibt es auch auf Geräten,
 * die dann beim ersten Zugriff aussteigen. Erst ein tatsächlich zugeteilter
 * Adapter ist eine Zusage.
 */
async function grafikVorhanden(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

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
      melden?.(1, 'Modell wird vorbereitet …');
      const ort = await import('onnxruntime-web/webgpu');
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      // Mehrere Threads brauchten COOP/COEP – die setzen wir nicht.
      ort.env.wasm.numThreads = 1;
      // **Immer** in den Arbeiter, nicht nur ohne Grafikeinheit. Auch der
      // schnelle Weg hat CPU-Anteile: die 94 MB einlesen, den Graphen
      // optimieren, einzelne Rechenschritte ohne GPU-Kern. Läuft das im
      // Hauptfaden, zeichnet die Oberfläche nicht mehr – und ein Handy, das
      // minutenlang nicht auf Berührung reagiert, sieht abgestürzt aus.
      ort.env.wasm.proxy = true;

      /**
       * Ein Versuch mit **genau einem** Rechenweg.
       *
       * Nicht `['webgpu', 'wasm']`: ORT verwirft einen unbrauchbaren Weg dann
       * still und rechnet auf der CPU weiter. Genau dieses Schweigen hat den
       * Fehler oben verdeckt. Ein Versuch, der scheitern darf, ist ehrlicher
       * als eine Liste, die immer irgendwie gelingt.
       */
      const bauen = async (weg: 'webgpu' | 'wasm', bytes: Uint8Array) =>
        ort.InferenceSession.create(bytes, {
          executionProviders: [weg],
          graphOptimizationLevel: 'all',
        });

      let daten = await modellHolen(melden);
      let created: InferenceSession;

      if (await grafikVorhanden()) {
        try {
          created = await bauen('webgpu', daten);
          rechenweg = { laufwerk: 'webgpu' };
        } catch (fehler) {
          // Mit `proxy` wandert der Puffer beim ersten Versuch in den
          // Arbeiter und ist hier danach leer. Die Bytes müssen also neu
          // geholt werden – aus dem Zwischenspeicher, das kostet nichts.
          daten = await modellHolen();
          created = await bauen('wasm', daten);
          rechenweg = {
            laufwerk: 'wasm',
            grund: fehler instanceof Error ? fehler.message : String(fehler),
          };
        }
      } else {
        created = await bauen('wasm', daten);
        rechenweg = { laufwerk: 'wasm', grund: 'Dieses Gerät bietet kein WebGPU an.' };
      }

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
  melden?.(
    1,
    rechenweg.laufwerk === 'webgpu'
      ? 'Wird freigestellt …'
      : 'Wird freigestellt – ohne Grafikeinheit dauert das mehrere Minuten.',
  );
  const ort = await import('onnxruntime-web/webgpu');

  const eingabe = new ort.Tensor('float32', vorbereiten(image), [1, 3, EINGABE, EINGABE]);
  const ergebnis = await runner.run({ [runner.inputNames[0]]: eingabe });
  const roh = ergebnis[runner.outputNames[0]].data as Float32Array;

  // Das Netz endet auf einer Faltung, nicht auf einer Sigmoid-Schicht: Was
  // herauskommt, sind Logits, keine Wahrscheinlichkeiten. Die Referenz von
  // BiRefNet setzt deshalb `preds.sigmoid()` – ohne das ist der Hintergrund
  // nicht null, sondern ein Mittelwert, und der Sticker behaelt einen
  // grauen Schleier. Genau daran ist der erste Anlauf hier gescheitert
  // (Ecken bei 57…69 statt bei 0).
  //
  // Ein Strecken auf min/max waere hier falsch: Die Sigmoid-Kurve ist
  // geeicht, 0 heisst „gehoert nicht dazu“. Strecken machte aus einem Bild
  // ohne Motiv erst recht eines.
  // Erst die Kurve über die 512×512 Modellwerte, dann daraus abtasten. Vorher
  // lief `Math.exp` je AUSGABEpunkt – bei einer Vorlage von 1024×1024 also
  // eine Million Mal für 262144 verschiedene Werte. Dasselbe Ergebnis,
  // byteweise, nur ohne die vierfache Arbeit.
  const flaeche = EINGABE * EINGABE;
  const tabelle = new Uint8Array(flaeche);
  for (let i = 0; i < flaeche; i += 1) {
    const wert = 1 / (1 + Math.exp(-roh[i]));
    tabelle[i] = Math.max(0, Math.min(255, Math.round(wert * 255)));
  }

  const { width, height } = image;
  // Die Spaltenzuordnung hängt nicht von der Zeile ab – einmal reicht.
  const spalte = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    spalte[x] = Math.min(EINGABE - 1, Math.floor((x * EINGABE) / width));
  }

  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(EINGABE - 1, Math.floor((y * EINGABE) / height));
    const zeile = sy * EINGABE;
    const ziel = y * width;
    for (let x = 0; x < width; x += 1) {
      alpha[ziel + x] = tabelle[zeile + spalte[x]];
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
