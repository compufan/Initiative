/**
 * Die eine Stelle, an der über die Grafikeinheit entschieden wird.
 *
 * # Warum „Hohe Qualität“ ohne Grafikeinheit gar nicht erst anfängt
 *
 * Nicht aus Bequemlichkeit, sondern weil es nachgemessen ist. Beide Modelle
 * einmal auf einem **Serverprozessor**, ein Faden, ONNX Runtime 1.29:
 *
 *     u2netp („Beliebiges Objekt“, 320, fp32)      1,7 s
 *     BiRefNet-lite („Hohe Qualität“, 512, fp16) 290,4 s
 *
 * 170-mal langsamer. Das ist nicht die Grösse des Netzes – so viel mehr
 * rechnet BiRefNet nicht. Es ist das Format. Beim Laden sagt die Laufzeit es
 * selbst, hundertfach:
 *
 *     Could not find a CPU kernel and hence can't constant fold Div node …
 *
 * Die Gewichte sind halbe Genauigkeit (437 von 437 Tensoren), und dafür
 * bringt der Prozessorpfad schlicht keine Rechenwerke mit. Jede Rechnung
 * geht den Umweg über eine Ersatzdarstellung. Auf der Grafikeinheit ist
 * halbe Genauigkeit dagegen der Normalfall und kostet nichts extra.
 *
 * Ein Ausweg wäre die Fassung mit voller Genauigkeit – die gibt es, aber sie
 * wiegt rund 220 MB statt 78. Etwas Kleineres bietet die Quelle nicht an
 * (nachgesehen: `onnx/model.onnx` und `onnx/model_fp16.onnx`, sonst nichts).
 * Auf ein Telefon lädt man das nicht.
 *
 * Also: Mit Grafikeinheit Sekunden, ohne sie gar nicht. Ein Prozessorpfad
 * stand hier vorher trotzdem – und hat genau das getan, was der Anwender
 * gemeldet hat: „rechnet immer noch ewig“. Ein Verfahren, das eine
 * Viertelstunde braucht, ist kein langsames Verfahren, sondern eine Falle.
 * „Beliebiges Objekt“ rechnet dieselbe Art Aufgabe in Sekunden.
 *
 * # Warum die Entscheidung hierher gehört und nur einmal fällt
 *
 * `ort.env.wasm.proxy` sagt, ob gerechnet wird, wo die Oberfläche lebt, oder
 * in einem Arbeiter daneben. Der Haken steht im Quelltext der Laufzeit:
 *
 *     istArbeiter = () => !!env.wasm.proxy && typeof document !== "undefined";
 *     laufzeitStarten = async () => {
 *       if (gestartet) return;
 *       if (istArbeiter()) { …hier und NUR hier entsteht der Arbeiter… }
 *     };
 *
 * Gelesen wird bei jedem Aufruf, erzeugt nur einmal. Wer die Einstellung
 * nachträglich umlegt, schickt die Laufzeit zu einem Arbeiter, den es nie
 * gegeben hat: `worker not ready`. Seit es keinen Prozessorpfad mehr gibt,
 * gibt es auch nichts mehr umzulegen – die Zwickmühle ist damit weg, nicht
 * bloss umschifft.
 *
 * # Wer hier hereingehört und wer nicht
 *
 * Nur `onnxruntime-web/webgpu`, heute allein „Hohe Qualität“.
 * `onnxruntime-web/wasm` ist eine eigene, in sich geschlossene Fassung der
 * Laufzeit mit eigener Umgebung und eigenem Arbeiter (nachgeprüft: die
 * beiden Dateien teilen sich keinen einzigen Import). „Beliebiges Objekt“
 * und „Antippen (genau)“ rechnen dort, mit vollen Genauigkeiten, immer auf
 * dem Prozessor und immer im Arbeiter. Für die gibt es nichts zu
 * entscheiden.
 */

/**
 * Wieviele Speicherpuffer ein Shader von BiRefNet braucht.
 *
 * Elf. Nicht geschätzt – die Laufzeit hat es auf dem Gerät des Anwenders
 * selbst gesagt:
 *
 *     Too many storage buffers in shader. Current: 11, Max is 10
 *
 * Hier stand vorübergehend eine 12, „als Puffer“. Das war ein Fehler: Ein
 * erfundener Aufschlag weist Geräte ab, auf denen es liefe. Es steht die
 * gemessene Zahl da, sonst nichts.
 */
const NOETIGE_PUFFER = 11;

/**
 * Merkposten für „die Grafikeinheit hat mitten im Rechnen aufgegeben“.
 *
 * Muss den Seitenaufruf überleben, sonst liefe die App beim nächsten Versuch
 * in denselben Abbruch. Aber er darf nicht ewig gelten: Ein Treiber wird
 * erneuert, ein anderes Bild ist kleiner, und ein einziger schlechter Tag
 * soll das Verfahren nicht für immer abschalten. Deshalb mit Datum, und
 * `vergessen()` räumt ihn auf Wunsch sofort weg.
 */
const AUFGEGEBEN = 'initiative.webgpu.aufgegeben';
const VERGESSEN_NACH = 7 * 24 * 60 * 60 * 1000;

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
   * Das eigene Gerät, oder `null`, wenn dieses Telefon nicht taugt.
   *
   * Wird als `executionProviders: [{ name: 'webgpu', device }]` übergeben,
   * **nicht** über `env.webgpu.device`: Dieses Feld ist eine Ausgabe. Die
   * Laufzeit schreibt dort beim Hochfahren das Gerät hinein, das sie sich
   * selbst besorgt hat – mit den Mindestgrenzen der Spezifikation. Wer
   * hineinschreibt, bekommt keinen Fehler, sondern schweigend die alten
   * Grenzen zurück.
   */
  geraet: unknown | null;
  /**
   * Warum nicht – ein Satz, der dem Anwender gezeigt werden kann und der die
   * gemessenen Zahlen mitbringt. Ohne sie ist aus der Ferne nicht zu klären,
   * woran es auf einem bestimmten Telefon liegt.
   */
  grund?: string;
}

let entschieden: Promise<Laufzeit> | null = null;
let befund: Laufzeit | null = null;

/**
 * Was die Prüfung ergeben hat – ohne zu warten.
 *
 * `null`, solange noch niemand gefragt hat. Damit lässt sich die Oberfläche
 * einrichten, ohne auf die Grafikeinheit zu warten.
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

/** Die Grenzen, die dieses Netz reisst, wenn man sie nicht anhebt. */
const GRENZEN = [
  'maxStorageBuffersPerShaderStage',
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupStorageSize',
];

/**
 * Ob die Grafikeinheit taugt – **vor** dem Hochfahren der Laufzeit geprüft.
 *
 * Die Puffergrenze ist der Punkt, an dem es auf dem Gerät des Anwenders
 * scheiterte. Die dort gemeldete 10 ist keine Eigenschaft der Grafikeinheit,
 * sondern das, womit das Gerät angefordert wurde: `requestDevice()` ohne
 * `requiredLimits` liefert die **Mindestwerte** der Spezifikation. Hier wird
 * deshalb ausdrücklich nach dem gefragt, was der Adapter meldet.
 */
async function geraetPruefen(): Promise<Laufzeit> {
  const alterAbbruch = abbruchMerken();
  if (alterAbbruch) {
    return {
      geraet: null,
      grund: `Die Grafikeinheit hat hier zuletzt mitten im Rechnen abgebrochen (${alterAbbruch}).`,
    };
  }

  const gpu = (globalThis.navigator as (Navigator & { gpu?: GpuZugang }) | undefined)?.gpu;
  if (!gpu) return { geraet: null, grund: 'Dieser Browser bietet kein WebGPU an.' };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { geraet: null, grund: 'Es war keine Grafikeinheit zu bekommen.' };

    const kann = adapter.limits.maxStorageBuffersPerShaderStage ?? 0;
    if (kann < NOETIGE_PUFFER) {
      // Jetzt ehrlich sein statt mitten im Rechnen abbrechen: Reicht die
      // Grenze nicht, verwirft die Grafikeinheit den Shader beim ersten Lauf.
      return {
        geraet: null,
        grund: `Die Grafikeinheit erlaubt nur ${kann} Speicherpuffer je Shader, gebraucht werden ${NOETIGE_PUFFER}.`,
      };
    }

    const wunsch: Record<string, number> = {};
    for (const name of GRENZEN) {
      const wert = adapter.limits[name];
      if (typeof wert === 'number') wunsch[name] = wert;
    }

    try {
      return { geraet: await adapter.requestDevice({ requiredLimits: wunsch }) };
    } catch (fehler) {
      // Ein Adapter darf ablehnen, was er selbst gemeldet hat. Dann noch
      // einmal mit der einen Grenze, auf die es wirklich ankommt – erst wenn
      // auch das scheitert, ist hier Schluss. Ohne gehobene Grenze bräuchte
      // man gar nicht anzufangen.
      try {
        return {
          geraet: await adapter.requestDevice({
            requiredLimits: { maxStorageBuffersPerShaderStage: kann },
          }),
        };
      } catch {
        const text = fehler instanceof Error ? fehler.message : String(fehler);
        return {
          geraet: null,
          grund: `Die Grafikeinheit gab ihre eigenen Grenzen nicht frei (${text}).`,
        };
      }
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
 * Nur einmal geprüft: `requestDevice` gäbe beim zweiten Mal ein zweites
 * Gerät, und die Sitzung liefe dann auf einem anderen als dem geprüften.
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
 * Gibt das Gerät zurück, oder wirft mit einem Satz, den man zeigen kann.
 * Nicht als stiller Rückfall auf den Prozessor – siehe die Messung oben.
 */
export async function ortVorbereiten(
  // Alle Felder wahlfrei, weil `ort.env` sie so deklariert. Anders herum
  // liesse sich `ort.env` gar nicht übergeben.
  env: { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } },
  pfade: { wasm: string; mjs: string },
): Promise<unknown> {
  const laufzeit = await laufzeitEntscheiden();
  if (!laufzeit.geraet) {
    throw new Error(
      `„Hohe Qualität“ braucht eine Grafikeinheit. ${laufzeit.grund ?? ''} ` +
        'Auf dem Prozessor rechnet dieses Netz an einem Bild eine Viertelstunde – ' +
        'nimm „Beliebiges Objekt“, das braucht ein paar Sekunden.',
    );
  }
  // Die Laufzeit liegt beim eigenen Server, nicht bei einem fremden CDN.
  env.wasm.wasmPaths = pfade;
  // Mehrere Fäden brauchten die Kopfzeilen COOP/COEP – die setzen wir nicht.
  // Gerechnet wird ohnehin auf der Grafikeinheit.
  env.wasm.numThreads = 1;
  // Kein Arbeiter: Ein `GPUDevice` lässt sich nicht dorthin reichen, die
  // Laufzeit schickt beim Hochfahren ihre ganze Umgebung per `postMessage`.
  // Das ist verschmerzbar, weil die eigentliche Arbeit auf der Grafikeinheit
  // liegt und der Hauptfaden dabei überwiegend wartet.
  env.wasm.proxy = false;
  return laufzeit.geraet;
}
