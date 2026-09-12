/**
 * Die Sammelstelle aller Freistell-Verfahren.
 *
 * Hier – und nur hier – wird entschieden, welches Verfahren gerade laufen
 * darf. Die schweren Verfahren werden per `import()` nachgeladen, damit weder
 * ihr Code noch ihr Modell im normalen Startpaket liegt: Wer nie einen
 * Sticker baut, lädt davon nichts.
 */

import { isEngineEnabled } from './settings.js';
import { ENGINE_INFO, type EngineInfo, type EngineKey } from './types.js';
import { runtimeSupported } from './runtime.js';

export type { EngineKey, EngineInfo } from './types.js';
export { ENGINE_INFO, downloadHint, firstUseMb } from './types.js';
export { readEngineSettings, writeEngineSetting, isEngineEnabled } from './settings.js';

export interface MaskRequest {
  image: ImageData;
  /** Der angetippte Punkt in Bildkoordinaten, falls es einen gibt. */
  seed?: { x: number; y: number };
  /**
   * Alle angetippten Punkte mit Vorzeichen, in Bildkoordinaten.
   *
   * Nur „Antippen mit Netz“ wertet das aus – dessen Netz nimmt beliebig viele
   * Punkte entgegen, und ein Minus-Tipp ist die einzige Art, „das nicht“ zu
   * sagen. Die anderen Verfahren brauchen hoechstens `seed`.
   */
  seeds?: { x: number; y: number; dazu: boolean }[];
  /**
   * Wird waehrend eines laengeren Ladens gerufen: Anteil 0…1 und ein Satz,
   * den man zeigen kann. Bei knapp 94 MB ist das kein Schmuck – ohne
   * Rueckmeldung steht der Anwender vor einem Knopf, der nichts tut.
   */
  fortschritt?: (anteil: number, text: string) => void;
  /**
   * Abbruch – für alles, was Minuten dauern kann.
   *
   * „Hohe Qualität“ zieht beim ersten Mal 78 MB und rechnet danach auf der
   * Grafikeinheit. Wer versehentlich darauf tippt, sass bis eben fest: Es gab
   * keinen Weg zurück, und auch das Schliessen des Studios half nicht, weil
   * der Arbeiter samt Modell weiterlief.
   *
   * Der Abbruch kann nicht überall sofort greifen – ein laufender
   * Modelldurchlauf im Arbeiter lässt sich nur beenden, indem man den
   * Arbeiter wegwirft; genau das tut `releaseEngines`. Was er zuverlässig
   * tut: den Download abbrechen und das Ergebnis verwerfen, statt es in eine
   * Oberfläche zu schreiben, die längst weitergezogen ist.
   */
  abbruch?: AbortSignal;
}

/** Wurde abgebrochen? Dann keine Fehlermeldung, sondern Stille. */
export class AbbruchError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'AbbruchError';
  }
}

function abbruchPruefen(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbbruchError();
}

/** Was beim Freistellen schiefgehen kann – mit einem Satz, den man zeigen kann. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly engine: EngineKey,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export function engineInfo(key: EngineKey): EngineInfo {
  const info = ENGINE_INFO.find((entry) => entry.key === key);
  if (!info) throw new Error(`Unbekanntes Verfahren: ${key}`);
  return info;
}

/**
 * Ob das Verfahren gerade benutzt werden darf: eingeschaltet **und** vom
 * Gerät unterstützt.
 */
export function engineAvailable(key: EngineKey): boolean {
  if (key === 'tap') return true;
  if (!isEngineEnabled(key)) return false;
  return runtimeSupported();
}

/**
 * Rechnet die Maske aus.
 *
 * Fehler kommen als `EngineError` zurück – mit einem Satz, der dem Anwender
 * sagt, was er stattdessen tun kann. Das Studio fällt dann auf „Antippen“
 * zurück, statt nur „Fehler“ anzuzeigen.
 */
export async function runEngine(key: EngineKey, request: MaskRequest): Promise<Uint8Array> {
  if (key === 'tap') {
    throw new EngineError('„Antippen“ läuft direkt im Editor, nicht über ein Modell.', key);
  }
  if (key === 'tiefe') {
    // Kein Freisteller: Das Tiefenmodell liefert eine Entfernung je
    // Bildpunkt und keine Silhouette. Es läuft über `bild/tiefeNetz.ts` und
    // teilt sich mit den Freistellern nur die Verwaltung – Schalter,
    // Downloadgrösse, Laufzeit.
    throw new EngineError(
      '„Tiefenschärfe“ läuft über den Foto-Editor, nicht über diese Liste.',
      key,
    );
  }
  if (!engineAvailable(key)) {
    throw new EngineError(
      `„${engineInfo(key).label}“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten.`,
      key,
    );
  }

  abbruchPruefen(request.abbruch);

  try {
    const maske = await rechnen(key, request);
    /*
     * Nach dem Lauf noch einmal fragen.
     *
     * Ein Modelldurchlauf lässt sich nicht mitten im Rechnen anhalten. Was
     * sich verhindern lässt: dass ein Ergebnis, auf das niemand mehr wartet,
     * in eine Oberfläche geschrieben wird, die inzwischen etwas anderes
     * zeigt – oder in ein Dokument, das der Anwender längst verworfen hat.
     */
    abbruchPruefen(request.abbruch);
    return maske;
  } catch (error) {
    if (error instanceof AbbruchError) throw error;
    if (error instanceof EngineError) throw error;
    const grund = error instanceof Error ? error.message : 'Unbekannter Fehler';
    throw new EngineError(grund, key);
  }
}

async function rechnen(key: EngineKey, request: MaskRequest): Promise<Uint8Array> {
  switch (key) {
    case 'person': {
      const { personMask } = await import('./person.js');
      return await personMask(request.image);
    }
    case 'face': {
      const { faceMask } = await import('./face.js');
      return await faceMask(request.image, request.seed);
    }
    case 'tippen': {
      const { tippenMask } = await import('./tippen.js');
      return await tippenMask(request.image, request.seeds ?? [], request.fortschritt);
    }
    case 'object': {
      const { objectMask } = await import('./object.js');
      return await objectMask(request.image, request.fortschritt, request.abbruch);
    }
    case 'birefnet': {
      const { birefnetMask } = await import('./birefnet.js');
      return await birefnetMask(request.image, request.fortschritt, request.abbruch);
    }
    default:
      throw new EngineError('Unbekanntes Verfahren.', key);
  }
}

/**
 * Gibt belegten Speicher wieder frei.
 *
 * Wird beim Schliessen des Studios aufgerufen. Auf einem Handy ist das kein
 * Luxus: die Laufzeit belegt zweistellige Megabyte, und iOS beendet Seiten,
 * die zu viel halten, kommentarlos.
 */
export async function releaseEngines(): Promise<void> {
  // Die Module selbst sind ein paar Kilobyte Code; das Modell laden sie erst
  // beim Rechnen. Das Aufräumen zieht also nichts herunter.
  await Promise.all([
    import('./person.js').then((m) => m.releasePerson()).catch(() => {}),
    import('./face.js').then((m) => m.releaseFace()).catch(() => {}),
    import('./object.js').then((m) => m.releaseObject()).catch(() => {}),
    import('./tippen.js').then((m) => m.releaseTippen()).catch(() => {}),
    import('./birefnet.js').then((m) => m.releaseBirefnet()).catch(() => {}),
  ]);
}
