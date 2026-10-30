import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntfaltungFehler, entfaltenAufGpu, entfaltungGpuAbschalten } from './entfaltungGpu.js';
import type { Kern } from './entfaltung.js';

/**
 * Ein WebGL2-Kontext zum Nachzählen: Er rechnet nichts, merkt sich aber, was
 * angelegt und wieder gelöscht wurde. Konstanten sind ihre eigenen Namen.
 */
function attrappe(optionen: { scheitertWenn?: (quelle: string) => boolean } = {}) {
  const lebend = {
    programm: new Set<object>(),
    shader: new Set<object>(),
    textur: new Set<object>(),
    rahmen: new Set<object>(),
    puffer: new Set<object>(),
  };
  const gebaut = { programme: 0, kontexte: 0 };
  const quellen = new Map<object, string>();
  const zustand = { verloren: false };
  const anlegen = (art: keyof typeof lebend) => () => {
    const ding = { art };
    lebend[art].add(ding);
    if (art === 'programm') gebaut.programme += 1;
    return ding;
  };
  const loeschen = (art: keyof typeof lebend) => (ding: object | null) => {
    if (ding) lebend[art].delete(ding);
  };
  const echt: Record<string, unknown> = {
    createProgram: anlegen('programm'),
    deleteProgram: loeschen('programm'),
    createShader: anlegen('shader'),
    deleteShader: loeschen('shader'),
    createTexture: anlegen('textur'),
    deleteTexture: loeschen('textur'),
    createFramebuffer: anlegen('rahmen'),
    deleteFramebuffer: loeschen('rahmen'),
    createBuffer: anlegen('puffer'),
    deleteBuffer: loeschen('puffer'),
    shaderSource: (shader: object, quelle: string) => quellen.set(shader, quelle),
    getShaderParameter: (shader: object) =>
      !(optionen.scheitertWenn?.(quellen.get(shader) ?? '') ?? false),
    getProgramParameter: () => true,
    getParameter: () => 256,
    getExtension: () => ({}),
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    isContextLost: () => zustand.verloren,
    getShaderInfoLog: () => 'Attrappe',
  };
  const gl = new Proxy(echt, {
    get(ziel, name) {
      if (typeof name !== 'string') return undefined;
      if (name in ziel) return ziel[name];
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return () => null;
    },
  });
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: (art: string) => {
        if (art !== 'webgl2') return null;
        gebaut.kontexte += 1;
        return gl;
      },
    }),
  });
  return { lebend, gebaut, zustand };
}

const kern: Kern = {
  breite: 3,
  hoehe: 1,
  mx: 1,
  my: 0,
  werte: new Float32Array([0.25, 0.5, 0.25]),
};
const auftrag = () => ({
  quelle: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) } as ImageData,
  kern,
  iterationen: 3,
  daempfung: 0,
  saumRadius: 2,
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => f());
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Das Werk ist modulweit gemerkt – jeder Fall fängt ohne an.
  entfaltungGpuAbschalten(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('entfaltenAufGpu – Programme und Aufräumen', () => {
  it('baut die fünf Programme einmal je Kontext und lässt nach dem Lauf nichts anderes liegen', async () => {
    const { lebend, gebaut } = attrappe();
    await entfaltenAufGpu(auftrag());
    await entfaltenAufGpu(auftrag());
    await entfaltenAufGpu(auftrag());
    // Vorher: fünf neue Programme je Lauf (15), dazu zehn Schattierer, die nie gelöscht wurden.
    expect(gebaut.programme).toBe(5);
    expect(lebend.programm.size).toBe(5);
    expect(lebend.shader.size).toBe(0);
    expect(lebend.textur.size).toBe(0);
    expect(lebend.rahmen.size).toBe(0);
    expect(lebend.puffer.size).toBe(0);
  });

  it('räumt bei einem Schattierer, der nicht übersetzt, alles weg und baut ihn nicht jedes Mal neu', async () => {
    const { lebend, gebaut } = attrappe({ scheitertWenn: (q) => q.includes('uAchse') });
    await expect(entfaltenAufGpu(auftrag())).rejects.toBeInstanceOf(EntfaltungFehler);
    await expect(entfaltenAufGpu(auftrag())).rejects.toBeInstanceOf(EntfaltungFehler);
    // Vier Programme gelangen und bleiben im Vorrat; vom gescheiterten bleibt nichts.
    expect(gebaut.programme).toBe(4);
    expect(lebend.programm.size).toBe(4);
    expect(lebend.shader.size).toBe(0);
    expect(lebend.textur.size).toBe(0);
    expect(lebend.puffer.size).toBe(0);
  });

  it('meldet einen verlorenen Kontext, statt schwarz zu liefern, und baut danach neu', async () => {
    const { gebaut, zustand } = attrappe();
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
      zustand.verloren = true;
      f();
    });
    await expect(entfaltenAufGpu(auftrag())).rejects.toThrow(/zurückgesetzt/);
    expect(gebaut.kontexte).toBe(1);

    zustand.verloren = false;
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => f());
    // Die Attrappe gibt denselben Kontext zurück; gezählt wird, dass neu
    // angefragt und neu gebaut wurde.
    zustand.verloren = true;
    const nochmal = entfaltenAufGpu(auftrag());
    zustand.verloren = false;
    await nochmal;
    expect(gebaut.kontexte).toBe(2);
    expect(gebaut.programme).toBe(10);
  });
});
