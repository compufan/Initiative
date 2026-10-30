import { describe, expect, it } from 'vitest';
import { sucheLohnt } from './ortSuche.js';

describe('sucheLohnt', () => {
  it('sucht erst ab drei Zeichen', () => {
    expect(sucheLohnt('')).toBe(false);
    expect(sucheLohnt('Wi')).toBe(false);
    expect(sucheLohnt(' Wi ')).toBe(false);
    expect(sucheLohnt('Wil')).toBe(true);
  });

  it('sucht in jeder Reihenfolge der Angaben', () => {
    expect(sucheLohnt('Willy-Brandt-Platz 1, 64293 Darmstadt')).toBe(true);
    expect(sucheLohnt('64293 Darmstadt Willy')).toBe(true);
    expect(sucheLohnt('64293')).toBe(true);
  });

  it('schickt Webadressen und Koordinaten nicht an den Suchdienst', () => {
    expect(sucheLohnt('https://zoom.us/j/123456789')).toBe(false);
    expect(sucheLohnt('www.example.org/treffen')).toBe(false);
    expect(sucheLohnt('49.8763, 8.6503')).toBe(false);
    expect(sucheLohnt('49,8763 8,6503')).toBe(false);
  });
});
