import { describe, expect, it } from 'vitest';
import {
  abgelaufen,
  alleErwaehnt,
  bearbeitenMoeglich,
  bearbeitenRestMinuten,
  erwaehnungEinfuegen,
  erwaehnungenImText,
  erwaehnungenZerlegen,
  erwaehnungsAnfrage,
  erwaehnungsVorschlaege,
  fuerAlleLoeschenMoeglich,
  liveLaeuft,
  selbstloeschenText,
} from './index.js';

const anna = { userId: 'a', name: 'Anna Müller', username: 'anna' };
const ben = { userId: 'b', name: 'Ben', username: 'benni' };
const aenne = { userId: 'c', name: 'Änne', username: 'aenne' };

describe('Erwähnungen', () => {
  it('erkennt ein „@“ an der Schreibmarke, aber keine E-Mail-Adresse', () => {
    expect(erwaehnungsAnfrage('Hallo @An', 9)).toEqual({ start: 6, suche: 'An' });
    expect(erwaehnungsAnfrage('@', 1)).toEqual({ start: 0, suche: '' });
    expect(erwaehnungsAnfrage('mail@an', 7)).toBeNull();
    expect(erwaehnungsAnfrage('@Anna Mü', 8)).toBeNull();
    expect(erwaehnungsAnfrage('kein at', 7)).toBeNull();
  });

  it('schlägt nach Anzeige- und Benutzername vor, ohne mich, Wortanfang zuerst', () => {
    const alle = [anna, ben, aenne];
    expect(erwaehnungsVorschlaege(alle, 'be', 'x').map((p) => p.userId)).toEqual(['b']);
    expect(erwaehnungsVorschlaege(alle, 'mü', 'x').map((p) => p.userId)).toEqual(['a']);
    expect(erwaehnungsVorschlaege(alle, 'an', 'x').map((p) => p.userId)).toEqual(['a', 'c']);
    expect(erwaehnungsVorschlaege(alle, '', 'a').map((p) => p.userId)).toEqual(['c', 'b']); // Ä wie A
    expect(erwaehnungsVorschlaege(alle, '', 'x', 1)).toHaveLength(1);
  });

  it('fügt den Namen ein und setzt die Marke dahinter', () => {
    const text = 'Hey @An wie gehts';
    const anfrage = erwaehnungsAnfrage(text, 7)!;
    const neu = erwaehnungEinfuegen(text, anfrage, 'Anna Müller');
    expect(neu.text).toBe('Hey @Anna Müller wie gehts');
    expect(neu.marke).toBe('Hey @Anna Müller '.length);
  });

  it('zählt nur Erwähnungen, die noch im Text stehen', () => {
    expect(erwaehnungenImText('@Anna Müller und @Ben', [anna, ben, anna])).toEqual(['a', 'b']);
    expect(erwaehnungenImText('@Anna Müller', [anna, ben])).toEqual(['a']);
    expect(erwaehnungenImText('@Benjamin', [ben])).toEqual([]);
    expect(erwaehnungenImText('mail@Ben', [ben])).toEqual([]);
    expect(alleErwaehnt('Achtung @alle!')).toBe(true);
    expect(alleErwaehnt('@allesamt')).toBe(false);
  });

  it('zerlegt für die Darstellung, längste Namen zuerst', () => {
    const stuecke = erwaehnungenZerlegen('Hi @Anna Müller, @Ben und @alle', [ben, anna], true);
    expect(stuecke).toEqual([
      { art: 'text', text: 'Hi ' },
      { art: 'erwaehnung', text: '@Anna Müller', userId: 'a' },
      { art: 'text', text: ', ' },
      { art: 'erwaehnung', text: '@Ben', userId: 'b' },
      { art: 'text', text: ' und ' },
      { art: 'erwaehnung', text: '@alle', userId: 'alle' },
    ]);
    expect(erwaehnungenZerlegen('@Fremd', [ben])).toEqual([{ art: 'text', text: '@Fremd' }]);
  });
});

describe('Zeitfenster', () => {
  const jetzt = Date.parse('2026-01-01T12:00:00Z');
  it('Bearbeiten 15 Minuten', () => {
    expect(bearbeitenMoeglich('2026-01-01T11:46:00Z', jetzt)).toBe(true);
    expect(bearbeitenMoeglich('2026-01-01T11:44:00Z', jetzt)).toBe(false);
    expect(bearbeitenRestMinuten('2026-01-01T11:50:00Z', jetzt)).toBe(5);
    expect(bearbeitenRestMinuten('2026-01-01T10:00:00Z', jetzt)).toBe(0);
  });
  it('Für alle löschen 48 Stunden, Moderation ohne Frist', () => {
    expect(fuerAlleLoeschenMoeglich('2025-12-30T13:00:00Z', false, jetzt)).toBe(true);
    expect(fuerAlleLoeschenMoeglich('2025-12-30T11:00:00Z', false, jetzt)).toBe(false);
    expect(fuerAlleLoeschenMoeglich('2025-01-01T00:00:00Z', true, jetzt)).toBe(true);
  });
  it('Ablauf und Stufen', () => {
    expect(abgelaufen('2026-01-01T11:59:59Z', jetzt)).toBe(true);
    expect(abgelaufen('2026-01-01T12:00:01Z', jetzt)).toBe(false);
    expect(abgelaufen(null, jetzt)).toBe(false);
    expect(selbstloeschenText(86_400)).toBe('24 Stunden');
    expect(selbstloeschenText(604_800)).toBe('7 Tage');
    expect(selbstloeschenText(null)).toBe('Aus');
  });
  it('Live-Standort endet zur Zeit oder beim Beenden', () => {
    expect(liveLaeuft({ bis: '2026-01-01T12:10:00Z' }, jetzt)).toBe(true);
    expect(liveLaeuft({ bis: '2026-01-01T11:59:00Z' }, jetzt)).toBe(false);
    expect(liveLaeuft({ bis: '2026-01-01T12:10:00Z', beendet: '2026-01-01T11:59:00Z' }, jetzt)).toBe(
      false,
    );
  });
});
