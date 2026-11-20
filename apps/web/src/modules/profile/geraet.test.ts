import { describe, expect, it } from 'vitest';
import { geraetName, geraetZeichen } from './geraet.js';

describe('geraetName', () => {
  it('erkennt die häufigen', () => {
    expect(
      geraetName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'),
    ).toBe('Firefox auf Linux');
    expect(
      geraetName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari auf iPhone');
    expect(
      geraetName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
      ),
    ).toBe('Edge auf Windows');
    expect(
      geraetName(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome auf Android');
  });
  it('Unbekanntes bleibt unbekannt', () => {
    expect(geraetName(null)).toBe('Unbekanntes Gerät');
    expect(geraetName('curl/8.0')).toBe('Unbekanntes Gerät');
  });
  it('Zeichen', () => {
    expect(geraetZeichen('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari')).toBe('📱');
    expect(geraetZeichen('Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0')).toBe('💻');
  });
});
