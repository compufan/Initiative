import { describe, expect, it } from 'vitest';
import {
  pressenFilterSchema,
  pressenLaeufeAbfrageSchema,
  pressenLaeufeSeiteSchema,
  pressenStatistikSchema,
} from './pressen-statistik.js';

const ID = '0192f3a0-0000-7000-8000-000000000001';
const ZEIT = '2026-05-03T09:00:00.123456Z';

describe('Pressen-Statistik: Schemas', () => {
  it('liest die Antwort der Statistik, wie der Server sie baut', () => {
    const antwort = {
      kopf: {
        laeufe: 2,
        siege: 1,
        niederlagen: 1,
        atempo: 0,
        nichtGewertet: 0,
        siegquote: 0.5,
        getruemmert: 0,
        vorzeitig: 0,
        durchschnittZeitMs: 13000,
        durchschnittWertungMs: 13100,
        durchschnittVerschuettetDezi: 5,
        gesamtGetrunkenDezi: 5990,
        gesamtVerschuettetDezi: 10,
        trefferquote: 0.998,
        gesamtDauerMs: 26000,
        laengsteSiegesserie: 1,
        aktuelleSiegesserie: 0,
      },
      rekorde: {
        besteZeit: { wert: 12000, laufId: ID, gespieltAm: ZEIT },
        besteWertung: null,
        saubersterLauf: null,
        schnellsteReaktion: null,
        laengsteSiegesserie: null,
      },
      nachModus: [],
      nachGegner: [
        {
          userId: ID,
          name: null,
          runden: 2,
          siege: 1,
          niederlagen: 1,
          atempo: 0,
          durchschnittVorsprungMs: -12.5,
          letzteRunde: ZEIT,
        },
      ],
      nachMalus: [],
      verlauf: [],
      verlaufGekuerzt: false,
    };
    expect(pressenStatistikSchema.parse(antwort).kopf.siegquote).toBe(0.5);
    // Ein unbekannter Ausgang ist ein Fehler, kein stilles Durchwinken.
    const kaputt = structuredClone(antwort);
    (kaputt.nachGegner[0] as { userId: string }).userId = 'keine-kennung';
    expect(() => pressenStatistikSchema.parse(kaputt)).toThrow();
  });

  it('liest eine Seite der Laufliste mit und ohne Cursor', () => {
    expect(pressenLaeufeSeiteSchema.parse({ items: [], nextCursor: null }).items).toEqual([]);
    expect(() => pressenLaeufeSeiteSchema.parse({ items: [{}], nextCursor: null })).toThrow();
  });

  it('prüft Filter und Abfrage streng', () => {
    expect(pressenFilterSchema.parse({ modus: 'duell', von: '2026-01-01T00:00:00Z' }).modus).toBe(
      'duell',
    );
    expect(() => pressenFilterSchema.parse({ modus: 'quatsch' })).toThrow();
    expect(pressenLaeufeAbfrageSchema.parse({ limit: '25', sortierung: 'zeit' }).limit).toBe(25);
    expect(() => pressenLaeufeAbfrageSchema.parse({ limit: 500 })).toThrow();
  });
});
