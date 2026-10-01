import { describe, expect, it } from 'vitest';
import { ortHinweis } from './ortHinweis.js';

describe('Hinweis unter dem Ort-Feld', () => {
  it.each<[string | null | undefined, string, boolean]>([
    [
      '',
      'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.',
      false,
    ],
    [
      '   ',
      'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.',
      false,
    ],
    [
      null,
      'Mit Straße, Hausnummer und Ort lässt sich der Ort später in einer Karten-App öffnen.',
      false,
    ],
    [
      'Hauptstr. 5, 12345 Berlin',
      'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
      true,
    ],
    [
      'Vereinsheim, Hauptstr. 5, 12345 Berlin',
      'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
      true,
    ],
    [
      'Hauptstr. 5',
      'Adresse erkannt: Wer eingeladen ist, kann sie in seiner Karten-App öffnen.',
      true,
    ],
    [
      'An der Alster 12',
      'Sieht nach einer Adresse aus. Mit Postleitzahl und Ort findet die Karte sie genauer.',
      false,
    ],
    [
      '12345 Berlin',
      'Nur Postleitzahl und Ort erkannt. Mit Straße und Hausnummer landet die Karte genau am Ziel.',
      false,
    ],
    [
      '48.13743, 11.57549',
      'Koordinaten erkannt: Wer eingeladen ist, kann die Stelle in seiner Karten-App öffnen.',
      true,
    ],
    ['https://zoom.us/j/123', 'Link erkannt: Wer eingeladen ist, kann ihn antippen.', true],
    ['Zoom: https://zoom.us/j/123', 'Link erkannt: Wer eingeladen ist, kann ihn antippen.', true],
    [
      'Stadtpark, Eingang Nord',
      'Keine Adresse erkannt. Wer eingeladen ist, kann den Ort trotzdem auf der Karte suchen.',
      false,
    ],
  ])('%j', (ort, text, gut) => {
    expect(ortHinweis(ort)).toEqual({ text, gut });
  });

  it.each(['Zoom', 'Online', 'bei mir', 'zu Hause', 'Raum 2.14', '😀'])(
    'sagt zu %j nichts',
    (ort) => {
      expect(ortHinweis(ort)).toBeNull();
    },
  );

  it('nimmt bei Adresse und Link nebeneinander die Adresse', () => {
    expect(ortHinweis('Hauptstr. 5, 12345 Berlin, https://example.org/anfahrt')?.text).toMatch(
      /^Adresse erkannt/,
    );
  });
});
