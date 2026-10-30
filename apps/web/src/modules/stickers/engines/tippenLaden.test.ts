import { describe, expect, it, vi } from 'vitest';

/*
 * Die Laufzeit als Attrappe: Der Encoder lädt, der Decoder nicht. Geprüft
 * wird, dass der geladene Encoder dann nicht unerreichbar im Speicher bleibt.
 */
const freigegeben = vi.fn(() => Promise.resolve());
vi.mock('onnxruntime-web/wasm', () => ({
  env: { wasm: {} },
  InferenceSession: {
    create: (url: string) =>
      url.includes('decoder')
        ? Promise.reject(new Error('Decoder fehlt'))
        : Promise.resolve({ release: freigegeben }),
  },
}));

const { tippenMask } = await import('./tippen.js');

describe('NanoSAM laden', () => {
  it('gibt den Encoder frei, wenn der Decoder nicht lädt', async () => {
    const bild = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;
    await expect(tippenMask(bild, [{ x: 1, y: 1, dazu: true }])).rejects.toThrow('Decoder fehlt');
    expect(freigegeben).toHaveBeenCalledTimes(1);
  });
});
