import { describe, expect, it } from 'vitest';
import {
  anzahlText,
  erinnernBody,
  erinnernPruefen,
  erinnernText,
  erinnerungsZeile,
  fristKurz,
  fristText,
  wirkungsHinweis,
} from './erinnern.js';

describe('Fristen und Sätze', () => {
  it('sagt Tage im Dativ, Wochen und krumme Stunden', () => {
    expect(fristText(24)).toBe('1 Tag');
    expect(fristText(48)).toBe('2 Tagen');
    expect(fristText(168)).toBe('1 Woche');
    expect(fristText(336)).toBe('2 Wochen');
    expect(fristText(36)).toBe('36 Stunden');
    expect(fristText(720)).toBe('30 Tagen');
    expect(fristKurz(48)).toBe('2 Tage');
    expect(fristKurz(24)).toBe('1 Tag');
  });
  it('sagt, wie oft', () => {
    expect(anzahlText(1)).toBe('einmal');
    expect(anzahlText(3)).toBe('bis zu 3-mal');
    expect(anzahlText(null)).toBe('bis zum Termin (höchstens 10-mal)');
    expect(erinnernText({ nachStunden: 48, anzahl: 3 })).toBe('nach 2 Tagen, bis zu 3-mal');
  });
});

describe('Prüfung', () => {
  it('kennt dieselben Grenzen wie der Server', () => {
    expect(erinnernPruefen(12, 1)).toBeNull();
    expect(erinnernPruefen(720, null)).toBeNull();
    expect(erinnernPruefen(11, 1)).toMatch(/Mindestens 12/);
    expect(erinnernPruefen(721, 1)).toMatch(/Höchstens 720/);
    expect(erinnernPruefen(24, 0)).toMatch(/Mindestens eine/);
    expect(erinnernPruefen(24, 11)).toMatch(/Höchstens 10/);
    expect(erinnernPruefen(24.5, 3)).toMatch(/ganze Zahl/);
    expect(erinnernPruefen(NaN, 3)).toMatch(/ganze Zahl/);
  });
});

describe('Was gesendet wird', () => {
  const zwei = { nachStunden: 48, anzahl: 3 };
  it('legt nur an, wenn eingeschaltet', () => {
    expect(erinnernBody(null, zwei, true)).toEqual({ erinnern: zwei });
    expect(erinnernBody(null, null, true)).toEqual({});
  });
  it('sendet beim Bearbeiten nur einen Unterschied', () => {
    expect(erinnernBody(zwei, { ...zwei }, false)).toEqual({});
    expect(erinnernBody(null, null, false)).toEqual({});
    expect(erinnernBody(zwei, { nachStunden: 24, anzahl: 3 }, false)).toEqual({
      erinnern: { nachStunden: 24, anzahl: 3 },
    });
    expect(erinnernBody(zwei, { nachStunden: 48, anzahl: null }, false)).toEqual({
      erinnern: { nachStunden: 48, anzahl: null },
    });
    expect(erinnernBody(zwei, null, false)).toEqual({ erinnern: null });
    expect(erinnernBody(null, zwei, false)).toEqual({ erinnern: zwei });
  });
});

describe('Wirkungshinweis', () => {
  const ab = new Date('2030-03-01T10:00:00Z');
  const basis = { ab, ganztaegig: false, wiederholt: false };
  it('zählt, was bis zum Beginn passt', () => {
    expect(
      wirkungsHinweis({
        ...basis,
        erinnern: { nachStunden: 24, anzahl: 3 },
        beginn: new Date('2030-03-11T10:00:00Z'),
      }),
    ).toEqual(['Bis zum Beginn passen 3 Erinnerungen.']);
    expect(
      wirkungsHinweis({
        ...basis,
        erinnern: { nachStunden: 24, anzahl: 1 },
        beginn: new Date('2030-03-11T10:00:00Z'),
      }),
    ).toEqual(['Bis zum Beginn passt 1 Erinnerung.']);
  });
  it('warnt, wenn keine passt', () => {
    expect(
      wirkungsHinweis({
        ...basis,
        erinnern: { nachStunden: 24, anzahl: 3 },
        beginn: new Date('2030-03-02T06:00:00Z'),
      }),
    ).toEqual(['Der Termin beginnt vor der ersten Erinnerung – es wird keine gesendet.']);
  });
  it('erklärt Serien und Ganztägiges', () => {
    const zeilen = wirkungsHinweis({
      ...basis,
      erinnern: { nachStunden: 24, anzahl: 3 },
      beginn: new Date('2030-03-11T10:00:00Z'),
      wiederholt: true,
      ganztaegig: true,
    });
    expect(zeilen).toHaveLength(3);
    expect(zeilen[1]).toMatch(/erste Termin der Serie/);
    expect(zeilen[2]).toMatch(/Ganztägig/);
  });
  it('rechnet ohne gültigen Beginn nicht', () => {
    expect(
      wirkungsHinweis({ ...basis, erinnern: { nachStunden: 24, anzahl: 3 }, beginn: null }),
    ).toEqual([]);
  });
});

describe('Kopfzeile der Karte', () => {
  const basis = { partner: 'Ben', titel: 'Grillen', nummer: 1 };
  it('sagt dem Empfänger, solange er offen ist, was fehlt', () => {
    expect(erinnerungsZeile({ ...basis, ichBinErsteller: false, status: 'pending' })).toEqual({
      kopf: 'Automatische Erinnerung',
      text: 'Du hast noch nicht auf „Grillen“ geantwortet.',
    });
  });
  it('sagt nach der Antwort die Antwort – nicht mehr „nicht geantwortet“', () => {
    expect(
      erinnerungsZeile({ ...basis, ichBinErsteller: false, status: 'yes', nummer: 2 }),
    ).toEqual({
      kopf: 'Automatische Erinnerung · 2.',
      text: 'Deine Antwort: Zugesagt.',
    });
    expect(erinnerungsZeile({ ...basis, ichBinErsteller: false, status: 'maybe' }).text).toBe(
      'Deine Antwort: Vielleicht.',
    );
  });
  it('sagt dem Ersteller, an wen sie ging', () => {
    expect(erinnerungsZeile({ ...basis, ichBinErsteller: true, status: null, nummer: 3 })).toEqual({
      kopf: 'Automatische Erinnerung an Ben · 3.',
      text: null,
    });
  });
  it('kennt auch einen unbekannten Stand', () => {
    expect(erinnerungsZeile({ ...basis, ichBinErsteller: false, status: null }).text).toMatch(
      /noch nicht/,
    );
  });
});
