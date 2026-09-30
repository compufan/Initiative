import { describe, expect, it } from 'vitest';
import {
  KARTEN_ERNEUERN_MS,
  imKreis,
  kartenAlt,
  listeNeuHolen,
  tasteDeuten,
  type ProgrammKopf,
} from './ablauf.js';

const KOPF: ProgrammKopf = { saat: 4711, modus: 'linear', stueckzahl: 5 };
const JETZT = 1_000_000_000;

describe('listeNeuHolen', () => {
  /*
   * Der Fall, an dem „Pause startet das Video von vorn" hing: Die Fernbedienung
   * hat nur die Pause umgeschaltet. Die Liste ist dieselbe – holte das Blatt
   * sie trotzdem, bekäme das laufende Video eine neue Adresse und finge bei
   * null an.
   */
  it('holt NICHT neu, wenn nur Stelle oder Pause sich bewegt haben', () => {
    const stand = { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 5 };
    expect(listeNeuHolen(stand, KOPF, JETZT - 1000, JETZT)).toBe(false);
  });

  it('holt neu, wenn eingestellt oder gemischt wurde', () => {
    // Jedes Einstellen würfelt eine neue Saat – auch mit denselben Stücken.
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 1, modus: 'linear', stueckzahl: 5 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 4711, modus: 'zufall', stueckzahl: 5 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 6 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
  });

  it('holt neu, wenn ein Chat an die Stelle der Diashow tritt', () => {
    expect(listeNeuHolen({ art: 'chat', saat: 4711 }, KOPF, JETZT, JETZT)).toBe(true);
  });

  it('holt wie früher neu, wenn der Server noch keine Saat meldet', () => {
    expect(
      listeNeuHolen({ art: 'diashow', modus: 'linear', stueckzahl: 5 }, KOPF, JETZT, JETZT),
    ).toBe(true);
  });

  it('holt ohne laufendes Programm immer', () => {
    expect(listeNeuHolen({ saat: 1 }, null, JETZT, JETZT)).toBe(true);
  });

  /*
   * Eine Karte gilt sechs Stunden. Eine Diashow, die niemand anfasst, lief
   * danach in lauter 401 – das Blatt holte nie neu, weil sich nie etwas
   * änderte.
   */
  it('holt vor dem Ablauf der Karten neu, auch wenn sich nichts geändert hat', () => {
    const stand = { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 5 };
    expect(kartenAlt(JETZT - KARTEN_ERNEUERN_MS + 1, JETZT)).toBe(false);
    expect(kartenAlt(JETZT - KARTEN_ERNEUERN_MS, JETZT)).toBe(true);
    expect(listeNeuHolen(stand, KOPF, JETZT - KARTEN_ERNEUERN_MS, JETZT)).toBe(true);
    // Und mit einer Stunde Luft vor den sechs Stunden der Karte.
    expect(KARTEN_ERNEUERN_MS).toBeLessThanOrEqual(5 * 60 * 60 * 1000);
  });
});

describe('imKreis', () => {
  it('läuft vorwärts über das Ende und rückwärts über den Anfang', () => {
    expect(imKreis(5, 5)).toBe(0);
    expect(imKreis(-1, 5)).toBe(4);
    expect(imKreis(12, 5)).toBe(2);
    expect(imKreis(3, 0)).toBe(0);
  });
});

describe('tasteDeuten', () => {
  it('versteht die Namen neuerer Browser', () => {
    expect(tasteDeuten('ArrowRight', 39)).toBe('weiter');
    expect(tasteDeuten('ArrowLeft', 37)).toBe('zurueck');
    expect(tasteDeuten('Enter', 13)).toBe('ok');
    expect(tasteDeuten(' ', 32)).toBe('ok');
    expect(tasteDeuten('MediaPlayPause', 179)).toBe('ok');
  });

  /*
   * Ältere Fernseher melden bei manchen Tasten nur „Unidentified". Dann
   * zählt der alte Zahlencode – sonst tut die OK-Taste nichts, und der Ton
   * bleibt für immer aus.
   */
  it('fällt auf den Zahlencode zurück, wo der Name fehlt', () => {
    expect(tasteDeuten('Unidentified', 13)).toBe('ok');
    expect(tasteDeuten(undefined, 39)).toBe('weiter');
    expect(tasteDeuten('Unidentified', 10252)).toBe('ok');
    expect(tasteDeuten('Unidentified', 10232)).toBe('zurueck');
  });

  it('lässt fremde Tasten in Ruhe', () => {
    expect(tasteDeuten('a', 65)).toBeNull();
    expect(tasteDeuten('Escape', 27)).toBeNull();
  });
});
