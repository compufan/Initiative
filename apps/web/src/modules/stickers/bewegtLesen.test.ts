import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEILBILDER_MAX, teilbilderFolge, teilbilderLesen } from './bewegtLesen.js';

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

/**
 * Ein GIF von 4000 × 4000 Punkten mit sechzig Teilbildern, nachgebaut. Die
 * Bitmaps zählen ihre Bytes, solange sie offen sind.
 */
function grossesGif() {
  const offeneTeilbilder = new Set<number>();
  let offeneBytes = 0;
  let spitzeBytes = 0;
  let offeneBitmaps = 0;
  let spitzeBitmaps = 0;
  let decoderZu = false;
  const groessen: [number, number][] = [];

  class Decoder {
    completed = Promise.resolve();
    tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 60, animated: true } };
    decode({ frameIndex }: { frameIndex: number }) {
      offeneTeilbilder.add(frameIndex);
      return Promise.resolve({
        image: {
          displayWidth: 4000,
          displayHeight: 4000,
          duration: 80_000,
          close: () => offeneTeilbilder.delete(frameIndex),
        },
      });
    }
    close() {
      decoderZu = true;
    }
  }

  vi.stubGlobal('ImageDecoder', Decoder);
  vi.stubGlobal(
    'createImageBitmap',
    (
      bild: { displayWidth: number; displayHeight: number },
      optionen?: { resizeWidth?: number; resizeHeight?: number },
    ) => {
      const width = optionen?.resizeWidth ?? bild.displayWidth;
      const height = optionen?.resizeHeight ?? bild.displayHeight;
      groessen.push([width, height]);
      const bytes = width * height * 4;
      offeneBytes += bytes;
      offeneBitmaps += 1;
      spitzeBytes = Math.max(spitzeBytes, offeneBytes);
      spitzeBitmaps = Math.max(spitzeBitmaps, offeneBitmaps);
      let zu = false;
      return Promise.resolve({
        width,
        height,
        close: () => {
          if (zu) return;
          zu = true;
          offeneBytes -= bytes;
          offeneBitmaps -= 1;
        },
      });
    },
  );
  return {
    offeneTeilbilder,
    groessen,
    spitzeBytes: () => spitzeBytes,
    spitzeBitmaps: () => spitzeBitmaps,
    offeneBitmaps: () => offeneBitmaps,
    decoderZu: () => decoderZu,
  };
}

describe('teilbilderFolge', () => {
  it('hält bei einem riesigen GIF nur ein Teilbild in Flächengrösse', async () => {
    const gif = grossesGif();
    // Wie im Studio: 512 Flächenpunkte auf 4000 Quellpunkte, Zoom 1.
    const massstab = () => 512 / 4000;
    let anzahl = 0;
    for await (const { bild, breite, hoehe, dauerMs } of teilbilderFolge(
      new Blob([new Uint8Array(4)]),
      'image/gif',
      massstab,
    )) {
      // Die Koordinaten des Dokuments beziehen sich auf die Datei, nicht auf die Bitmap.
      expect([breite, hoehe]).toEqual([4000, 4000]);
      expect([bild.width, bild.height]).toEqual([512, 512]);
      expect(dauerMs).toBe(80);
      bild.close();
      anzahl += 1;
    }
    expect(anzahl).toBe(TEILBILDER_MAX);
    // Vorher: vierzig Bitmaps in Originalgrösse zugleich, 40 · 4000² · 4 = 2,56 GB.
    // Jetzt: eine in Flächengrösse, 512² · 4 ≈ 1 MB.
    expect(gif.spitzeBitmaps()).toBe(1);
    expect(gif.spitzeBytes()).toBe(512 * 512 * 4);
    expect([...gif.offeneTeilbilder]).toEqual([]);
    expect(gif.decoderZu()).toBe(true);
  });

  it('vergrössert nie über die Datei hinaus', async () => {
    const gif = grossesGif();
    const gelesen = await teilbilderLesen(new Blob([new Uint8Array(4)]), 'image/gif', () => 3);
    expect(gelesen).toHaveLength(TEILBILDER_MAX);
    expect(gif.groessen.every(([b, h]) => b === 4000 && h === 4000)).toBe(true);
    for (const { bild } of gelesen ?? []) bild.close();
  });

  it('schliesst den Entschlüssler, wenn der Aufrufer mittendrin aufhört', async () => {
    const gif = grossesGif();
    for await (const { bild } of teilbilderFolge(new Blob([new Uint8Array(4)]), 'image/gif')) {
      bild.close();
      break;
    }
    expect(gif.decoderZu()).toBe(true);
    expect(gif.offeneBitmaps()).toBe(0);
    expect([...gif.offeneTeilbilder]).toEqual([]);
  });
});
