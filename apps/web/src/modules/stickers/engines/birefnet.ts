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
import { grafikAufgeben, ortVorbereiten } from './ort-laufzeit.js';
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
      // Die Entscheidung fällt einmal je Seitenaufruf, bevor die Laufzeit
      // hochfährt – danach darf `proxy` nicht mehr angefasst werden, sonst
      // sucht die Laufzeit einen Arbeiter, den es nie gegeben hat.
      const laufzeit = await ortVorbereiten(ort.env, { wasm: ortWasmUrl, mjs: ortMjsUrl });

      const daten = await modellHolen(melden);

      // Absichtlich EIN Rechenweg. Mit ['webgpu','wasm'] verwirft ORT einen
      // unbrauchbaren Weg still und rechnet auf der CPU weiter – genau dieses
      // Schweigen hat den jsep-Fehler monatelang verdeckt.
      //
      // Das eigene Gerät gehört **hierher**, in die Angaben zur Sitzung, und
      // nicht nach `env.webgpu.device`. Dieses Feld sieht aus wie ein
      // Stellrad, ist aber eine Anzeige: Die Laufzeit schreibt dort beim
      // Hochfahren das Gerät hinein, das sie sich selbst besorgt hat.
      //
      //     if (ep === 'webgpu') laufzeit.webgpuInit((g) => { env.webgpu.device = g; });
      //                                                      ^ Zuweisung, nicht Abfrage
      //
      // Nur der Weg über die Sitzung landet bei `webgpuRegisterDevice`, und
      // nur dort zählt er. Wer stattdessen `env` beschreibt, bekommt keinen
      // Fehler – sondern schweigend wieder die Mindestgrenzen und damit den
      // Abbruch „Too many storage buffers in shader. Current: 11, Max is 10“.
      const weg = laufzeit.geraet
        ? ({ name: 'webgpu', device: laufzeit.geraet } as const)
        : ('wasm' as const);

      const created = await ort.InferenceSession.create(daten, {
        executionProviders: [weg],
        graphOptimizationLevel: 'all',
      });
      rechenweg = laufzeit.geraet
        ? { laufwerk: 'webgpu' }
        : { laufwerk: 'wasm', grund: laufzeit.grund };

      session = created;
      return created;
    })().catch((error: unknown) => {
      ladend = null;
      throw error;
    });
  }
  return ladend;
}

/** Bringt das Bild auf 1024×1024 und in die Form, die das Modell erwartet. */
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

  // Bricht die Grafikeinheit hier ab, lässt sich nicht mehr auf die CPU
  // ausweichen: Der Arbeiter müsste dafür eingeschaltet werden, und das geht
  // nach dem Hochfahren der Laufzeit nicht mehr (siehe ort-laufzeit.ts).
  // Deshalb wird vorher geprüft, ob die Grenzen reichen – und wenn es trotzdem
  // schiefgeht, ist eine ehrliche Meldung besser als ein zweiter Fehlversuch.
  let roh: Float32Array;
  try {
    roh = await rechnen();
  } catch (fehler) {
    if (rechenweg.laufwerk === 'webgpu') {
      // Den Abbruch über das Neuladen hinweg merken. Sonst nähme die App beim
      // nächsten Start wieder die Grafikeinheit, liefe in denselben Fehler –
      // und der Satz unten wäre eine Lüge.
      grafikAufgeben(fehler instanceof Error ? fehler.message : String(fehler));
      await releaseBirefnet();
      throw new Error(
        'Die Grafikeinheit hat mitten im Rechnen abgebrochen. Lade die App neu – dann wird auf dem Prozessor gerechnet. Schneller geht es mit „Beliebiges Objekt“.',
      );
    }
    throw fehler;
  }

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
