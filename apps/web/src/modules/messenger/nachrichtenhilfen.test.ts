import { describe, expect, it } from 'vitest';
import { emojiLaden, emojiSuchen, normalisieren } from './emoji.js';
import { umschliessen } from './formathilfe.js';
import { RUHE, SCHWELLE_PX, wischSchritt, type WischZustand } from './wischen.js';
import { typingLabel } from './helpers.js';

describe('Emoji-Suche', () => {
  it('findet deutsch und englisch, mit und ohne Umlaut', async () => {
    const { emoji, kategorien } = await emojiLaden();
    expect(emoji.length).toBeGreaterThan(500);
    expect(kategorien.length).toBeGreaterThan(5);
    const treffer = (suche: string) => emojiSuchen(emoji, suche).map((e) => e.emoji);
    expect(treffer('herz')).toContain('❤️');
    expect(treffer('heart')).toContain('❤️');
    expect(treffer('bär')).toContain('🐻');
    expect(treffer('baer')).toContain('🐻');
    expect(treffer('daumen hoch')[0]).toBe('👍');
    expect(treffer('xyzzy')).toEqual([]);
    expect(normalisieren('Größe')).toBe('groesse');
  });
});

describe('Formatierungshilfe', () => {
  it('schliesst ein und wieder aus, Leerraum bleibt draussen', () => {
    expect(umschliessen('ein Wort hier', 4, 9, 'fett')).toEqual({ text: 'ein *Wort* hier', von: 5, bis: 9 });
    expect(umschliessen('ein *Wort* hier', 5, 9, 'fett')).toEqual({ text: 'ein Wort hier', von: 4, bis: 8 });
    expect(umschliessen('geheim', 0, 6, 'spoiler').text).toBe('||geheim||');
    expect(umschliessen('  ', 0, 2, 'kursiv').text).toBe('  ');
  });
});

describe('Wischen zum Antworten', () => {
  it('waagerecht nach rechts über die Schwelle: Antwort', () => {
    let z: WischZustand = { ...RUHE, start: { x: 0, y: 0 } };
    z = wischSchritt(z, 20, 2);
    expect(z.wischt).toBe(true);
    z = wischSchritt(z, SCHWELLE_PX + 30, 4);
    expect(z.ueberSchwelle).toBe(true);
    expect(z.versatz).toBeLessThanOrEqual(80);
  });

  it('senkrecht ist Scrollen, nach links nichts', () => {
    expect(wischSchritt({ ...RUHE, start: { x: 0, y: 0 } }, 5, 40).wischt).toBe(false);
    expect(wischSchritt({ ...RUHE, start: { x: 0, y: 0 } }, -40, 0).wischt).toBe(false);
    // Unter der Entscheidungsschwelle: noch offen.
    expect(wischSchritt({ ...RUHE, start: { x: 0, y: 0 } }, 3, 0).wischt).toBe(null);
  });
});

describe('Tipp-Anzeige', () => {
  it('Sprachnachricht hat Vorrang', () => {
    expect(typingLabel(['Anna'])).toBe('Anna tippt …');
    expect(typingLabel(['Anna', 'Bodo'], ['Bodo'])).toBe('Bodo nimmt Sprachnachricht auf …');
  });
});
