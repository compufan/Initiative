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
   * Wird waehrend eines laengeren Ladens gerufen: Anteil 0…1 und ein Satz,
   * den man zeigen kann. Bei knapp 94 MB ist das kein Schmuck – ohne
   * Rueckmeldung steht der Anwender vor einem Knopf, der nichts tut.
   */
  fortschritt?: (anteil: number, text: string) => void;
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
  if (!engineAvailable(key)) {
    throw new EngineError(
      `„${engineInfo(key).label}“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten.`,
      key,
    );
  }

  try {
    switch (key) {
      case 'person': {
        const { personMask } = await import('./person.js');
        return await personMask(request.image);
      }
      case 'face': {
        const { faceMask } = await import('./face.js');
        return await faceMask(request.image, request.seed);
      }
      case 'object': {
        const { objectMask } = await import('./object.js');
        return await objectMask(request.image);
      }
      case 'birefnet': {
        const { birefnetMask } = await import('./birefnet.js');
        return await birefnetMask(request.image, request.fortschritt);
      }
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    const grund = error instanceof Error ? error.message : 'Unbekannter Fehler';
    throw new EngineError(grund, key);
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
    import('./birefnet.js').then((m) => m.releaseBirefnet()).catch(() => {}),
  ]);
}
