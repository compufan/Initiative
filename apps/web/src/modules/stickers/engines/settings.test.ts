import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_INFO, downloadHint, firstUseMb } from './types.js';

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
    // Mehrere Megabyte laedt man nicht ungefragt auf ein Handy.
    expect(settings.isEngineEnabled('object')).toBe(false);
    const objekt = ENGINE_INFO.find((e) => e.key === 'object');
    expect(objekt).toBeDefined();
    expect(firstUseMb(objekt!)).toBeGreaterThan(5);
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

describe('Groessenangaben', () => {
  it('rechnet die geteilte Laufzeit mit ein', () => {
    const person = ENGINE_INFO.find((e) => e.key === 'person')!;
    const gesicht = ENGINE_INFO.find((e) => e.key === 'face')!;
    // Beide brauchen dieselbe Laufzeit – deshalb ist die Summe der beiden
    // Erstnutzungen groesser als das, was tatsaechlich uebertragen wird.
    expect(person.runtime).toBe(gesicht.runtime);
    expect(firstUseMb(person)).toBeGreaterThan(person.modelMb);
    expect(downloadHint(person)).toContain('Gesicht');
  });

  it('sagt bei "Antippen" ausdruecklich, dass nichts geladen wird', () => {
    const tippen = ENGINE_INFO.find((e) => e.key === 'tap')!;
    expect(firstUseMb(tippen)).toBe(0);
    expect(downloadHint(tippen)).toMatch(/kein download/i);
  });
});
