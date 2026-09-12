/**
 * Welche Striche das Bild bearbeiten und welche nur Farbe darüberlegen.
 *
 * Die Unterscheidung stand als Aufzählung an zwei Stellen – einmal für „erst
 * zeichnen“, einmal für „danach überspringen“. Eine neue Art an nur einer der
 * beiden nachzutragen ergibt einen Strich, der gerechnet UND gemalt wird: Der
 * Klonstempel hätte dann seinen eigenen Ausschnitt mit der Strichfarbe
 * übermalt. Deshalb steht die Frage jetzt einmal da, und hier steht ihre
 * Antwort.
 */
import { describe, expect, it } from 'vitest';
import { istBildstrich } from './zeichnen.js';
import type { Malstrich } from './doc.js';

function strich(art?: Malstrich['art']): Malstrich {
  return { farbe: '#ff0000', breite: 20, punkte: [0, 0, 10, 10], ...(art ? { art } : {}) };
}

describe('istBildstrich', () => {
  it('erkennt die drei Arten, die aus dem Quellbild lesen', () => {
    expect(istBildstrich(strich('pixel'))).toBe(true);
    expect(istBildstrich(strich('weich'))).toBe(true);
    expect(istBildstrich(strich('klon'))).toBe(true);
  });

  it('lässt den Farbstrich in Ruhe – auch ohne Angabe', () => {
    expect(istBildstrich(strich('farbe'))).toBe(false);
    expect(istBildstrich(strich())).toBe(false);
  });
});
