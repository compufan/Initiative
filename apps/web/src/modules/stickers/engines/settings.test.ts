import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_INFO } from './types.js';

/** Kleiner Ersatz für `localStorage`, den es in der Testumgebung nicht gibt. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

let settings: typeof import('./settings.js');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', fakeStorage());
  settings = await import('./settings.js');
});

describe('Freistell-Verfahren pro Gerät', () => {
  it('liefert die Vorgaben, solange nichts gespeichert ist', () => {
    const current = settings.readEngineSettings();
    for (const engine of ENGINE_INFO) {
      expect(current[engine.key]).toBe(engine.defaultEnabled);
    }
  });

  it('hat das grosse Modell von Haus aus aus', () => {
    // 44 MB laedt man nicht ungefragt auf ein Handy.
    expect(settings.isEngineEnabled('object')).toBe(false);
    expect(ENGINE_INFO.find((e) => e.key === 'object')?.downloadMb).toBeGreaterThan(20);
  });

  it('merkt sich eine Aenderung', () => {
    settings.writeEngineSetting('object', true);
    expect(settings.isEngineEnabled('object')).toBe(true);

    settings.writeEngineSetting('person', false);
    expect(settings.isEngineEnabled('person')).toBe(false);
    // Die anderen bleiben unberuehrt.
    expect(settings.isEngineEnabled('object')).toBe(true);
    expect(settings.isEngineEnabled('tap')).toBe(true);
  });

  it('faellt bei kaputtem Eintrag auf die Vorgaben zurueck', () => {
    localStorage.setItem('initiative.cutout-engines', '{kein json');
    const current = settings.readEngineSettings();
    expect(current.tap).toBe(true);
    expect(current.object).toBe(false);
  });
});
