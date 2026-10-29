import { describe, expect, it } from 'vitest';

import {
  LANGSAM_FOLGE,
  NOT_FENSTER,
  NOT_TAKTE,
  TAKT_MS,
  WISCH_GRENZE_MS,
  filmBildIndex,
  gueteBeimWischen,
  gueteErholt,
  leinwandVeraltet,
  notstufeNoetig,
  videobildDarf,
} from './wischweg.js';

/**
 * Die Entscheidungen des Zeichenwegs beim Wischen: welches Filmbild unter
 * dem Finger liegt, wann ein Bild aus dem Video noch gezeichnet werden darf,
 * wann die Leinwand wegmuss und wann das Gerät zu langsam ist.
 */

describe('filmBildIndex', () => {
  it('teilt die Stelle im Film durch den Bildabstand', () => {
    expect(filmBildIndex(300, 0, 40)).toBe(0);
    expect(filmBildIndex(300, 39.9, 40)).toBe(0);
    expect(filmBildIndex(300, 40, 40)).toBe(1);
    expect(filmBildIndex(300, 4000, 40)).toBe(100);
  });

  it('rechnet gegen Gleitkommareste: 3 · (1000/24) ist das vierte Bild', () => {
    const s = 1000 / 24;
    expect(filmBildIndex(100, 3 * s, s)).toBe(3);
    expect(filmBildIndex(100, 3 * s - 1e-9, s)).toBe(3);
  });

  it('bleibt im Film: hinter dem Ende das letzte Bild, vor dem Anfang das erste', () => {
    expect(filmBildIndex(300, 12_000, 40)).toBe(299);
    expect(filmBildIndex(300, 99_999, 40)).toBe(299);
    expect(filmBildIndex(300, -50, 40)).toBe(0);
    expect(filmBildIndex(0, 100, 40)).toBe(0);
  });
});

describe('videobildDarf', () => {
  it('lässt ein Videobild zu, das dem Finger näher oder gleich nah liegt als das gezeigte', () => {
    expect(videobildDarf(100, 100, 90, 8)).toBe(true);
    expect(videobildDarf(95, 100, 90, 8)).toBe(true);
    expect(videobildDarf(110, 100, 90, 8)).toBe(true);
    expect(videobildDarf(90, 100, 110, 8)).toBe(true);
  });

  it('verwirft ein Videobild, das weiter vom Finger weg liegt als das gezeigte', () => {
    expect(videobildDarf(50, 100, 98, 8)).toBe(false);
    expect(videobildDarf(120, 100, 101, 8)).toBe(false);
  });

  it('gilt ohne Ziel oder ohne zuordenbares Bild nicht', () => {
    expect(videobildDarf(50, null, 98, 8)).toBe(true);
    expect(videobildDarf(null, 100, 98, 8)).toBe(true);
    expect(videobildDarf(null, 100, null, 8)).toBe(true);
  });

  it('lässt, solange nichts gezeigt wird, nur ein Bild nahe am Finger zu', () => {
    // Das Video hält noch das Bild von vor dem Zug – das darf nicht mit der Bearbeitung des neuen erscheinen.
    expect(videobildDarf(10, 100, null, 8)).toBe(false);
    expect(videobildDarf(95, 100, null, 8)).toBe(true);
  });
});

describe('leinwandVeraltet', () => {
  it('meldet ein Bild, das weiter als die Toleranz vom Finger liegt', () => {
    expect(leinwandVeraltet(10, 100, 8)).toBe(true);
    expect(leinwandVeraltet(91, 100, 8)).toBe(true);
  });

  it('lässt ein Bild innerhalb der Toleranz stehen', () => {
    expect(leinwandVeraltet(92, 100, 8)).toBe(false);
    expect(leinwandVeraltet(108, 100, 8)).toBe(false);
    expect(leinwandVeraltet(100, 100, 8)).toBe(false);
  });

  it('meldet ein unbekanntes Bild während eines Zugs, aber nichts ohne Zug', () => {
    expect(leinwandVeraltet(null, 100, 8)).toBe(true);
    expect(leinwandVeraltet(null, null, 8)).toBe(false);
    expect(leinwandVeraltet(5, null, 8)).toBe(false);
  });
});

describe('gueteBeimWischen', () => {
  it('senkt die Güte bei einer einzigen Zeichnung über der Grenze – wie bisher', () => {
    expect(gueteBeimWischen([20, 30, WISCH_GRENZE_MS + 1], 0)).toBe(1);
    expect(gueteBeimWischen([20, 30, WISCH_GRENZE_MS], 0)).toBe(0);
  });

  it('senkt sie, wenn sechs Zeichnungen in Folge über drei Takten liegen', () => {
    const langsam = 3 * TAKT_MS + 1;
    expect(gueteBeimWischen(Array(LANGSAM_FOLGE).fill(langsam), 0)).toBe(1);
    expect(gueteBeimWischen(Array(LANGSAM_FOLGE - 1).fill(langsam), 0)).toBe(0);
    // Eine schnelle dazwischen unterbricht die Folge.
    const gemischt = [langsam, langsam, langsam, 10, langsam, langsam, langsam];
    expect(gueteBeimWischen(gemischt, 0)).toBe(0);
  });

  it('lässt die Güte unverändert, wo sie schon gesenkt ist, und ohne Zeichnungen', () => {
    expect(gueteBeimWischen([500], 1)).toBe(1);
    expect(gueteBeimWischen([500], 2)).toBe(2);
    expect(gueteBeimWischen([], 0)).toBe(0);
  });
});

describe('notstufeNoetig', () => {
  it('verlangt erst acht Zeichnungen', () => {
    expect(notstufeNoetig(Array(NOT_FENSTER - 1).fill(1000))).toBe(false);
  });

  it('greift, wenn der Median der letzten acht über zwölf Takten liegt', () => {
    const grenze = NOT_TAKTE * TAKT_MS;
    expect(notstufeNoetig(Array(NOT_FENSTER).fill(grenze + 1))).toBe(true);
    expect(notstufeNoetig(Array(NOT_FENSTER).fill(grenze - 1))).toBe(false);
  });

  it('lässt sich von einem einzelnen Ausreisser nicht auslösen', () => {
    expect(notstufeNoetig([30, 30, 30, 30, 30, 30, 30, 900])).toBe(false);
  });

  it('zählt nur die letzten acht – die ersten, langsamen Zeichnungen verblassen', () => {
    const verlauf = [900, 900, 900, 900, ...Array(NOT_FENSTER).fill(30)];
    expect(notstufeNoetig(verlauf)).toBe(false);
  });
});

describe('gueteErholt', () => {
  it('verlangt acht Zeichnungen und neun von zehn unter anderthalb Takten', () => {
    expect(gueteErholt(Array(NOT_FENSTER - 1).fill(5))).toBe(false);
    expect(gueteErholt(Array(NOT_FENSTER).fill(5))).toBe(true);
    expect(gueteErholt(Array(NOT_FENSTER).fill(2 * TAKT_MS))).toBe(false);
  });

  it('verzeiht eine einzelne langsame Zeichnung unter zehn', () => {
    expect(gueteErholt([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 400])).toBe(true);
    expect(gueteErholt([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 400, 400, 400])).toBe(false);
  });
});
