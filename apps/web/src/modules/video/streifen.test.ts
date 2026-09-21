import { describe, expect, it } from 'vitest';

import { luecken } from './Streifen.js';

describe('luecken', () => {
  it('dunkelt vorn und hinten ab, wenn ein Stück in der Mitte liegt', () => {
    expect(luecken([{ vonMs: 200, bisMs: 800 }], 1000)).toEqual([
      { vonMs: 0, bisMs: 200 },
      { vonMs: 800, bisMs: 1000 },
    ]);
  });

  it('lässt die Lücke ZWISCHEN zwei Stücken stehen', () => {
    // Genau das ist der sichtbare Unterschied zum alten Streifen: Wer ein
    // Stück in der Mitte herausnimmt, muss sehen, dass dort nichts ist.
    expect(
      luecken(
        [
          { vonMs: 0, bisMs: 200 },
          { vonMs: 600, bisMs: 1000 },
        ],
        1000,
      ),
    ).toEqual([{ vonMs: 200, bisMs: 600 }]);
  });

  it('zieht überlappende Stücke zu einer Fläche zusammen', () => {
    /*
     * Zwei Stücke dürfen sich überlappen – denselben Ausschnitt zweimal zu
     * zeigen ist eine erlaubte Absicht. Ein Schatten mittendrin wäre dann
     * schlicht falsch.
     */
    expect(
      luecken(
        [
          { vonMs: 100, bisMs: 500 },
          { vonMs: 300, bisMs: 900 },
        ],
        1000,
      ),
    ).toEqual([
      { vonMs: 0, bisMs: 100 },
      { vonMs: 900, bisMs: 1000 },
    ]);
  });

  it('kommt mit Stücken in verkehrter Reihenfolge zurecht', () => {
    // Die Reihenfolge im FILM ist eine andere Frage als die Lage im Video.
    expect(
      luecken(
        [
          { vonMs: 600, bisMs: 1000 },
          { vonMs: 0, bisMs: 200 },
        ],
        1000,
      ),
    ).toEqual([{ vonMs: 200, bisMs: 600 }]);
  });

  it('dunkelt alles ab, wenn kein Stück Länge hat', () => {
    expect(luecken([{ vonMs: 400, bisMs: 400 }], 1000)).toEqual([{ vonMs: 0, bisMs: 1000 }]);
  });

  it('gibt nichts zurück, solange die Länge unbekannt ist', () => {
    expect(luecken([{ vonMs: 0, bisMs: 100 }], 0)).toEqual([]);
  });
});
