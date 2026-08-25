import { ENGINE_INFO, type EngineKey } from './types.js';

/**
 * Welche Freistell-Verfahren auf **diesem Gerät** benutzt werden dürfen.
 *
 * Bewusst pro Gerät und nicht am Konto: Ein älteres iPhone soll das grosse
 * Modell abschalten können, ohne dass der Rechner darauf verzichten muss.
 */

const KEY = 'initiative.cutout-engines';

function defaults(): Record<EngineKey, boolean> {
  return Object.fromEntries(
    ENGINE_INFO.map((engine) => [engine.key, engine.defaultEnabled]),
  ) as Record<EngineKey, boolean>;
}

export function readEngineSettings(): Record<EngineKey, boolean> {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Partial<Record<EngineKey, boolean>>;
    for (const engine of ENGINE_INFO) {
      const value = stored[engine.key];
      if (typeof value === 'boolean') base[engine.key] = value;
    }
    return base;
  } catch {
    // Privater Modus oder kaputter Eintrag – dann eben die Vorgaben.
    return base;
  }
}

export function writeEngineSetting(key: EngineKey, enabled: boolean): Record<EngineKey, boolean> {
  const next = { ...readEngineSettings(), [key]: enabled };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* nicht speicherbar – gilt dann nur für diese Sitzung */
  }
  return next;
}

export function isEngineEnabled(key: EngineKey): boolean {
  return readEngineSettings()[key];
}
