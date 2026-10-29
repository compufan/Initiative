import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** Ein Speicher, der bei jedem Zugriff wirft – privates Fenster, gesperrte Website-Daten. */
function werfenderSpeicher() {
  const wirf = () => {
    throw new DOMException('gesperrt', 'SecurityError');
  };
  return { getItem: wirf, setItem: wirf, removeItem: wirf, clear: wirf };
}

let wahl: typeof import('./kartenWahl.js');

async function laden(speicher: unknown = fakeStorage()) {
  vi.resetModules();
  vi.stubGlobal('localStorage', speicher);
  wahl = await import('./kartenWahl.js');
}

beforeEach(async () => {
  await laden();
});

describe('Gemerkte Karten-App', () => {
  it('fragt jedes Mal, solange nichts gemerkt ist', () => {
    expect(wahl.leseKartenApp()).toBeNull();
    expect(wahl.gemerkteApp('andere')).toBeNull();
  });

  it('merkt eine Wahl und liest sie wieder', () => {
    wahl.schreibeKartenApp('waze');
    expect(wahl.leseKartenApp()).toBe('waze');
    expect(localStorage.getItem('initiative.karten-app')).toBe('waze');
  });

  it('löscht die Wahl mit null', () => {
    wahl.schreibeKartenApp('osm');
    wahl.schreibeKartenApp(null);
    expect(wahl.leseKartenApp()).toBeNull();
    expect(localStorage.getItem('initiative.karten-app')).toBeNull();
  });

  it('überschreibt eine frühere Wahl', () => {
    wahl.schreibeKartenApp('osm');
    wahl.schreibeKartenApp('bing');
    expect(wahl.leseKartenApp()).toBe('bing');
  });

  it.each(['', 'kaputt', 'Google', '{"a":1}', 'null', 'google '])(
    'ignoriert den unbekannten Wert %j',
    (wert) => {
      localStorage.setItem('initiative.karten-app', wert);
      expect(wahl.leseKartenApp()).toBeNull();
    },
  );

  it('ignoriert Schlüssel, die es nur als Eigenschaft von Object gibt', () => {
    localStorage.setItem('initiative.karten-app', 'constructor');
    expect(wahl.leseKartenApp()).toBeNull();
    localStorage.setItem('initiative.karten-app', '__proto__');
    expect(wahl.leseKartenApp()).toBeNull();
  });

  it('liefert die gemerkte App nur, wenn sie auf dieser Plattform angeboten wird', () => {
    wahl.schreibeKartenApp('system');
    expect(wahl.gemerkteApp('android')?.key).toBe('system');
    // `geo:` tut auf iOS, Mac und Desktop nichts: Dann soll das Blatt aufgehen.
    expect(wahl.gemerkteApp('ios')).toBeNull();
    expect(wahl.gemerkteApp('mac')).toBeNull();
    expect(wahl.gemerkteApp('andere')).toBeNull();

    wahl.schreibeKartenApp('apple');
    expect(wahl.gemerkteApp('ios')?.key).toBe('apple');
    expect(wahl.gemerkteApp('mac')?.key).toBe('apple');
    expect(wahl.gemerkteApp('android')).toBeNull();
    expect(wahl.gemerkteApp('andere')).toBeNull();

    wahl.schreibeKartenApp('google');
    for (const plattform of ['ios', 'android', 'mac', 'andere'] as const) {
      expect(wahl.gemerkteApp(plattform)?.key).toBe('google');
    }
  });

  it('gibt die App samt Namen zurück – für „öffnet in …“', () => {
    wahl.schreibeKartenApp('waze');
    expect(wahl.gemerkteApp('ios')?.name).toBe('Waze');
  });

  it('kann die Wahl auch ohne Aufruf des Speichers übergeben bekommen', () => {
    expect(wahl.gemerkteApp('andere', 'osm')?.key).toBe('osm');
    expect(wahl.gemerkteApp('andere', null)).toBeNull();
  });
});

describe('Benachrichtigung', () => {
  it('meldet jede Änderung an die Beobachter und hört nach dem Abmelden auf', () => {
    const aufruf = vi.fn();
    const abmelden = wahl.kartenAppBeobachten(aufruf);
    wahl.schreibeKartenApp('google');
    expect(aufruf).toHaveBeenCalledTimes(1);
    wahl.schreibeKartenApp(null);
    expect(aufruf).toHaveBeenCalledTimes(2);
    abmelden();
    wahl.schreibeKartenApp('osm');
    expect(aufruf).toHaveBeenCalledTimes(2);
  });

  it('meldet auch, wenn der Speicher gesperrt ist', async () => {
    await laden(werfenderSpeicher());
    const aufruf = vi.fn();
    wahl.kartenAppBeobachten(aufruf);
    wahl.schreibeKartenApp('bing');
    expect(aufruf).toHaveBeenCalledTimes(1);
  });

  it('hört auf Änderungen aus einem zweiten Fenster (storage-Ereignis)', () => {
    const fenster = new EventTarget();
    vi.stubGlobal('window', fenster);
    const aufruf = vi.fn();
    const abmelden = wahl.kartenAppBeobachten(aufruf);

    const ereignis = (key: string | null) => Object.assign(new Event('storage'), { key });
    fenster.dispatchEvent(ereignis('initiative.karten-app'));
    expect(aufruf).toHaveBeenCalledTimes(1);
    // „Alles gelöscht“ (`key` ist null) betrifft die Wahl ebenfalls.
    fenster.dispatchEvent(ereignis(null));
    expect(aufruf).toHaveBeenCalledTimes(2);
    // Andere Schlüssel gehen uns nichts an.
    fenster.dispatchEvent(ereignis('initiative.theme'));
    expect(aufruf).toHaveBeenCalledTimes(2);

    abmelden();
    fenster.dispatchEvent(ereignis('initiative.karten-app'));
    expect(aufruf).toHaveBeenCalledTimes(2);
  });
});

describe('Speicher gesperrt', () => {
  it('behält die Wahl bis zum Neuladen, ohne zu werfen', async () => {
    await laden(werfenderSpeicher());
    expect(wahl.leseKartenApp()).toBeNull();
    expect(() => wahl.schreibeKartenApp('osm')).not.toThrow();
    expect(wahl.leseKartenApp()).toBe('osm');
    expect(wahl.gemerkteApp('andere')?.key).toBe('osm');
    expect(() => wahl.schreibeKartenApp(null)).not.toThrow();
    expect(wahl.leseKartenApp()).toBeNull();
  });

  it('bleibt beim Modulwert, auch wenn der Speicher zwischendurch leer aussieht', async () => {
    await laden(werfenderSpeicher());
    wahl.schreibeKartenApp('bing');
    // Ein Speicher, der zwar nicht wirft, aber nichts behält (z. B. ein
    // Fenster mit Kontingent 0): Gelesen wird der Modulwert.
    vi.stubGlobal('localStorage', fakeStorage());
    expect(wahl.leseKartenApp()).toBe('bing');
  });

  it('liest wieder aus dem Speicher, sobald ein Schreiben gelingt', async () => {
    await laden(werfenderSpeicher());
    wahl.schreibeKartenApp('bing');
    vi.stubGlobal('localStorage', fakeStorage());
    wahl.schreibeKartenApp('waze');
    expect(localStorage.getItem('initiative.karten-app')).toBe('waze');
    expect(wahl.leseKartenApp()).toBe('waze');
  });

  it('übersteht fehlendes localStorage', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', undefined);
    wahl = await import('./kartenWahl.js');
    expect(wahl.leseKartenApp()).toBeNull();
    expect(() => wahl.schreibeKartenApp('google')).not.toThrow();
    expect(wahl.leseKartenApp()).toBe('google');
  });
});
