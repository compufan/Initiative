import { describe, expect, it } from 'vitest';
import { castAnzeige, castWeiter, type CastAnzeige, type CastLage } from './castAnzeige.js';
import type { CastGrund, CastZustand } from './cast.js';

const ZUSTAENDE: CastZustand[] = [
  'aus',
  'fehlgeschlagen',
  'keine-geraete',
  'bereit',
  'verbindet',
  'verbunden',
];
const GRUENDE: CastGrund[] = ['geht', 'kein-sicherer-kontext', 'browser-kann-nicht'];
const STILE: CastLage['stil'][] = ['rund', 'leiste'];

describe('castAnzeige', () => {
  /**
   * Die eine Regel, um die es geht.
   *
   * Ein Anwender hat gemeldet: „Ich muss einer Datenschutzvereinbarung
   * zustimmen. Danach passiert gar nichts. Der Fernseher-Button ist danach
   * auch weg." Der Grund war eine Bedingung in `CastKnopf`, die bei zwei von
   * sechs Zuständen `null` zurückgab – und einer dieser beiden ist der
   * Normalfall unmittelbar nach der Zustimmung, der andere der Normalfall an
   * jedem Schreibtisch ohne Chromecast.
   *
   * Deshalb wird hier nicht geprüft, was bei einem bestimmten Zustand
   * herauskommt, sondern dass es bei KEINEM nichts ist. Ein Browsertest kann
   * das nicht: Er sieht nur den Zustand, den der Testläufer gerade herstellt.
   */
  it('zeigt nach der Zustimmung in jedem Zustand etwas', () => {
    for (const zustand of ZUSTAENDE) {
      for (const stil of STILE) {
        const anzeige = castAnzeige({ grund: 'geht', erlaubt: true, zustand, stil });
        expect(anzeige, `zustand=${zustand} stil=${stil}`).not.toBe('nichts');
      }
    }
  });

  it('zeigt auch dem, der zugestimmt hat, den Grund, wenn es hier nicht geht', () => {
    for (const grund of GRUENDE.filter((g) => g !== 'geht')) {
      for (const stil of STILE) {
        expect(castAnzeige({ grund, erlaubt: true, zustand: 'aus', stil })).toBe('geht-hier-nicht');
      }
    }
  });

  /*
   * Und die Gegenrichtung: Vor der Zustimmung darf und soll es still bleiben,
   * wo kein Platz ist. Sonst stünde an jedem Foto in Safari ein Satz über
   * einen Dienst, den niemand eingeschaltet hat.
   */
  it('bleibt vor der Zustimmung still, wo der Browser ohnehin nicht kann', () => {
    expect(
      castAnzeige({ grund: 'browser-kann-nicht', erlaubt: false, zustand: 'aus', stil: 'rund' }),
    ).toBe('nichts');
    expect(
      castAnzeige({
        grund: 'kein-sicherer-kontext',
        erlaubt: false,
        zustand: 'aus',
        stil: 'leiste',
      }),
    ).toBe('geht-hier-nicht');
  });

  it('zeigt vor der Zustimmung den Schalter, nicht den Cast-Knopf', () => {
    for (const zustand of ZUSTAENDE) {
      for (const stil of STILE) {
        expect(castAnzeige({ grund: 'geht', erlaubt: false, zustand, stil })).toBe('schalter');
      }
    }
  });

  it('unterscheidet „lädt noch" von „kam nicht"', () => {
    const lage = { grund: 'geht', erlaubt: true, stil: 'leiste' } as const;
    expect(castAnzeige({ ...lage, zustand: 'aus' })).toBe('laedt');
    expect(castAnzeige({ ...lage, zustand: 'fehlgeschlagen' })).toBe('fehlgeschlagen');
  });

  it('zeigt den echten Knopf, sobald ein Gerät da ist', () => {
    for (const zustand of ['bereit', 'verbindet', 'verbunden'] as CastZustand[]) {
      expect(castAnzeige({ grund: 'geht', erlaubt: true, zustand, stil: 'rund' })).toBe('knopf');
    }
  });
});

describe('castWeiter', () => {
  const ALLE: CastAnzeige[] = [
    'nichts',
    'schalter',
    'geht-hier-nicht',
    'laedt',
    'fehlgeschlagen',
    'kein-geraet',
    'knopf',
  ];

  it('führt in die Erklärung, wo es etwas zu erklären gibt', () => {
    /*
     * Die beiden Zustände, in denen ein Anwender wissen will, warum sein
     * Fernseher nicht auftaucht. `kein-geraet` ist der gemeldete Fall – dort
     * führte der Weg früher unmittelbar in den Code, an der Erklärung vorbei.
     */
    expect(castWeiter('fehlgeschlagen', false)).toBe('diagnose');
    expect(castWeiter('kein-geraet', false)).toBe('diagnose');
  });

  it('schickt niemanden am Grund vorbei in den Code-Weg', () => {
    /*
     * Die eigentliche Zusicherung, und sie gilt über ALLE Zustände: Der
     * Code-Weg ist die Rückfallebene und steht am Ende der Erklärung, nicht an
     * ihrer Stelle. Wer ihn von hier aus unmittelbar anbietet, nimmt dem
     * Anwender die Antwort auf die Frage, die er gerade gestellt hat.
     *
     * `CastDiagnose` endet mit dem Knopf dorthin – verloren geht nichts.
     */
    for (const anzeige of ALLE) {
      for (const sucht of [false, true]) {
        expect(castWeiter(anzeige, sucht)).not.toBe('code');
      }
    }
  });

  it('lässt die Auskunft still, solange gesucht wird', () => {
    // Wer nach drei Sekunden auf „Suche Fernseher …" tippt, will nicht ein
    // Blatt über Umwege lesen – er will, dass die Suche fertig wird.
    expect(castWeiter('kein-geraet', true)).toBe('nichts');
  });

  it('führt nirgendwohin, wo es nichts zu erklären gibt', () => {
    for (const anzeige of ['nichts', 'schalter', 'geht-hier-nicht', 'laedt', 'knopf'] as const) {
      expect(castWeiter(anzeige, false)).toBe('nichts');
    }
  });
});
