/**
 * Die eine Stelle, an der über die ONNX-Laufzeit entschieden wird.
 *
 * # Warum das zentral gehören muss
 *
 * `ort.env.wasm.proxy` sagt, ob gerechnet wird, wo die Oberfläche lebt, oder
 * in einem Arbeiter daneben. Der Haken steht im Quelltext der Laufzeit
 * (`dist/ort.webgpu.bundle.min.mjs`, hier lesbar geschrieben):
 *
 *     istArbeiter = () => !!env.wasm.proxy && typeof document !== "undefined";
 *
 *     arbeiterPruefen = () => {
 *       if (startet || !gestartet || abgebrochen || !arbeiter)
 *         throw new Error("worker not ready");
 *     };
 *
 *     laufzeitStarten = async () => {
 *       if (gestartet) return;
 *       …
 *       if (istArbeiter()) { …hier und NUR hier entsteht der Arbeiter… }
 *       …sonst im eigenen Faden…
 *     };
 *
 * `istArbeiter()` liest die Einstellung bei **jedem Aufruf** neu – der
 * Arbeiter entsteht aber nur **einmal**, beim Hochfahren. Wer sie nachträglich
 * auf `true` dreht, schickt die Laufzeit damit zu einem Arbeiter, den es nie
 * gegeben hat: `no available backend found. ERR: [wasm] Error: worker not
 * ready`.
 *
 * Genau das passierte, als „Hohe Qualität“ erst die Grafikeinheit ohne
 * Arbeiter versuchte und danach für den Rückfall auf den Prozessor den
 * Arbeiter einschalten wollte.
 *
 * Also: Die Entscheidung fällt **einmal je Seitenaufruf**, bevor die erste
 * Sitzung entsteht, und wird danach nicht mehr angefasst.
 *
 * # Die Zwickmühle, die dahintersteckt
 *
 * Zwei Wünsche, die sich ausschliessen:
 *
 * - Ein **eigenes GPU-Gerät** – nötig, um die Puffergrenze anzuheben, an der
 *   BiRefNet sonst abbricht – lässt sich nicht in einen Arbeiter reichen. Ein
 *   `GPUDevice` ist nicht kopierbar, und die Laufzeit schickt beim Hochfahren
 *   ihre ganze Umgebung per `postMessage` hinüber. Also braucht der schnelle
 *   Weg `proxy = false`.
 * - Ein **Lauf auf dem Prozessor** dauert bei diesem Netz Minuten. Im
 *   Hauptfaden hiesse das eine App, die minutenlang auf keine Berührung
 *   reagiert. Also braucht der langsame Weg `proxy = true`.
 *
 * Aufgelöst wird das, indem **vorher** geprüft wird, ob die Grafikeinheit
 * taugt – bevor die Laufzeit überhaupt hochfährt. Danach steht die
 * Entscheidung fest.
 *
 * # Wer hier hereingehört und wer nicht
 *
 * Nur die Verfahren aus dem Paket `onnxruntime-web/webgpu` – heute allein
 * „Hohe Qualität“. `onnxruntime-web/wasm` ist eine **eigene**, in sich
 * geschlossene Fassung der Laufzeit mit eigener Umgebung und eigenem
 * Arbeiter (nachgeprüft: die beiden Dateien teilen sich keinen einzigen
 * Import, und `webgpuInit` kommt nur in der einen vor). „Beliebiges Objekt“
 * und „Antippen (genau)“ rechnen dort, immer auf dem Prozessor, immer im
 * Arbeiter – für die gibt es nichts zu entscheiden, und sie dürfen hier
 * gerade **nicht** durch: ein `proxy = false` würde sie in den Hauptfaden
 * holen und die Oberfläche einfrieren.
 */

/**
 * Wieviele Speicherpuffer ein Shader von BiRefNet braucht.
 *
 * Elf sind es tatsächlich; die zwölf sind ein Puffer für den nächsten
 * verschmolzenen Rechenschritt, den eine neue Fassung der Laufzeit bauen mag.
 */
const NOETIGE_PUFFER = 12;

/**
 * Merkposten für „die Grafikeinheit hat mitten im Rechnen aufgegeben“.
 *
 * Das muss den Seitenaufruf überleben: Nach einem solchen Abbruch lässt sich
 * der Arbeiter nicht mehr nachträglich einschalten, die App muss also neu
 * geladen werden. Ohne Merkposten liefe sie danach in denselben Abbruch, und
 * der Satz „lade neu, dann rechnet der Prozessor“ wäre eine Lüge.
 */
const AUFGEGEBEN = 'initiative.webgpu.aufgegeben';

/** Gerade so viel WebGPU, wie hier gebraucht wird – statt einer Abhängigkeit. */
interface GpuAdapter {
  readonly limits: { readonly [name: string]: number | undefined };
  requestDevice(optionen?: { requiredLimits?: Record<string, number> }): Promise<unknown>;
}
interface GpuZugang {
  requestAdapter(): Promise<GpuAdapter | null>;
}

export interface Laufzeit {
  /**
   * Das eigene Gerät, falls die Grafikeinheit taugt – sonst `null`.
   *
   * Wird als `executionProviders: [{ name: 'webgpu', device }]` übergeben,
   * **nicht** über `env.webgpu.device`: dieses Feld ist eine Ausgabe, die
   * Laufzeit überschreibt es beim Hochfahren mit dem Gerät, das sie sich
   * selbst besorgt hat. Wer dort hineinschreibt, bekommt keinen Fehler,
   * sondern schweigend wieder die Mindestgrenzen der Spezifikation.
   */
  geraet: unknown | null;
  /** Warum es der Prozessor wurde – für eine ehrliche Meldung. */
  grund?: string;
}

let entschieden: Promise<Laufzeit> | null = null;

/** Liest den Merkposten, ohne an einem gesperrten Speicher zu zerbrechen. */
function hatAufgegeben(): string | null {
  try {
    return globalThis.localStorage?.getItem(AUFGEGEBEN) ?? null;
  } catch {
    return null;
  }
}

/**
 * Hält fest, dass die Grafikeinheit mitten im Rechnen abgebrochen ist.
 *
 * Nach dem nächsten Laden der Seite wird dann von vornherein der Prozessor
 * genommen – mit Arbeiter, also ohne die Oberfläche stillzulegen.
 */
export function grafikAufgeben(grund: string): void {
  try {
    globalThis.localStorage?.setItem(AUFGEGEBEN, grund);
  } catch {
    // Privater Modus, gesperrter Speicher: dann eben ohne Gedächtnis.
  }
}

/**
 * Ob die Grafikeinheit für die schweren Netze taugt – **vor** dem Hochfahren
 * der Laufzeit geprüft.
 *
 * Die Puffergrenze ist der Punkt, an dem es auf einem Snapdragon 8 Gen 3
 * scheiterte:
 *
 *     Too many storage buffers in shader. Current: 11, Max is 10
 *
 * Die 10 ist keine Eigenschaft der Grafikeinheit, sondern das, womit das Gerät
 * angefordert wurde: `requestDevice()` ohne `requiredLimits` liefert die
 * **Mindestwerte** der Spezifikation. Hier wird deshalb ausdrücklich nach dem
 * gefragt, was der Adapter meldet – und geprüft, ob es reicht, statt es zu
 * hoffen.
 */
async function geraetPruefen(): Promise<Laufzeit> {
  const alterAbbruch = hatAufgegeben();
  if (alterAbbruch) {
    return {
      geraet: null,
      grund: `Die Grafikeinheit hat hier schon einmal abgebrochen (${alterAbbruch}).`,
    };
  }

  const gpu = (globalThis.navigator as (Navigator & { gpu?: GpuZugang }) | undefined)?.gpu;
  if (!gpu) return { geraet: null, grund: 'Dieses Gerät bietet kein WebGPU an.' };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { geraet: null, grund: 'Es war keine Grafikeinheit zu bekommen.' };

    const kann = adapter.limits.maxStorageBuffersPerShaderStage ?? 0;
    if (kann < NOETIGE_PUFFER) {
      // Lieber jetzt ehrlich sein als mitten im Rechnen abbrechen: Reicht die
      // Grenze nicht, wird der Shader beim ersten Lauf verworfen – und dann
      // liesse sich der Arbeiter nicht mehr nachträglich einschalten.
      return {
        geraet: null,
        grund: `Die Grafikeinheit erlaubt nur ${kann} Speicherpuffer je Shader, gebraucht werden ${NOETIGE_PUFFER}.`,
      };
    }

    // Die Grenzen, die als nächste reissen würden. Ein einzelner Gewichtsblock
    // dieses Netzes ist grösser als die 128 MiB, die die Spezifikation
    // mindestens zusichert.
    const wunsch: Record<string, number> = {};
    for (const name of [
      'maxStorageBuffersPerShaderStage',
      'maxStorageBufferBindingSize',
      'maxBufferSize',
      'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupStorageSize',
    ]) {
      const wert = adapter.limits[name];
      if (typeof wert === 'number') wunsch[name] = wert;
    }

    try {
      return { geraet: await adapter.requestDevice({ requiredLimits: wunsch }) };
    } catch {
      // Ein Adapter darf ablehnen, was er selbst gemeldet hat. Dann ist die
      // Grenze nicht zu heben – und ohne gehobene Grenze bricht der Lauf ab.
      // Also gar nicht erst anfangen.
      return {
        geraet: null,
        grund: 'Die Grafikeinheit gab ihre eigenen Grenzen nicht frei.',
      };
    }
  } catch (fehler) {
    return {
      geraet: null,
      grund: fehler instanceof Error ? fehler.message : 'Die Grafikeinheit meldete einen Fehler.',
    };
  }
}

/**
 * Die Entscheidung – beim zweiten Aufruf sofort dieselbe Antwort.
 *
 * Nur einmal geprüft, weil `requestDevice` beim zweiten Mal ein zweites Gerät
 * liefern würde und weil die Entscheidung ohnehin nicht mehr umkehrbar ist.
 */
export function laufzeitEntscheiden(): Promise<Laufzeit> {
  if (!entschieden) entschieden = geraetPruefen();
  return entschieden;
}

/**
 * Die gemeinsamen Einstellungen setzen. Muss vor der ERSTEN Sitzung laufen –
 * danach ist `proxy` unveränderlich, siehe oben.
 */
export async function ortVorbereiten(
  // Alle Felder wahlfrei, weil `ort.env` sie so deklariert. Anders herum
  // liesse sich `ort.env` gar nicht übergeben.
  env: { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } },
  pfade: { wasm: string; mjs: string },
): Promise<Laufzeit> {
  const laufzeit = await laufzeitEntscheiden();
  // Die Laufzeit liegt beim eigenen Server, nicht bei einem fremden CDN.
  env.wasm.wasmPaths = pfade;
  // Mehrere Fäden brauchten die Kopfzeilen COOP/COEP – die setzen wir nicht,
  // sie würden eingebettete Inhalte lahmlegen. Also einer.
  env.wasm.numThreads = 1;
  // Ohne Grafikeinheit rechnet das grosse Netz minutenlang; das gehört in den
  // Arbeiter. Mit Grafikeinheit geht es nicht in den Arbeiter, weil das eigene
  // GPU-Gerät sich nicht dorthin reichen lässt – dafür dauert es Sekunden.
  env.wasm.proxy = laufzeit.geraet === null;
  return laufzeit;
}
