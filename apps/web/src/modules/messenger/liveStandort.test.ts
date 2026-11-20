import { describe, expect, it, vi } from 'vitest';
import { abstandMeter, liveSteuerung, type LiveUmgebung } from './liveStandort.js';

function umgebung(start = Date.parse('2026-01-01T12:00:00Z')) {
  let jetzt = start;
  let sichtbar = true;
  let weiter: ((p: { lat: number; lon: number }) => void) | null = null;
  let verlassen: (() => void) | null = null;
  const wecker = new Map<number, { f: () => void; um: number }>();
  let naechste = 1;
  const senden = vi.fn(async () => ({}));
  const beenden = vi.fn(async () => ({}));
  const aufhoeren = vi.fn();
  const u: LiveUmgebung = {
    beobachten: (w) => {
      weiter = w;
      return 7;
    },
    aufhoeren,
    sichtbar: () => sichtbar,
    beiVerlassen: (f) => {
      verlassen = f;
      return () => {
        verlassen = null;
      };
    },
    jetzt: () => jetzt,
    wecker: (f, ms) => {
      const id = naechste++;
      wecker.set(id, { f, um: jetzt + ms });
      return id;
    },
    weckerAus: (id) => wecker.delete(id),
    senden,
    beenden,
  };
  return {
    u,
    senden,
    beenden,
    aufhoeren,
    punkt: (lat: number, lon: number) => weiter?.({ lat, lon }),
    vergehen: (ms: number) => {
      jetzt += ms;
      for (const [id, w] of [...wecker]) {
        if (w.um <= jetzt) {
          wecker.delete(id);
          w.f();
        }
      }
    },
    verbergen: () => {
      sichtbar = false;
      verlassen?.();
    },
  };
}

const BIS_15 = '2026-01-01T12:15:00Z';

describe('Live-Standort', () => {
  it('meldet Punkte gedrosselt und nur bei Bewegung oder nach einer Minute', () => {
    const e = umgebung();
    const s = liveSteuerung(e.u);
    expect(s.starten('m1', BIS_15)).toBe(true);
    e.punkt(47, 8);
    expect(e.senden).toHaveBeenCalledTimes(1);
    e.vergehen(2_000);
    e.punkt(47.01, 8);
    expect(e.senden).toHaveBeenCalledTimes(1); // zu früh
    e.vergehen(10_000);
    e.punkt(47, 8.00001); // kaum bewegt
    expect(e.senden).toHaveBeenCalledTimes(1);
    e.vergehen(60_000);
    e.punkt(47, 8.00001);
    expect(e.senden).toHaveBeenCalledTimes(2);
  });

  it('endet zur Zeit, beim Verbergen der App und meldet das dem Server', () => {
    const e = umgebung();
    const s = liveSteuerung(e.u);
    s.starten('m1', BIS_15);
    e.vergehen(15 * 60_000);
    expect(e.beenden).toHaveBeenCalledWith('m1');
    expect(e.aufhoeren).toHaveBeenCalled();
    expect(s.aktiv()).toEqual([]);

    const f = umgebung();
    const t = liveSteuerung(f.u);
    t.starten('m2', BIS_15);
    f.verbergen();
    expect(f.beenden).toHaveBeenCalledWith('m2');
    expect(t.aktiv()).toEqual([]);
  });

  it('startet nicht, wenn die Zeit schon vorbei ist', () => {
    const e = umgebung(Date.parse('2026-01-01T13:00:00Z'));
    const s = liveSteuerung(e.u);
    expect(s.starten('m1', BIS_15)).toBe(false);
    expect(s.aktiv()).toEqual([]);
  });

  it('rechnet Abstände in Metern', () => {
    expect(Math.round(abstandMeter({ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }))).toBe(111);
  });
});
