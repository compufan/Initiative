import { describe, expect, it } from 'vitest';
import { castAnzeige, type CastLage } from './castAnzeige.js';
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
