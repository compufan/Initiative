/**
 * Die eine Stelle, an der über die Grafikeinheit entschieden wird.
 *
 * # Was hier NICHT mehr passiert, und warum das der Kern ist
 *
 * Hier wurde eine Zeitlang selbst ein `GPUDevice` angefordert und an die
 * Laufzeit weitergereicht. Die Begründung war, `requestDevice()` ohne
 * `requiredLimits` liefere die Mindestwerte der Spezifikation statt dessen,
 * was der Adapter kann. Das beschreibt WebGPU richtig – und traf auf ONNX
 * Runtime trotzdem nie zu:
 *
 *     required_features = GetAvailableRequiredFeatures(adapter);   // :121
 *     required_limits   = GetRequiredLimits(adapter);              // :126
 *     …
 *     required_limits.maxStorageBuffersPerShaderStage
 *         = adapter_limits.maxStorageBuffersPerShaderStage;        // :764
 *
 * ORT fordert die Adaptergrenzen von sich aus an – alle zehn, wo hier fünf
 * standen – und dazu `ShaderF16`, `Subgroups` und `TimestampQuery`, sofern
 * der Adapter sie mitbringt.
 *
 * Das Einschleusen war also nicht bloss überflüssig, es war schädlich. Der
 * ganze Block oben hängt an einer Bedingung:
 *
 *     if (device_ == nullptr) { …Adapter holen, Fähigkeiten und Grenzen
 *                                anfordern, Gerät erzeugen… }        // :60
 *
 * Wer ein Gerät mitbringt, überspringt ihn vollständig. Gefüllt wird das
 * Fähigkeitsverzeichnis danach trotzdem – aus dem mitgebrachten Gerät
 * (:189-193). Und ein Gerät, das ohne `requiredFeatures` angefordert wurde,
 * hat laut Spezifikation „exactly the specified set of features, and no more
 * or less“: keine. Beim ersten Shader kommt dann
 *
 *     Program Transpose requires f16 but the device does not support it.
 *
 * Das Netz trägt fp16-Gewichte. Ohne `shader-f16` läuft kein einziger Shader.
 *
 * Gegenprobe aus der eigenen Geschichte: Der allererste Fehler auf dem Gerät
 * des Anwenders („Max is 10“) kam aus einer Fassung OHNE eingeschleustes
 * Gerät – also von ORTs eigenem, das die Adaptergrenze angefordert hatte. Die
 * 10 war nie ein Mindestwert der Spezifikation (der ist 8), sondern die echte
 * Auskunft dieses Adapters. Es gab nie etwas anzuheben.
 *
 * # Was hier stattdessen passiert
 *
 * Nur noch nachsehen und berichten. Kein Gerät, keine Grenzen, keine Wünsche
 * – die Entscheidung, ob „Hohe Qualität“ angeboten wird, und ein Satz, der
 * sagt warum nicht. Das Gerät besorgt sich die Laufzeit selbst.
 *
 * # Warum „Hohe Qualität“ ohne Grafikeinheit gar nicht erst anfängt
 *
 * Nachgemessen, ONNX Runtime 1.29, ein Faden, Serverprozessor:
 *
 *     u2netp („Niedrige Qualität“, 320, fp32)      1,7 s
 *     BiRefNet-lite („Hohe Qualität“, 512, fp16) 295,1 s
 *
 * Das ist nicht die Grösse des Netzes. Dasselbe Netz in fp32 braucht 4,9 s –
 * Faktor 60. Es ist allein das Format: für halbe Genauigkeit bringt der
 * Prozessorpfad keine Rechenwerke mit und rechnet jede Zahl über eine
 * Ersatzdarstellung. Beim Laden sagt die Laufzeit es selbst, hundertfach:
 *
 *     Could not find a CPU kernel and hence can't constant fold Div node …
 *
 * Ein Prozessorpfad stand hier trotzdem einmal – und hat genau das getan, was
 * der Anwender gemeldet hat: „rechnet immer noch ewig“. Ein Verfahren, das
 * eine Viertelstunde braucht, ist kein langsames Verfahren, sondern eine
 * Falle. „Niedrige Qualität“ rechnet dieselbe Art Aufgabe in Sekunden.
 *
 * (Damit ist auch der Notausgang bekannt, falls ein Gerät kein `shader-f16`
 * hat: die Gewichte fp16 auf der Platte lassen und je einen Cast nach fp32
 * davorsetzen. ORT faltet die beim Laden weg, die Auslieferungsgrösse sinkt
 * sogar leicht. Gemessen, aber noch nicht gebaut – es wird erst gebraucht,
 * wenn sich ein Gerät wirklich so meldet.)
 *
 * # Wer hier hereingehört und wer nicht
 *
 * Nur `onnxruntime-web/webgpu`, heute allein „Hohe Qualität“.
 * `onnxruntime-web/wasm` ist eine eigene, in sich geschlossene Fassung der
 * Laufzeit mit eigener Umgebung und eigenem Arbeiter (nachgeprüft: die beiden
 * Dateien teilen sich keinen einzigen Import). „Niedrige Qualität“ und
 * „Antippen mit Netz“ rechnen dort, mit voller Genauigkeit, immer auf dem
 * Prozessor und immer im Arbeiter. Für die gibt es nichts zu entscheiden.
 */

/**
 * Die Fähigkeit, an der alles hängt.
 *
 * Alle 437 Gewichtstensoren des Netzes liegen in halber Genauigkeit. ORT
 * prüft vor jedem Shader `DeviceHasFeature(ShaderF16)` und bricht sonst ab
 * (shader_helper.cc:401). Es gibt weder einen Schalter noch eine automatische
 * Umwandlung – im ganzen WebGPU-Teil der Laufzeit kommt `ShaderF16` genau
 * zweimal vor: bei der Anforderung und bei dieser Prüfung.
 */
const NOETIGE_FAEHIGKEIT = 'shader-f16';

/**
 * Merkposten für „die Grafikeinheit hat mitten im Rechnen aufgegeben“.
 *
 * Muss den Seitenaufruf überleben, sonst liefe die App beim nächsten Versuch
 * in denselben Abbruch. Aber er darf nicht ewig gelten: Ein Treiber wird
 * erneuert, ein anderes Bild ist kleiner, und ein einziger schlechter Tag
 * soll das Verfahren nicht für immer abschalten. Deshalb mit Datum – und mit
 * `grafikVergessen()` einem Weg zurück, der auch wirklich an einem Knopf
 * hängt. Eine Sperre ohne Ausweg ist keine Vorsicht, sondern ein Defekt.
 */
const AUFGEGEBEN = 'initiative.webgpu.aufgegeben';
const VERGESSEN_NACH = 7 * 24 * 60 * 60 * 1000;

/** Gerade so viel WebGPU, wie hier gebraucht wird – statt einer Abhängigkeit. */
interface GpuAdapter {
  readonly features: { has(name: string): boolean };
}
interface GpuZugang {
  requestAdapter(): Promise<GpuAdapter | null>;
}

export interface Laufzeit {
  /** Ob „Hohe Qualität“ auf diesem Gerät angeboten werden darf. */
  taugt: boolean;
  /**
   * Warum nicht – ein Satz, der dem Anwender gezeigt werden kann und der die
   * gemessenen Zahlen mitbringt. Ohne sie ist aus der Ferne nicht zu klären,
   * woran es auf einem bestimmten Telefon liegt.
   */
  grund?: string;
  /** Ob der Grund eine gemerkte Aufgabe ist – dann lohnt ein neuer Versuch. */
  gemerkt?: boolean;
}

let entschieden: Promise<Laufzeit> | null = null;
let befund: Laufzeit | null = null;

/**
 * Was die Prüfung ergeben hat – ohne zu warten.
 *
 * `null`, solange noch niemand gefragt hat.
 */
export function grafikBefund(): Laufzeit | null {
  return befund;
}

/** Liest den Merkposten, ohne an einem gesperrten Speicher zu zerbrechen. */
function abbruchMerken(): string | null {
  try {
    const roh = globalThis.localStorage?.getItem(AUFGEGEBEN);
    if (!roh) return null;
    const { grund, zeit } = JSON.parse(roh) as { grund: string; zeit: number };
    if (Date.now() - zeit > VERGESSEN_NACH) {
      globalThis.localStorage?.removeItem(AUFGEGEBEN);
      return null;
    }
    return grund;
  } catch {
    return null;
  }
}

/**
 * Hält fest, dass die Grafikeinheit mitten im Rechnen abgebrochen ist.
 *
 * Beim nächsten Anlauf wird dann gar nicht erst angefangen – mit der
 * Begründung von damals, statt mit demselben Abbruch von vorn.
 */
export function grafikAufgeben(grund: string): void {
  try {
    globalThis.localStorage?.setItem(AUFGEGEBEN, JSON.stringify({ grund, zeit: Date.now() }));
  } catch {
    // Privater Modus, gesperrter Speicher: dann eben ohne Gedächtnis.
  }
  entschieden = null;
  befund = null;
}

/** Den Merkposten wegräumen und es noch einmal versuchen lassen. */
export function grafikVergessen(): void {
  try {
    globalThis.localStorage?.removeItem(AUFGEGEBEN);
  } catch {
    // Auch das darf scheitern, ohne dass hier etwas kaputtgeht.
  }
  entschieden = null;
  befund = null;
}

/**
 * Nachsehen, ob „Hohe Qualität“ angeboten werden kann.
 *
 * Fragt den **Adapter**, nicht ein Gerät: Der Adapter sagt, was das Gerät
 * könnte; ein Gerät sagt nur, was beim Anfordern verlangt wurde. Genau diese
 * Verwechslung war der letzte Fehler.
 */
async function geraetPruefen(): Promise<Laufzeit> {
  const alterAbbruch = abbruchMerken();
  if (alterAbbruch) {
    return {
      taugt: false,
      gemerkt: true,
      grund: `Die Grafikeinheit hat hier zuletzt mitten im Rechnen abgebrochen (${alterAbbruch}).`,
    };
  }

  const gpu = (globalThis.navigator as (Navigator & { gpu?: GpuZugang }) | undefined)?.gpu;
  if (!gpu) return { taugt: false, grund: 'Dieser Browser bietet kein WebGPU an.' };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { taugt: false, grund: 'Es war keine Grafikeinheit zu bekommen.' };

    if (!adapter.features.has(NOETIGE_FAEHIGKEIT)) {
      // Ehrlich sein, bevor 78 MB geladen sind. Ohne halbe Genauigkeit auf der
      // Grafikeinheit bricht der erste Shader ab, und ein Ausweichen auf den
      // Prozessor dauert bei diesem Format eine Viertelstunde.
      return {
        taugt: false,
        grund: `Die Grafikeinheit rechnet nicht in halber Genauigkeit (${NOETIGE_FAEHIGKEIT} fehlt).`,
      };
    }

    // Nach den Grenzen wird ausdrücklich NICHT gefragt: ORT fordert sie selbst
    // beim Adapter an, und zwar mehr davon, als hier je standen. Siehe oben.
    return { taugt: true };
  } catch (fehler) {
    return {
      taugt: false,
      grund: fehler instanceof Error ? fehler.message : 'Die Grafikeinheit meldete einen Fehler.',
    };
  }
}

/**
 * Die Entscheidung – beim zweiten Aufruf sofort dieselbe Antwort.
 *
 * Gemerkt wird sie, weil die Oberfläche sie beim Öffnen des Studios braucht
 * und das Verfahren selbst noch einmal beim Rechnen.
 */
export function laufzeitEntscheiden(): Promise<Laufzeit> {
  if (!entschieden) {
    entschieden = geraetPruefen().then((ergebnis) => {
      befund = ergebnis;
      return ergebnis;
    });
  }
  return entschieden;
}

/**
 * Die gemeinsamen Einstellungen setzen. Muss vor der ERSTEN Sitzung laufen.
 *
 * Wirft mit einem Satz, den man zeigen kann, wenn dieses Gerät nicht taugt –
 * nicht als stiller Rückfall auf den Prozessor, siehe die Messung oben.
 */
export async function ortVorbereiten(
  // Alle Felder wahlfrei, weil `ort.env` sie so deklariert. Anders herum
  // liesse sich `ort.env` gar nicht übergeben.
  env: { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } },
  pfade: { wasm: string; mjs: string },
): Promise<void> {
  const laufzeit = await laufzeitEntscheiden();
  if (!laufzeit.taugt) {
    throw new Error(
      `„Hohe Qualität“ braucht eine Grafikeinheit. ${laufzeit.grund ?? ''} ` +
        'Auf dem Prozessor rechnet dieses Netz an einem Bild eine Viertelstunde – ' +
        'nimm „Niedrige Qualität“, das braucht ein paar Sekunden.',
    );
  }
  // Die Laufzeit liegt beim eigenen Server, nicht bei einem fremden CDN.
  env.wasm.wasmPaths = pfade;
  // Mehrere Fäden brauchten die Kopfzeilen COOP/COEP – die setzen wir nicht.
  // Gerechnet wird ohnehin auf der Grafikeinheit.
  env.wasm.numThreads = 1;
  // Vorerst kein Arbeiter. Der Grund dafür (ein eigenes `GPUDevice` lässt sich
  // nicht per `postMessage` hinüberreichen) ist mit dem Einschleusen zwar
  // entfallen, und der Arbeiter wäre besser – er hielte die Oberfläche
  // während des Rechnens am Leben und nähme ihr die 25,7 MB Laufzeit und die
  // 78 MB Modellbytes ab. Aber das ist eine zweite, unabhängige Annahme, und
  // zwei Änderungen auf einmal heissen bei einem Fehlschlag zwei Verdächtige.
  // Erst soll der f16-Fehler nachweislich weg sein.
  env.wasm.proxy = false;
}
