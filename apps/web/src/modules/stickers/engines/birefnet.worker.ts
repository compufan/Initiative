/// <reference lib="webworker" />
/**
 * „Hohe Qualität" – im eigenen Arbeiter.
 *
 * # Warum ein eigener und nicht der eingebaute
 *
 * ONNX Runtime bringt einen mit: `env.wasm.proxy = true`. Für WebGPU ist er
 * unbrauchbar, und die Dokumentation sagt es wörtlich: „The proxy worker
 * cannot work with WebGPU EP. This is because a GPU buffer is not
 * transferable."
 *
 * Entscheidend ist aber, WIE er scheitert. Im Quelltext nachgelesen: `init-ep`
 * wird im Arbeiter behandelt und prüft nur `navigator.gpu` – das gibt es dort.
 * Sitzung und Lauf gehen also durch. Verboten sind ausschliesslich GPU-ORTE
 * der Tensoren. Der Umbau schlüge deshalb nicht hart fehl, sondern liefe
 * still in einer nicht unterstützten Fassung weiter – genau die Bauart
 * Fehler, die diese Datei schon mehrfach zerlegt hat (der stille fp16-
 * Rückfall, der stille jsep-Rückfall).
 *
 * Ein EIGENER Arbeiter hat das Problem nicht: Er ist einfach ein zweiter
 * Faden, in dem die Laufzeit ganz normal läuft. ORT prüft dort `navigator.gpu`
 * (im Arbeiter vorhanden), und `proxy-wrapper` hält sich mit
 * `typeof document !== 'undefined'` zurück, macht also keinen zweiten auf.
 *
 * # Was der Umbau bringt
 *
 * Nicht in erster Linie den Lauf selbst: Bei WebGPU wartet `run()` grössten-
 * teils auf die Grafikeinheit, und dabei ist der Hauptfaden ohnehin frei.
 * Es geht um das, was davor liegt und wirklich blockiert:
 *
 * - **94 MB Modell einlesen und den Graphen aufbauen.** Das ist synchrone
 *   Arbeit am Stück – protobuf zerlegen, Optimierungen anwenden.
 * - **Die Shader übersetzen**, beim ersten Lauf.
 * - **Der Speicher.** 94 MB Modellbytes und rund 26 MB Laufzeit liegen
 *   danach nicht mehr im Faden der Oberfläche. Auf einem iPhone ist das kein
 *   Luxus: iOS beendet Seiten, die zu viel halten, kommentarlos.
 *
 * # Was hier NICHT passiert
 *
 * Die Entscheidung, ob dieses Gerät taugt, und der Merkposten für „hat
 * aufgegeben" bleiben im Hauptfaden. Beides hängt an `localStorage`, und das
 * gibt es in einem Arbeiter nicht. Der Arbeiter rechnet; er entscheidet
 * nichts.
 */

import type { InferenceSession } from 'onnxruntime-web';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

/** Kantenlänge, auf die das Modell festgelegt ist. Siehe `birefnet.ts`. */
const EINGABE = 512;
const MODELL_URL = '/models/birefnet-lite-512.onnx';

/** Was der Hauptfaden schickt. */
export type AnArbeiter = { art: 'rechne'; tensor: Float32Array } | { art: 'freigeben' };

/** Was zurückkommt. */
export type VomArbeiter =
  | { art: 'fortschritt'; anteil: number; text: string }
  | { art: 'fertig'; roh: Float32Array; ladeMs: number; laufMs: number }
  | { art: 'fehler'; text: string; laufMs: number; imLauf: boolean }
  | { art: 'frei' };

let session: InferenceSession | null = null;
let ladend: Promise<InferenceSession> | null = null;
/** Wie lange das Laden gedauert hat – nur beim ersten Mal ungleich null. */
let letzteLadeMs = 0;

const melde = (nachricht: VomArbeiter, uebergeben: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(nachricht, uebergeben);
};

/**
 * Holt die Modelldatei und meldet dabei, wie weit sie ist.
 *
 * Ein Fortschritt ist bei 94 MB kein Schmuck: Ohne ihn steht der Anwender
 * eine Minute vor einem Knopf, der nichts tut, und drückt ihn noch einmal.
 */
async function modellHolen(): Promise<Uint8Array> {
  const antwort = await fetch(MODELL_URL);
  if (antwort.status === 404) {
    throw new Error(
      'Das Modell für „Hohe Qualität" ist in dieser Fassung der App nicht vorhanden. Nimm solange „Niedrige Qualität".',
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
    melde({
      art: 'fortschritt',
      anteil: gesamt > 0 ? gelesen / gesamt : 0,
      text: `Modell wird geladen … ${(gelesen / 1024 / 1024).toFixed(0)} MB`,
    });
  }

  const daten = new Uint8Array(gelesen);
  let versatz = 0;
  for (const stueck of stuecke) {
    daten.set(stueck, versatz);
    versatz += stueck.length;
  }
  return daten;
}

async function sitzung(): Promise<InferenceSession> {
  if (session) return session;
  if (!ladend) {
    ladend = (async () => {
      const begonnen = Date.now();
      const ort = await import('onnxruntime-web/webgpu');
      // Die Laufzeit liegt beim eigenen Server, nicht bei einem fremden CDN.
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      // Mehrere Fäden brauchten COOP/COEP – die setzen wir nicht, und
      // gerechnet wird ohnehin auf der Grafikeinheit.
      ort.env.wasm.numThreads = 1;
      /*
       * Und hier ausdrücklich KEIN Proxy.
       *
       * Wir sind bereits ein Arbeiter. `proxy = true` liesse ORT einen
       * zweiten aufmachen – und genau der ist der, der mit WebGPU still
       * falsch rechnet. `proxy-wrapper` hielte sich hier zwar von selbst
       * zurück (es prüft `typeof document !== 'undefined'`), aber sich auf
       * das Schweigen einer fremden Prüfung zu verlassen wäre dieselbe Art
       * Annahme, die diese Datei schon zweimal gekostet hat.
       */
      ort.env.wasm.proxy = false;

      const daten = await modellHolen();
      melde({ art: 'fortschritt', anteil: 1, text: 'Modell wird eingerichtet …' });

      // Absichtlich EIN Rechenweg. Mit ['webgpu','wasm'] verwirft ORT einen
      // unbrauchbaren Weg still und rechnet auf dem Prozessor weiter – das
      // dauert bei diesem Netz eine Viertelstunde je Bild.
      const erzeugt = await ort.InferenceSession.create(daten, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      session = erzeugt;
      letzteLadeMs = Date.now() - begonnen;
      return erzeugt;
    })().catch((fehler: unknown) => {
      ladend = null;
      throw fehler;
    });
  }
  return ladend;
}

self.onmessage = async (ereignis: MessageEvent<AnArbeiter>) => {
  const nachricht = ereignis.data;

  if (nachricht.art === 'freigeben') {
    await session?.release();
    session = null;
    ladend = null;
    melde({ art: 'frei' });
    return;
  }

  let laufBegonnen = 0;
  let imLauf = false;
  try {
    const ort = await import('onnxruntime-web/webgpu');
    const runner = await sitzung();
    melde({ art: 'fortschritt', anteil: 1, text: 'Wird freigestellt …' });

    const eingabe = new ort.Tensor('float32', nachricht.tensor, [1, 3, EINGABE, EINGABE]);
    laufBegonnen = Date.now();
    imLauf = true;
    const ergebnis = await runner.run({ [runner.inputNames[0]]: eingabe });
    const roh = ergebnis[runner.outputNames[0]].data as Float32Array;
    imLauf = false;

    /*
     * Kopieren, bevor übergeben wird.
     *
     * Der Puffer aus dem Ergebnis gehört der Laufzeit; ihn zu übergeben
     * würde ihn ihr unter den Händen wegnehmen. Eine Million Fliesskommazahlen
     * sind vier Megabyte – das ist die Kopie wert, gegenüber einem Puffer,
     * den ORT beim nächsten Lauf angetrennt vorfindet.
     */
    const kopie = new Float32Array(roh);
    melde({ art: 'fertig', roh: kopie, ladeMs: letzteLadeMs, laufMs: Date.now() - laufBegonnen }, [
      kopie.buffer,
    ]);
    // Nur beim ersten Lauf ist die Ladezeit interessant.
    letzteLadeMs = 0;
  } catch (fehler) {
    melde({
      art: 'fehler',
      text: fehler instanceof Error ? fehler.message : String(fehler),
      laufMs: laufBegonnen ? Date.now() - laufBegonnen : 0,
      imLauf,
    });
  }
};
