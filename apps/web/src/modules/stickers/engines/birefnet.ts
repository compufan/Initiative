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
import { flaechenMittel, maskeSkalieren } from './prepare.js';

/**
 * Kantenlänge, auf die diese Fassung festgelegt ist.
 *
 * Muss zum Modell in `scripts/prepare-models.mjs` passen – das Netz hat die
 * Grösse fest im Graphen stehen ([1,3,1024,1024]) und lehnt jede andere ab.
 */
const EINGABE = 1024;
const MODEL_URL = '/models/birefnet-lite-1024.onnx';

/** Normalisierung wie bei BiRefNet: erst auf 0…1, dann ImageNet-Werte. */
const MITTEL = [0.485, 0.456, 0.406];
const ABWEICHUNG = [0.229, 0.224, 0.225];

export type Fortschritt = (anteil: number, text: string) => void;

/**
 * Gerade so viel WebGPU, wie hier gebraucht wird.
 *
 * Statt `@webgpu/types` als Abhängigkeit aufzunehmen: Wir benutzen drei
 * Namen, und die vollständigen Typen sind einige tausend Zeilen. Was hier
 * steht, ist absichtlich unvollständig – aber genau das, worauf der Code
 * zugreift, und damit fällt eine falsche Annahme beim Übersetzen auf.
 */
interface GpuGrenzen {
  readonly [name: string]: number | undefined;
}
interface GpuAdapter {
  readonly limits: GpuGrenzen;
  requestDevice(optionen?: { requiredLimits?: Record<string, number> }): Promise<GpuGeraet>;
}
interface GpuGeraet {
  destroy(): void;
}
interface GpuZugang {
  requestAdapter(): Promise<GpuAdapter | null>;
}

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

/**
 * Ob die Grafikeinheit für dieses Netz aufgegeben wurde.
 *
 * Der entscheidende Punkt: Ein WebGPU-Rechenweg kann beim **Erzeugen** der
 * Sitzung tadellos durchlaufen und erst beim **Rechnen** abbrechen – die
 * Shader werden erst dann übersetzt. Auf dem Z Flip 6 sah das so aus:
 *
 *   Too many storage buffers in shader. Current: 11, Max is 10
 *
 * Vorher fing dieser Code nur Fehler beim Erzeugen ab. Die kaputte Sitzung
 * blieb danach liegen und wurde beim nächsten Tippen wiederverwendet – jeder
 * weitere Versuch scheiterte an derselben Stelle, und die App wirkte
 * eingefroren. Jetzt merkt sie sich den Fehlschlag und baut beim nächsten Mal
 * gleich auf der CPU auf.
 */
let nurCpu = false;
let zuletztGescheitert: string | null = null;

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
async function grafikGeraet(): Promise<GpuGeraet | null> {
  const gpu = (navigator as Navigator & { gpu?: GpuZugang }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;

    // # Warum ein eigenes Gerät und nicht das der Laufzeit
    //
    // Auf dem Z Flip 6 (Adreno 750) brach der Lauf ab mit:
    //
    //   Too many storage buffers in shader. Current: 11, Max is 10
    //
    // Die 10 ist keine Eigenschaft der Grafikeinheit, sondern das, womit das
    // Gerät angefordert wurde: `requestDevice()` ohne `requiredLimits` gibt
    // die **Mindestwerte** der Spezifikation, nicht das, was der Adapter
    // kann. Ein einzelner verschmolzener Rechenschritt in BiRefNet braucht
    // elf Puffer – einen mehr.
    //
    // Also fragen wir ausdrücklich nach dem, was der Adapter meldet. Zwei
    // weitere Grenzen kommen mit, weil sie beim nächsten Schritt gerissen
    // würden: ein einzelner Gewichtsblock dieses Netzes ist grösser als die
    // 128 MiB, die die Spezifikation mindestens zusichert.
    const wunsch: Record<string, number> = {};
    for (const name of [
      'maxStorageBuffersPerShaderStage',
      'maxStorageBufferBindingSize',
      'maxBufferSize',
      'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupStorageSize',
    ] as const) {
      const wert = adapter.limits[name];
      if (typeof wert === 'number') wunsch[name] = wert;
    }

    try {
      return await adapter.requestDevice({ requiredLimits: wunsch });
    } catch {
      // Ein Adapter darf ablehnen, was er selbst gemeldet hat. Dann eben mit
      // den Vorgabewerten – vielleicht reicht es für dieses Bild.
      return await adapter.requestDevice();
    }
  } catch {
    return null;
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

      const bauen = async (weg: 'webgpu' | 'wasm', bytes: Uint8Array) =>
        ort.InferenceSession.create(bytes, {
          // Absichtlich EIN Rechenweg je Versuch. Mit ['webgpu','wasm']
          // verwirft ORT einen unbrauchbaren Weg still und rechnet auf der
          // CPU weiter – genau dieses Schweigen hat den jsep-Fehler monatelang
          // verdeckt.
          executionProviders: [weg],
          graphOptimizationLevel: 'all',
        });

      let daten = await modellHolen(melden);
      let created: InferenceSession | null = null;

      const geraet = nurCpu ? null : await grafikGeraet();
      if (geraet) {
        try {
          // Das eigene Gerät kann nur im Hauptfaden übergeben werden – ein
          // GPUDevice lässt sich nicht in einen Arbeiter reichen. Für den
          // schnellen Weg ist das vertretbar: Auf der Grafikeinheit dauert
          // ein Bild Sekunden, nicht Minuten.
          ort.env.wasm.proxy = false;
          (ort.env.webgpu as { device?: unknown }).device = geraet;
          created = await bauen('webgpu', daten);
          rechenweg = { laufwerk: 'webgpu' };
        } catch (fehler) {
          created = null;
          zuletztGescheitert = fehler instanceof Error ? fehler.message : String(fehler);
        }
      }

      if (!created) {
        // Ohne Grafikeinheit rechnet dieses Netz minutenlang. Dann gehört es
        // zwingend in einen Arbeiter, sonst steht die Oberfläche still und
        // sieht abgestürzt aus.
        ort.env.wasm.proxy = true;
        // Mit Proxy wandert der Puffer beim ersten Versuch in den Arbeiter
        // und ist hier danach leer. Die Bytes also neu holen – aus dem
        // Zwischenspeicher, das kostet nichts.
        daten = await modellHolen();
        created = await bauen('wasm', daten);
        rechenweg = {
          laufwerk: 'wasm',
          grund: zuletztGescheitert ?? 'Dieses Gerät bietet kein WebGPU an.',
        };
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
  const ort = await import('onnxruntime-web/webgpu');

  /**
   * Einmal rechnen – und beim Fehlschlag auf der Grafikeinheit **einmal**
   * alles wegwerfen und auf der CPU neu aufbauen.
   *
   * Das ist der Kern: Die Shader eines WebGPU-Rechenwegs werden erst beim
   * ersten Lauf übersetzt. Ein Gerät, dessen Grenzen nicht reichen, meldet
   * sich also nicht beim Erzeugen der Sitzung, sondern hier. Wer nur das
   * Erzeugen absichert, behält eine Sitzung, die bei jedem Tippen erneut an
   * derselben Stelle abbricht.
   */
  const rechnen = async (): Promise<Float32Array> => {
    const runner = await loadSession(melden);
    melden?.(
      1,
      rechenweg.laufwerk === 'webgpu'
        ? 'Wird freigestellt …'
        : 'Wird freigestellt – ohne Grafikeinheit dauert das mehrere Minuten.',
    );
    const eingabe = new ort.Tensor('float32', vorbereiten(image), [1, 3, EINGABE, EINGABE]);
    const ergebnis = await runner.run({ [runner.inputNames[0]]: eingabe });
    return ergebnis[runner.outputNames[0]].data as Float32Array;
  };

  let roh: Float32Array;
  try {
    roh = await rechnen();
  } catch (fehler) {
    if (rechenweg.laufwerk !== 'webgpu' || nurCpu) throw fehler;
    // Die Grafikeinheit hat abgelehnt. Ab jetzt gar nicht mehr fragen – sonst
    // zahlt der Anwender den Fehlversuch bei jedem Bild noch einmal.
    zuletztGescheitert = fehler instanceof Error ? fehler.message : String(fehler);
    nurCpu = true;
    await releaseBirefnet();
    melden?.(0, 'Die Grafikeinheit kam nicht mit – wird auf dem Prozessor gerechnet.');
    roh = await rechnen();
  }

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
  // Erst die Kurve über die Modellwerte, dann daraus abtasten. Vorher lief
  // `Math.exp` je AUSGABEpunkt statt je Modellpunkt – dasselbe Ergebnis, nur
  // ein Vielfaches der Arbeit.
  const flaeche = EINGABE * EINGABE;
  const tabelle = new Float32Array(flaeche);
  for (let i = 0; i < flaeche; i += 1) {
    tabelle[i] = 1 / (1 + Math.exp(-roh[i]));
  }

  // Bilinear statt Blockkopie – warum, steht bei `maskeSkalieren`.
  return maskeSkalieren(tabelle, EINGABE, image.width, image.height);
}

/** Gibt die Modelldaten wieder frei – hier besonders wichtig, es sind 94 MB. */
export async function releaseBirefnet(): Promise<void> {
  await session?.release();
  session = null;
  ladend = null;
}
