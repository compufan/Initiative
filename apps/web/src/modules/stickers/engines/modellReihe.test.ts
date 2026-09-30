/**
 * Die Reihe, in der Modelle rechnen: die Verfolgung im Hintergrund hinten
 * an, der Editor vorn.
 *
 * Geprüft wird die Ordnung, nicht ein Modell: Die Arbeit ist ein Versprechen,
 * das der Test von Hand erfüllt. So lässt sich genau sagen, was wann läuft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Modul = typeof import('./index.js');

/** Ein Auftrag, den der Test von Hand beendet. */
function arbeit(name: string, protokoll: string[]) {
  let fertig: () => void = () => {};
  const versprechen = new Promise<string>((erfuellen) => {
    fertig = () => erfuellen(name);
  });
  return {
    lauf: async () => {
      protokoll.push(`${name}+`);
      const wert = await versprechen;
      protokoll.push(`${name}-`);
      return wert;
    },
    fertig: () => fertig(),
  };
}

const ruhe = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let modul: Modul;

beforeEach(async () => {
  vi.resetModules();
  modul = await import('./index.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('modellReihe', () => {
  it('rechnet für die Verfolgung einen Auftrag nach dem anderen', async () => {
    const protokoll: string[] = [];
    const a = arbeit('a', protokoll);
    const b = arbeit('b', protokoll);
    const pa = modul.modellReihe('hinten', a.lauf);
    const pb = modul.modellReihe('hinten', b.lauf);
    await ruhe();
    expect(protokoll).toEqual(['a+']);
    a.fertig();
    await pa;
    await ruhe();
    expect(protokoll).toEqual(['a+', 'a-', 'b+']);
    b.fertig();
    await pb;
    expect(modul.modellReiheStand()).toEqual({ vorn: 0, hinten: 0, wartend: 0 });
  });

  it("lässt 'vorn' an einem wartenden 'hinten' vorbei – und wartet nur auf den laufenden", async () => {
    const protokoll: string[] = [];
    const a = arbeit('hinten1', protokoll);
    const b = arbeit('hinten2', protokoll);
    const c = arbeit('vorn', protokoll);
    const pa = modul.modellReihe('hinten', a.lauf);
    const pb = modul.modellReihe('hinten', b.lauf);
    const pc = modul.modellReihe('vorn', c.lauf);
    await ruhe();
    // Der laufende Lauf der Verfolgung wird nicht unterbrochen.
    expect(protokoll).toEqual(['hinten1+']);
    a.fertig();
    await pa;
    await ruhe();
    expect(protokoll).toEqual(['hinten1+', 'hinten1-', 'vorn+']);
    c.fertig();
    await pc;
    await ruhe();
    expect(protokoll.at(-1)).toBe('hinten2+');
    b.fertig();
    await pb;
  });

  it("lässt mehrere 'vorn' nebeneinander laufen, wie bisher", async () => {
    const protokoll: string[] = [];
    const a = arbeit('a', protokoll);
    const b = arbeit('b', protokoll);
    const pa = modul.modellReihe('vorn', a.lauf);
    const pb = modul.modellReihe('vorn', b.lauf);
    const h = arbeit('h', protokoll);
    const ph = modul.modellReihe('hinten', h.lauf);
    await ruhe();
    expect(protokoll).toEqual(['a+', 'b+']);
    a.fertig();
    b.fertig();
    await Promise.all([pa, pb]);
    await ruhe();
    expect(protokoll.at(-1)).toBe('h+');
    h.fertig();
    await ph;
  });

  it('nimmt einen abgebrochenen wartenden Auftrag aus der Reihe', async () => {
    const protokoll: string[] = [];
    const a = arbeit('a', protokoll);
    const b = arbeit('b', protokoll);
    const steuer = new AbortController();
    const pa = modul.modellReihe('hinten', a.lauf);
    const pb = modul.modellReihe('hinten', b.lauf, { abbruch: steuer.signal });
    steuer.abort();
    await expect(pb).rejects.toBeInstanceOf(modul.AbbruchError);
    a.fertig();
    await pa;
    await ruhe();
    expect(protokoll).toEqual(['a+', 'a-']);
  });

  it('gibt die Arbeit auch nach einem Fehler frei', async () => {
    await expect(
      modul.modellReihe('hinten', async () => {
        throw new Error('kaputt');
      }),
    ).rejects.toThrow('kaputt');
    expect(await modul.modellReihe('hinten', async () => 'weiter')).toBe('weiter');
  });

  it('hält höchstens EINE schwere Sitzung der Verfolgung offen', async () => {
    const frei: string[] = [];
    modul.sitzungFreigeberSetzen('object', () => void frei.push('object'));
    modul.sitzungFreigeberSetzen('birefnet', () => void frei.push('birefnet'));
    await modul.modellReihe('hinten', async () => 'o', { verfahren: 'object' });
    expect(frei).toEqual([]);
    // Ein anderes schweres Verfahren: Die alte Sitzung geht, BEVOR es rechnet.
    let schonFrei: string[] = [];
    await modul.modellReihe(
      'hinten',
      async () => {
        schonFrei = [...frei];
        return 'b';
      },
      { verfahren: 'birefnet' },
    );
    expect(schonFrei).toEqual(['object']);
    // Leichte Verfahren ändern daran nichts.
    await modul.modellReihe('hinten', async () => 'p', { verfahren: 'person' });
    expect(frei).toEqual(['object']);
  });

  it('gibt die Sitzung der Verfolgung nach 20 s ohne Lauf frei', async () => {
    vi.useFakeTimers();
    const frei: string[] = [];
    modul.sitzungFreigeberSetzen('tiefe', () => void frei.push('tiefe'));
    await modul.modellReihe('hinten', async () => 1, { verfahren: 'tiefe' });
    await vi.advanceTimersByTimeAsync(modul.FREIGABE_NACH_MS - 100);
    expect(frei).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(frei).toEqual(['tiefe']);
  });

  it('überlässt die Sitzung dem Editor, sobald er sie selbst benutzt', async () => {
    vi.useFakeTimers();
    const frei: string[] = [];
    modul.sitzungFreigeberSetzen('object', () => void frei.push('object'));
    await modul.modellReihe('hinten', async () => 1, { verfahren: 'object' });
    await modul.modellReihe('vorn', async () => 2, { verfahren: 'object' });
    await vi.advanceTimersByTimeAsync(modul.FREIGABE_NACH_MS * 2);
    expect(frei).toEqual([]);
  });
});
