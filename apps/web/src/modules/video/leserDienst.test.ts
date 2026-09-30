import { afterEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import type { VideoLeser } from './bilderLesen.js';
import { LEERLAUF_MS, leserDienst } from './leserDienst.js';

/**
 * Der geteilte Leser: Reihenfolge, Vorfahrt, ein Auftrag für voll und grau,
 * Schliessen nach Ruhe.
 *
 * Der Ersatz für `VideoLeser` springt nicht wirklich; er schreibt mit, was
 * verlangt wurde, und lässt sich von Hand anhalten.
 */

interface Aufruf {
  ms: number;
  klein: boolean;
}

function ersatz() {
  const aufrufe: Aufruf[] = [];
  let geoeffnet = 0;
  let geschlossen = 0;
  let halten: Promise<void> | null = null;
  let loslassen: () => void = () => {};
  const oeffnen = async (): Promise<VideoLeser> => {
    geoeffnet += 1;
    return {
      breite: 96,
      hoehe: 54,
      quellBreite: 1920,
      quellHoehe: 1080,
      dauerMs: 5000,
      async bildAn(ms, abbruch, groesse) {
        aufrufe.push({ ms, klein: groesse !== undefined });
        if (halten) await halten;
        if (abbruch?.aborted) throw new AbbruchError();
        const b = groesse?.b ?? 96;
        const h = groesse?.h ?? 54;
        return {
          data: new Uint8ClampedArray(b * h * 4).fill(ms % 256),
          width: b,
          height: h,
        } as ImageData;
      },
      schliessen() {
        geschlossen += 1;
      },
    };
  };
  return {
    oeffnen,
    aufrufe,
    get geoeffnet() {
      return geoeffnet;
    },
    get geschlossen() {
      return geschlossen;
    },
    anhalten() {
      halten = new Promise((weiter) => {
        loslassen = () => {
          halten = null;
          weiter();
        };
      });
    },
    weiter() {
      loslassen();
    },
  };
}

const DATEI = new Blob([]);
const ruhe = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('leserDienst', () => {
  it('liefert voll und grau aus EINEM Auftrag an derselben Stelle', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const lesung = await dienst.holen(100, 'hinten', { voll: true, grau: true });
    expect(lesung.voll?.width).toBe(96);
    expect(lesung.grau?.breite).toBe(96);
    expect(e.aufrufe).toEqual([
      { ms: 100, klein: false },
      { ms: 100, klein: true },
    ]);
    // Ohne Angabe: das volle Bild, und nur das.
    const nurVoll = await dienst.holen(140, 'vorn');
    expect(nurVoll.grau).toBeNull();
    expect(nurVoll.voll).not.toBeNull();
    expect(e.geoeffnet).toBe(1);
    dienst.schliessen();
  });

  it("lässt 'vorn' vor jedem wartenden 'hinten' – einen Auftrag zur Zeit", async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const erste = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const zweite = dienst.holen(40, 'hinten', { grau: true });
    const editor = dienst.holen(2000, 'vorn');
    await ruhe();
    // Der laufende Sprung läuft allein.
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0]);
    e.weiter();
    await Promise.all([erste, editor, zweite]);
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0, 2000, 40]);
    dienst.schliessen();
  });

  it('nimmt einen abgebrochenen wartenden Auftrag heraus', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const erste = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const steuer = new AbortController();
    const zweite = dienst.holen(40, 'hinten', { grau: true, abbruch: steuer.signal });
    steuer.abort();
    await expect(zweite).rejects.toBeInstanceOf(AbbruchError);
    e.weiter();
    await erste;
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0]);
    dienst.schliessen();
  });

  it('schliesst nach Ruhe und öffnet beim nächsten Auftrag wieder', async () => {
    vi.useFakeTimers();
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    await dienst.holen(0, 'vorn');
    expect(dienst.offen).toBe(true);
    await vi.advanceTimersByTimeAsync(LEERLAUF_MS - 1000);
    expect(e.geschlossen).toBe(0);
    // Ein Auftrag setzt die Ruhe zurück.
    await dienst.holen(40, 'hinten', { grau: true });
    await vi.advanceTimersByTimeAsync(LEERLAUF_MS - 1000);
    expect(e.geschlossen).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.geschlossen).toBe(1);
    expect(dienst.offen).toBe(false);
    await dienst.holen(80, 'vorn');
    expect(e.geoeffnet).toBe(2);
    dienst.schliessen();
  });

  it('lässt beim Schliessen alle Wartenden scheitern und bricht den laufenden Sprung ab', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const laufend = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const wartend = dienst.holen(40, 'vorn');
    dienst.schliessen();
    e.weiter();
    await expect(wartend).rejects.toBeInstanceOf(AbbruchError);
    await expect(laufend).rejects.toBeInstanceOf(AbbruchError);
    expect(e.geschlossen).toBe(1);
    // Und danach geht es weiter – der Dienst gehört der Sitzung.
    expect((await dienst.holen(80, 'vorn')).voll).not.toBeNull();
    dienst.schliessen();
  });

  it('meldet die Masse des Videos', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    expect(await dienst.masse()).toEqual({
      breite: 96,
      hoehe: 54,
      quellBreite: 1920,
      quellHoehe: 1080,
      dauerMs: 5000,
    });
    dienst.schliessen();
  });
});
