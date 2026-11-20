import { describe, expect, it } from 'vitest';
import {
  ABBRECHEN_PX,
  MINDEST_MS,
  SPERREN_PX,
  abbruchFortschritt,
  beimLoslassen,
  haltenLage,
} from './haltenGeste.js';

describe('Gedrückthalten zum Aufnehmen', () => {
  it('bleibt bei kleinen Bewegungen in der Aufnahme', () => {
    expect(haltenLage(0, 0)).toBe('aufnahme');
    expect(haltenLage(-40, -30)).toBe('aufnahme');
  });

  it('bricht nach links ab und sperrt nach oben', () => {
    expect(haltenLage(-ABBRECHEN_PX, 0)).toBe('abbrechen');
    expect(haltenLage(0, -SPERREN_PX)).toBe('sperren');
    // Schräg: Was überwiegt, entscheidet – Abbrechen geht vor.
    expect(haltenLage(-ABBRECHEN_PX - 5, -SPERREN_PX - 5)).toBe('abbrechen');
    expect(haltenLage(-20, -SPERREN_PX - 10)).toBe('sperren');
  });

  it('zeigt den Fortschritt des Abbrechens', () => {
    expect(abbruchFortschritt(0)).toBe(0);
    expect(abbruchFortschritt(-ABBRECHEN_PX / 2)).toBe(0.5);
    expect(abbruchFortschritt(-500)).toBe(1);
    expect(abbruchFortschritt(50)).toBe(0);
  });

  it('ein kurzer Tipp sendet nichts, gesperrt läuft weiter', () => {
    expect(beimLoslassen(MINDEST_MS - 1, false)).toBe('verwerfen');
    expect(beimLoslassen(MINDEST_MS, false)).toBe('senden');
    expect(beimLoslassen(100, true)).toBe('weiter');
  });
});
