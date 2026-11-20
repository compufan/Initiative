import { describe, expect, it } from 'vitest';
import faelle from './testdaten/formatierung.json';
import {
  formatierungParsen,
  hatFormatierung,
  ohneFormatierung,
  type FormatKnoten,
} from './util/formatierung.js';
import { messagePreview } from './util/format.js';

describe('Formatierung', () => {
  // Dieselben Fälle prüft der Server (`services/messages/formatierung.rs`).
  it.each(faelle as { text: string; ohne: string }[])('ohne Marken: $text', ({ text, ohne }) => {
    expect(ohneFormatierung(text)).toBe(ohne);
  });

  it('baut einen Baum statt HTML', () => {
    expect(formatierungParsen('a *b _c_* `d`')).toEqual<FormatKnoten[]>([
      { art: 'text', text: 'a ' },
      {
        art: 'fett',
        kinder: [
          { art: 'text', text: 'b ' },
          { art: 'kursiv', kinder: [{ art: 'text', text: 'c' }] },
        ],
      },
      { art: 'text', text: ' ' },
      { art: 'mono', text: 'd' },
    ]);
  });

  it('HTML im Text bleibt Text', () => {
    const knoten = formatierungParsen('*<img src=x onerror=alert(1)>*');
    expect(knoten).toEqual([
      { art: 'fett', kinder: [{ art: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  it('Spoiler verrät in der Vorschau nichts', () => {
    expect(messagePreview({ type: 'text', body: 'Der Mörder ist ||der Gärtner||' })).toBe(
      'Der Mörder ist ▒▒▒',
    );
    expect(messagePreview({ type: 'text', body: '*Treffen* um _8_' })).toBe('Treffen um 8');
  });

  it('erkennt, ob es überhaupt etwas zu tun gibt', () => {
    expect(hatFormatierung('ganz normal')).toBe(false);
    expect(hatFormatierung('*x*')).toBe(true);
  });

  /*
   * ReDoS und Laufzeit: Der Parser darf bei bösartiger Eingabe nicht
   * quadratisch werden. 60 000 Zeichen aus lauter offenen Marken müssen in
   * Bruchteilen einer Sekunde durch sein.
   */
  it('bleibt bei bösartigen Eingaben schnell', () => {
    const boese = [
      '*_~`|'.repeat(12_000),
      '*a '.repeat(20_000),
      '||'.repeat(30_000),
      '_'.repeat(60_000),
      '```'.repeat(20_000),
      `${'*x'.repeat(30_000)}*`,
    ];
    for (const text of boese) {
      const anfang = performance.now();
      formatierungParsen(text);
      ohneFormatierung(text);
      expect(performance.now() - anfang).toBeLessThan(500);
    }
  });

  /*
   * Zufallseingaben aus dem Alphabet der Marken: Der Parser wirft nie, und
   * der Klartext enthält nie mehr Zeichen als das Original (Marken fallen
   * weg, nichts kommt hinzu – ausser dem Spoiler-Ersatz).
   */
  it('übersteht Zufallseingaben', () => {
    const alphabet = ['*', '_', '~', '`', '|', ' ', 'a', 'b', '\n', '.', '(', ')', '😀'];
    let saat = 42;
    const zufall = () => {
      saat = (saat * 1_103_515_245 + 12_345) % 2 ** 31;
      return saat / 2 ** 31;
    };
    for (let runde = 0; runde < 2000; runde += 1) {
      const laenge = Math.floor(zufall() * 60);
      let text = '';
      for (let i = 0; i < laenge; i += 1) text += alphabet[Math.floor(zufall() * alphabet.length)];
      const klar = ohneFormatierung(text);
      if (!text.includes('||')) expect(klar.length).toBeLessThanOrEqual(text.length);
      // Ohne Marken ist der Text unverändert.
      if (!hatFormatierung(text)) expect(klar).toBe(text);
    }
  });
});
