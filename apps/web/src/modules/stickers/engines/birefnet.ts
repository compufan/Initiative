/**
 * „Hohe Qualität“ – BiRefNet-lite über ONNX Runtime.
 *
 * Dasselbe Ziel wie „Niedrige Qualität“, nur genauer: BiRefNet trennt Haare,
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
import { grafikAufgeben, ortVorbereiten } from './ort-laufzeit.js';
import { flaechenMittel, maskeSkalieren } from './prepare.js';

/**
 * Kantenlänge, auf die diese Fassung festgelegt ist.
 *
 * Muss zum Modell in `scripts/prepare-models.mjs` passen – das Netz hat die
 * Grösse fest im Graphen stehen ([1,3,512,512]) und lehnt jede andere ab.
 * Nachgeprueft: schon der erste Reshape des Swin-Rumpfes (`/bb/patch_embed/
 * Reshape_1`) traegt die 128 = 512/4 als Konstante, ein blosses Umstellen der
 * Eingangsform scheitert dort sofort.
 */
const EINGABE = 512;
const MODEL_URL = '/models/birefnet-lite-512.onnx';

/** Normalisierung wie bei BiRefNet: erst auf 0…1, dann ImageNet-Werte. */
const MITTEL = [0.485, 0.456, 0.406];
const ABWEICHUNG = [0.229, 0.224, 0.225];

export type Fortschritt = (anteil: number, text: string) => void;

let session: InferenceSession | null = null;
let ladend: Promise<InferenceSession> | null = null;

/**
 * Wie lange der letzte Lauf gedauert hat, in Millisekunden.
 *
 * Steht in der Fehlermeldung, wenn es zu lange war, und beantwortet damit aus
 * der Ferne die einzige Frage, die zählt: Lief es wirklich auf der
 * Grafikeinheit? Vorher gab es dazu nur Vermutungen – der Wert war zwar da,
 * wurde aber nirgends angezeigt.
 */
let letzteDauer = 0;

export function birefnetDauer(): number {
  return letzteDauer;
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
      'Das Modell für „Hohe Qualität“ ist in dieser Fassung der App nicht vorhanden. Nimm solange „Niedrige Qualität“.',
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
      melden?.(0, 'Grafikeinheit wird geprüft …');
      const ort = await import('onnxruntime-web/webgpu');
      // Wirft mit einem zeigbaren Satz, wenn dieses Gerät nicht taugt. Ein
      // stiller Rückfall auf den Prozessor stand hier vorher und war der
      // Grund, dass „Hohe Qualität“ scheinbar „ewig rechnete“: Das Netz hat
      // Gewichte in halber Genauigkeit, und dafür bringt der Prozessorpfad
      // keine Rechenwerke mit – nachgemessen 295 s für ein Bild, auf einem
      // Serverprozessor. Siehe ort-laufzeit.ts.
      await ortVorbereiten(ort.env, { wasm: ortWasmUrl, mjs: ortMjsUrl });

      const daten = await modellHolen(melden);

      /*
       * Absichtlich EIN Rechenweg, und absichtlich OHNE eigenes Gerät.
       *
       * Mit ['webgpu','wasm'] verwirft ORT einen unbrauchbaren Weg still und
       * rechnet auf dem Prozessor weiter – genau dieses Schweigen hat den
       * jsep-Fehler monatelang verdeckt.
       *
       * Hier stand eine Zeitlang `{ name: 'webgpu', device: geraet }` mit
       * einem selbst angeforderten Gerät, um die Puffergrenze anzuheben. Das
       * war gleich doppelt falsch.
       *
       * Es war schädlich: Ein eingeschleustes Gerät lässt ORT den ganzen
       * Block überspringen, der Fähigkeiten und Grenzen anfordert
       * (webgpu_context.cc:60, `if (device_ == nullptr)`). Das Feature-
       * Verzeichnis wird danach trotzdem gefüllt – aus dem eingeschleusten
       * Gerät (:189-193). Und ein Gerät, das ohne `requiredFeatures`
       * angefordert wurde, hat laut Spezifikation „exactly the specified set
       * of features, and no more or less“, also keine. Ergebnis:
       *
       *     Program Transpose requires f16 but the device does not support it.
       *
       * Es war zugleich überflüssig: ORT fordert von sich aus die
       * Adapter-Grenzen an, `maxStorageBuffersPerShaderStage` ausdrücklich
       * eingeschlossen (:764) – und dazu ShaderF16, Subgroups und
       * TimestampQuery, sofern der Adapter sie hat (:742). Meine Liste von
       * fünf Grenzen war eine echte Teilmenge der zehn, die ORT ohnehin holt.
       *
       * Also: nichts einschleusen. Die Laufzeit macht es richtig.
       */
      const created = await ort.InferenceSession.create(daten, {
        executionProviders: ['webgpu'],
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
  const ort = await import('onnxruntime-web/webgpu');
  const runner = await loadSession(melden);
  melden?.(1, 'Wird freigestellt …');

  const eingabe = new ort.Tensor('float32', vorbereiten(image), [1, 3, EINGABE, EINGABE]);

  /*
   * Ein Fehlschlag hier ist endgültig, und das ist Absicht.
   *
   * Die Shader eines WebGPU-Rechenwegs werden erst beim ersten Lauf
   * übersetzt: Ein Gerät, dessen Grenzen nicht reichen, meldet sich nicht
   * beim Erzeugen der Sitzung, sondern genau hier. Ausweichen liesse sich nur
   * auf den Prozessor – und der braucht für dieses Netz eine Viertelstunde je
   * Bild. Also wird der Abbruch gemerkt (beim nächsten Mal fängt es gar nicht
   * erst an) und ehrlich gesagt, was stattdessen hilft.
   */
  const begonnen = Date.now();
  let roh: Float32Array;
  try {
    const ergebnis = await runner.run({ [runner.inputNames[0]]: eingabe });
    roh = ergebnis[runner.outputNames[0]].data as Float32Array;
  } catch (fehler) {
    const text = fehler instanceof Error ? fehler.message : String(fehler);
    grafikAufgeben(text);
    await releaseBirefnet();
    throw new Error(
      `Die Grafikeinheit hat mitten im Rechnen abgebrochen (${text}). ` +
        'Nimm „Niedrige Qualität“ – das rechnet auf jedem Gerät in Sekunden.',
    );
  }
  letzteDauer = Date.now() - begonnen;

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
