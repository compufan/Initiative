import { describe, expect, it } from 'vitest';
import {
  PRESSEN_FIGUR_GRENZEN,
  PRESSEN_FIGUR_MERKMALE,
  figurLesen,
  standardFigur,
  zufallsFigur,
} from './pressen-figur.js';

describe('Strichmännchen-Figur', () => {
  it('liest nur vollständige Figuren innerhalb der Grenzen', () => {
    const gut = standardFigur('abc');
    expect(figurLesen(gut)).toEqual(gut);
    expect(figurLesen({ ...gut, frisur: PRESSEN_FIGUR_GRENZEN.frisur + 1 })).toBeNull();
    expect(figurLesen({ ...gut, hut: -1 })).toBeNull();
    expect(figurLesen({ ...gut, bart: 1.5 })).toBeNull();
    expect(figurLesen({ ...gut, haut: '2' })).toBeNull();
    expect(figurLesen({ ...gut, skript: 1 })).toBeNull();
    const { shirt: _weg, ...ohneShirt } = gut;
    expect(figurLesen(ohneShirt)).toBeNull();
    expect(figurLesen(null)).toBeNull();
  });

  it('die Standardfigur ist stabil je Kennung und liegt in den Grenzen', () => {
    expect(standardFigur('u1')).toEqual(standardFigur('u1'));
    const verschieden = new Set(
      Array.from({ length: 30 }, (_, i) => JSON.stringify(standardFigur(`nutzer-${i}`))),
    );
    expect(verschieden.size).toBeGreaterThan(20);
    for (let i = 0; i < 50; i += 1) {
      const f = standardFigur(`k${i}`);
      for (const m of PRESSEN_FIGUR_MERKMALE) {
        expect(f[m]).toBeGreaterThanOrEqual(0);
        expect(f[m]).toBeLessThanOrEqual(PRESSEN_FIGUR_GRENZEN[m]);
      }
    }
  });

  it('Würfeln bleibt in den Grenzen, auch an den Rändern der Zufallszahl', () => {
    for (const z of [0, 0.5, 0.999999]) {
      const f = zufallsFigur(() => z);
      expect(figurLesen(f)).toEqual(f);
    }
  });
});
