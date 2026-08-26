/**
 * Freistell-Verfahren im Sticker-Studio.
 *
 * Jedes Verfahren liefert eine Maske: für jeden Bildpunkt einen Wert von 0
 * (weg) bis 255 (bleibt). Das eigentliche Anwenden passiert an einer Stelle in
 * `render.ts`, damit sich die Verfahren nicht gegenseitig in die Quere kommen.
 *
 * Die schweren Verfahren laden ihr Modell erst beim ersten Benutzen. Das
 * geschieht ausschließlich im Gerät – der Server ist daran nicht beteiligt und
 * es entstehen keine laufenden Kosten.
 */

export type EngineKey = 'tap' | 'person' | 'face' | 'object' | 'birefnet';

/**
 * Welche Laufzeit ein Verfahren braucht.
 *
 * Wichtig für die Größenangabe: „Person“ und „Gesicht“ teilen sich wirklich
 * dieselbe Laufzeit. Wer eines von beiden benutzt hat, lädt beim anderen nur
 * noch das Modell – ein Fünftel Megabyte statt dreieinhalb.
 *
 * `onnx` und `onnx-gpu` teilen sie **nicht**, auch wenn beide „ONNX Runtime“
 * heissen: Der Einstiegspunkt `onnxruntime-web/wasm` lädt
 * `ort-wasm-simd-threaded.wasm`, `onnxruntime-web/webgpu` dagegen die
 * asyncify-Fassung. Zwei Dateien, zwei Downloads.
 *
 * Hier stand für beide `onnx`, und `downloadHint()` versprach deshalb, wer
 * „Beliebiges Objekt“ schon habe, brauche für „Hohe Qualität“ nur noch das
 * Modell. Das stimmte nie – vorher waren es die jsep- statt der
 * asyncify-Fassung, also ebenfalls zwei verschiedene Dateien.
 */
export type RuntimeKind = 'keine' | 'mediapipe' | 'onnx' | 'onnx-gpu';

/**
 * Was die jeweilige Laufzeit einmalig kostet – komprimiert übertragen, MiB.
 *
 * Nachgemessen mit `gzip -c dist/assets/*.wasm`. Bei `.wasm` komprimiert
 * Caddy von sich aus (am laufenden Server geprüft: `content-encoding: gzip`),
 * hier ist also nichts vorzubereiten.
 */
export const RUNTIME_MB: Record<RuntimeKind, number> = {
  keine: 0,
  mediapipe: 3.3,
  onnx: 3.4,
  'onnx-gpu': 6.1,
};

export interface EngineInfo {
  key: EngineKey;
  label: string;
  /** Ein Satz, der erklärt, wofür das Verfahren taugt. */
  description: string;
  /**
   * Das Modell selbst, **so wie es über die Leitung geht**, in MiB.
   *
   * Also die komprimierte Grösse: `scripts/prepare-models.mjs` legt zu jedem
   * Modell über 1 MiB eine `.gz` daneben, und der Web-Caddy reicht sie mit
   * `precompressed gzip` durch. Ohne das lieferte er `.onnx` roh aus – Caddy
   * komprimiert unterwegs nur, was es nach dem Inhaltstyp dafür hält, und
   * `.onnx` kennt es nicht.
   *
   * Diese Zahl wird mit `RUNTIME_MB` addiert (`firstUseMb`) – beide müssen
   * deshalb dasselbe meinen.
   */
  modelMb: number;
  runtime: RuntimeKind;
  /** Ob es standardmäßig zur Verfügung steht. */
  defaultEnabled: boolean;
}

export interface CutoutEngine extends EngineInfo {
  /** Ob das Gerät die nötigen Bausteine überhaupt mitbringt. */
  supported: () => Promise<boolean>;
  /**
   * Berechnet die Maske. `seed` ist der angetippte Punkt, falls das Verfahren
   * einen braucht (Bildkoordinaten der Sticker-Fläche).
   */
  mask: (image: ImageData, seed?: { x: number; y: number }) => Promise<Uint8Array>;
}

/** Beschreibungen aller Verfahren – auch der abgeschalteten, für die Liste. */
export const ENGINE_INFO: EngineInfo[] = [
  {
    key: 'tap',
    label: 'Antippen',
    description: 'Tippe an, was bleiben soll. Ohne Download, funktioniert auf jedem Gerät.',
    modelMb: 0,
    runtime: 'keine',
    defaultEnabled: true,
  },
  {
    key: 'person',
    label: 'Person',
    description: 'Erkennt Menschen und trennt sie vom Hintergrund.',
    modelMb: 0.24,
    runtime: 'mediapipe',
    defaultEnabled: true,
  },
  {
    key: 'face',
    label: 'Gesicht',
    description: 'Findet Gesichter und schneidet als Kopf zu – mit Stirn und Haaren.',
    modelMb: 0.22,
    runtime: 'mediapipe',
    defaultEnabled: true,
  },
  {
    key: 'object',
    label: 'Beliebiges Objekt',
    description:
      'Stellt auch Gegenstände frei – Tasse, Hund, Blume. Rechnet auf älteren Geräten spürbar länger.',
    modelMb: 4.0,
    runtime: 'onnx',
    defaultEnabled: false,
  },
  {
    key: 'birefnet',
    label: 'Hohe Qualität',
    description:
      'Dasselbe wie „Beliebiges Objekt“, nur deutlich genauer an Haaren, Zäunen und Brillenbügeln. Dafür der mit Abstand größte Download. Braucht eine Grafikeinheit – ohne sie dauert ein Bild mehrere Minuten.',
    modelMb: 78.3,
    runtime: 'onnx-gpu',
    defaultEnabled: false,
  },
];

/** Was das Verfahren beim allerersten Benutzen kostet, in Megabyte. */
export function firstUseMb(info: EngineInfo): number {
  return Math.round((info.modelMb + RUNTIME_MB[info.runtime]) * 10) / 10;
}

/** Ein Satz zur Downloadgröße, so wie er in den Einstellungen steht. */
export function downloadHint(info: EngineInfo): string {
  if (info.runtime === 'keine') return 'Kein Download nötig.';
  const gesamt = firstUseMb(info).toLocaleString('de-DE');
  const geteilt = ENGINE_INFO.filter(
    (other) => other.runtime === info.runtime && other.key !== info.key,
  );
  const zusatz = info.modelMb.toLocaleString('de-DE');
  if (geteilt.length === 0) {
    return `Einmalig ${gesamt} MB laden, danach im Gerät gespeichert.`;
  }
  const namen = geteilt.map((other) => `„${other.label}“`).join(' und ');
  return `Einmalig ${gesamt} MB laden, danach im Gerät gespeichert. Zusammen mit ${namen} genutzt – wer das schon geladen hat, braucht hier nur noch ${zusatz} MB.`;
}
