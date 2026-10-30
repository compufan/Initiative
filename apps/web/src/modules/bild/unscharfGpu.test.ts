import { describe, expect, it } from 'vitest';
import { ausgelieheneAufraeumen, type UnscharfWerk } from './unscharfGpu.js';

/** Ein Werk aus Attrappen: genug, um zu sehen, was gelöscht wird. */
function attrappe() {
  const geloescht: string[] = [];
  const gl = {
    deleteFramebuffer: (p: unknown) => geloescht.push(`puffer:${String(p)}`),
    deleteTexture: (t: unknown) => geloescht.push(`textur:${String(t)}`),
  };
  const ziel = (name: string) => ({ textur: name, puffer: name, b: 4, h: 4, art: 'f16' });
  const ergebnis = ziel('ergebnis');
  const a = ziel('a');
  const b = ziel('b');
  const w = {
    gl,
    zaehler: { texturenLebend: 3 },
    vorrat: [],
    ausgeliehen: new Set([a, b, ergebnis]),
    ergebnis,
  } as unknown as UnscharfWerk;
  return {
    w,
    geloescht,
    zaehler: (w as unknown as { zaehler: { texturenLebend: number } }).zaehler,
  };
}

describe('ausgelieheneAufraeumen', () => {
  it('löscht, was ein gescheiterter Durchgang in der Hand hielt – nicht das Ergebnis', () => {
    const { w, geloescht, zaehler } = attrappe();
    ausgelieheneAufraeumen(w);
    expect(geloescht.sort()).toEqual(['puffer:a', 'puffer:b', 'textur:a', 'textur:b']);
    expect(zaehler.texturenLebend).toBe(1);
    expect(w.ausgeliehen.size).toBe(0);
  });

  it('tut beim zweiten Mal nichts mehr', () => {
    const { w, geloescht } = attrappe();
    ausgelieheneAufraeumen(w);
    const n = geloescht.length;
    ausgelieheneAufraeumen(w);
    expect(geloescht.length).toBe(n);
  });
});
