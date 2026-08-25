import { describe, expect, it } from 'vitest';
import {
  STICKER_SIZE,
  cloneDoc,
  createDoc,
  isEmptyDoc,
  keepAtSeeds,
  lupeGrenzen,
  removeBackground,
  strichBloecke,
} from './render.js';
import type { Stroke } from './render.js';

/** Minimal stand-in for `ImageData` – the pure pipeline never touches the DOM. */
function makeImage(
  size: number,
  paint: (x: number, y: number) => [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const at = (y * size + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { width: size, height: size, data, colorSpace: 'srgb' } as unknown as ImageData;
}

const alphaAt = (image: ImageData, size: number, x: number, y: number) =>
  image.data[(y * size + x) * 4 + 3];

describe('removeBackground', () => {
  it('clears the corner colour and keeps the subject', () => {
    const size = 32;
    const image = makeImage(size, (x, y) =>
      x >= 10 && x < 22 && y >= 10 && y < 22 ? [220, 20, 20, 255] : [10, 200, 10, 255],
    );

    removeBackground(image, 30);

    expect(alphaAt(image, size, 0, 0)).toBe(0);
    expect(alphaAt(image, size, size - 1, size - 1)).toBe(0);
    expect(alphaAt(image, size, 16, 16)).toBe(255);
  });

  it('keeps background coloured areas that are enclosed by the subject', () => {
    const size = 32;
    const image = makeImage(size, (x, y) => {
      const ring = x >= 6 && x < 26 && y >= 6 && y < 26;
      const hole = x >= 12 && x < 20 && y >= 12 && y < 20;
      if (!ring || hole) return [10, 200, 10, 255];
      return [220, 20, 20, 255];
    });

    removeBackground(image, 30);

    expect(alphaAt(image, size, 16, 16)).toBe(255);
    expect(alphaAt(image, size, 0, 0)).toBe(0);
  });

  it('leaves a fully transparent image untouched', () => {
    const image = makeImage(4, () => [0, 0, 0, 0]);
    removeBackground(image, 40);
    expect([...image.data].every((value) => value === 0)).toBe(true);
  });
});

describe('document helpers', () => {
  it('clones strokes and text layers instead of sharing them', () => {
    const doc = createDoc();
    const copy = cloneDoc(doc);
    copy.strokes.push({ size: 10, points: [1, 2], mode: 'weg' });
    copy.top.value = 'Hallo';

    expect(doc.strokes).toHaveLength(0);
    expect(doc.top.value).toBe('');
  });

  it('knows when there is nothing to export yet', () => {
    const doc = createDoc();
    expect(isEmptyDoc(null, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'text' }, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'emoji', emoji: '🐱' }, doc)).toBe(false);
    expect(isEmptyDoc(null, { ...doc, top: { ...doc.top, value: 'Moin' } })).toBe(false);
  });
});

describe('keepAtSeeds', () => {
  /** Roter Kreis auf blauem Grund – wie ein Motiv vor einem Hintergrund. */
  const motif = () =>
    makeImage(40, (x, y) => {
      const inside = (x - 20) ** 2 + (y - 20) ** 2 < 100;
      return inside ? [220, 40, 40, 255] : [40, 60, 220, 255];
    });

  const alphaAt = (image: ImageData, x: number, y: number) =>
    image.data[(y * image.width + x) * 4 + 3];

  it('behaelt das angetippte Motiv und entfernt den Rest', () => {
    const image = motif();
    keepAtSeeds(image, [{ x: 20, y: 20 }], 40);

    expect(alphaAt(image, 20, 20)).toBeGreaterThan(200); // Mitte des Motivs
    expect(alphaAt(image, 1, 1)).toBe(0); // Ecke im Hintergrund
    expect(alphaAt(image, 39, 39)).toBe(0);
  });

  it('setzt mehrere Antipper zusammen', () => {
    // Zwei getrennte Farbfelder nebeneinander.
    const image = makeImage(40, (x) => (x < 20 ? [10, 200, 10, 255] : [200, 200, 10, 255]));

    keepAtSeeds(image, [{ x: 5, y: 20 }], 30);
    expect(alphaAt(image, 5, 20)).toBeGreaterThan(200);
    expect(alphaAt(image, 35, 20)).toBe(0); // zweites Feld noch nicht angetippt

    const both = makeImage(40, (x) => (x < 20 ? [10, 200, 10, 255] : [200, 200, 10, 255]));
    keepAtSeeds(
      both,
      [
        { x: 5, y: 20 },
        { x: 35, y: 20 },
      ],
      30,
    );
    expect(alphaAt(both, 5, 20)).toBeGreaterThan(200);
    expect(alphaAt(both, 35, 20)).toBeGreaterThan(200);
  });

  it('laesst das Bild unveraendert, wenn nichts angetippt wurde', () => {
    const image = motif();
    keepAtSeeds(image, [], 40);
    expect(alphaAt(image, 1, 1)).toBe(255);
  });
});

describe('Pinselstriche', () => {
  const strich = (mode: Stroke['mode'], size = 10): Stroke => ({ size, points: [0, 0], mode });

  it('fasst zusammen, was hintereinander in dieselbe Richtung geht', () => {
    const bloecke = strichBloecke([strich('weg'), strich('weg'), strich('zurueck')]);
    expect(bloecke.map((block) => block.length)).toEqual([2, 1]);
    expect(bloecke.map((block) => block[0].mode)).toEqual(['weg', 'zurueck']);
  });

  it('lässt den letzten Strich gewinnen, wenn sich die Richtung abwechselt', () => {
    // Radiert, zurückgeholt, wieder radiert: drei Blöcke, in dieser Reihenfolge.
    // Würde man nach Richtung sortieren, bliebe am Ende das Zurückgeholte
    // stehen – also das Gegenteil dessen, was zuletzt gemacht wurde.
    const bloecke = strichBloecke([strich('weg'), strich('zurueck'), strich('weg')]);
    expect(bloecke).toHaveLength(3);
    expect(bloecke.map((block) => block[0].mode)).toEqual(['weg', 'zurueck', 'weg']);
  });

  it('kommt mit gar keinem Strich zurecht', () => {
    expect(strichBloecke([])).toEqual([]);
  });
});

describe('Lupe', () => {
  const mitte = STICKER_SIZE / 2;

  it('lässt sich nicht unter 1× oder über das Maximum drehen', () => {
    expect(lupeGrenzen({ zoom: 0.2, x: mitte, y: mitte }, 8).zoom).toBe(1);
    expect(lupeGrenzen({ zoom: 99, x: mitte, y: mitte }, 8).zoom).toBe(8);
  });

  it('hält den Ausschnitt im Bild, statt daneben zu geraten', () => {
    const links = lupeGrenzen({ zoom: 4, x: -500, y: -500 }, 8);
    // Bei 4× ist der sichtbare Ausschnitt ein Viertel breit; sein Mittelpunkt
    // kann also höchstens ein Achtel vom Rand entfernt stehen.
    expect(links.x).toBe(STICKER_SIZE / 8);
    expect(links.y).toBe(STICKER_SIZE / 8);

    const rechts = lupeGrenzen({ zoom: 4, x: 9999, y: 9999 }, 8);
    expect(rechts.x).toBe(STICKER_SIZE - STICKER_SIZE / 8);
  });

  it('gibt bei 1× die ganze Fläche frei – der Mittelpunkt ist dann die Mitte', () => {
    const ganz = lupeGrenzen({ zoom: 1, x: 0, y: STICKER_SIZE }, 8);
    expect(ganz).toEqual({ zoom: 1, x: mitte, y: mitte });
  });
});
