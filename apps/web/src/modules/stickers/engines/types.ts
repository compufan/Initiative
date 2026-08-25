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

export type EngineKey = 'tap' | 'person' | 'face' | 'object';

export interface EngineInfo {
  key: EngineKey;
  label: string;
  /** Ein Satz, der erklärt, wofür das Verfahren taugt. */
  description: string;
  /** Einmaliger Download in Megabyte. `0` = nichts zu laden. */
  downloadMb: number;
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
    downloadMb: 0,
    defaultEnabled: true,
  },
  {
    key: 'person',
    label: 'Person',
    description: 'Erkennt Menschen und trennt sie vom Hintergrund.',
    downloadMb: 3,
    defaultEnabled: true,
  },
  {
    key: 'face',
    label: 'Gesicht',
    description: 'Findet Gesichter und schneidet passend zu.',
    downloadMb: 1,
    defaultEnabled: true,
  },
  {
    key: 'object',
    label: 'Beliebiges Objekt',
    description:
      'Stellt auch Gegenstände frei. Braucht einen großen einmaligen Download und rechnet auf älteren Geräten spürbar länger.',
    downloadMb: 44,
    defaultEnabled: false,
  },
];
