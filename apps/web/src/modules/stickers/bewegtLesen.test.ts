import { afterEach, describe, expect, it, vi } from 'vitest';
import { teilbilderLesen } from './bewegtLesen.js';

/**
 * Ein `ImageDecoder` zum Anfassen: drei Teilbilder, das dritte lässt sich
 * nicht in ein `ImageBitmap` wandeln. Gezählt wird, was offen bleibt.
 */
function aufbau() {
  const offeneTeilbilder = new Set<number>();
  const offeneBitmaps = new Set<number>();
  let decoderZu = false;

  class Decoder {
    completed = Promise.resolve();
    tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3, animated: true } };
    decode({ frameIndex }: { frameIndex: number }) {
      offeneTeilbilder.add(frameIndex);
      return Promise.resolve({
        image: {
          nummer: frameIndex,
          duration: 50_000,
          close: () => offeneTeilbilder.delete(frameIndex),
        },
      });
    }
    close() {
      decoderZu = true;
    }
  }

  vi.stubGlobal('ImageDecoder', Decoder);
  vi.stubGlobal('createImageBitmap', (bild: { nummer: number }) => {
    if (bild.nummer === 2) return Promise.reject(new Error('zu gross'));
    offeneBitmaps.add(bild.nummer);
    return Promise.resolve({ close: () => offeneBitmaps.delete(bild.nummer) });
  });
  return { offeneTeilbilder, offeneBitmaps, decoderZu: () => decoderZu };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('teilbilderLesen', () => {
  it('lässt nichts offen, wenn ein Teilbild mittendrin scheitert', async () => {
    const { offeneTeilbilder, offeneBitmaps, decoderZu } = aufbau();
    const gelesen = await teilbilderLesen(new Blob([new Uint8Array(4)]), 'image/gif');
    expect(gelesen).toBeNull();
    // Das gescheiterte Teilbild ist zu, und die beiden schon fertigen
    // Bitmaps auch – der Aufrufer sieht nur `null` und könnte es nicht.
    expect([...offeneTeilbilder]).toEqual([]);
    expect([...offeneBitmaps]).toEqual([]);
    expect(decoderZu()).toBe(true);
  });
});
