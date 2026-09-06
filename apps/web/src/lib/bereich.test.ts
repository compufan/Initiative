import { describe, expect, it } from 'vitest';
import { bereichLesen } from './bereich.js';

describe('bereichLesen', () => {
  it('versteht einen geschlossenen Bereich', () => {
    expect(bereichLesen('bytes=0-99', 1000)).toEqual({ start: 0, ende: 99 });
  });

  it('versteht ein offenes Ende', () => {
    expect(bereichLesen('bytes=500-', 1000)).toEqual({ start: 500, ende: 999 });
  });

  it('versteht das Suffix – die letzten N Byte', () => {
    expect(bereichLesen('bytes=-200', 1000)).toEqual({ start: 800, ende: 999 });
  });

  it('klemmt ein Suffix, das länger ist als die Datei, auf den Anfang', () => {
    expect(bereichLesen('bytes=-5000', 1000)).toEqual({ start: 0, ende: 999 });
  });

  it('klemmt ein Ende hinter dem Dateiende', () => {
    expect(bereichLesen('bytes=900-9999', 1000)).toEqual({ start: 900, ende: 999 });
  });

  it('nimmt das letzte Byte noch an', () => {
    expect(bereichLesen('bytes=999-', 1000)).toEqual({ start: 999, ende: 999 });
  });

  it('lehnt einen Anfang hinter dem Dateiende ab', () => {
    expect(bereichLesen('bytes=1000-', 1000)).toBeNull();
    expect(bereichLesen('bytes=5000-6000', 1000)).toBeNull();
  });

  it('lehnt ein Ende vor dem Anfang ab', () => {
    expect(bereichLesen('bytes=500-100', 1000)).toBeNull();
  });

  it('lehnt Mehrfachbereiche ab, statt den ersten zu raten', () => {
    // Sie bräuchten eine mehrteilige Antwort. Ein geratener erster Ausschnitt
    // wäre schlimmer als die ganze Datei.
    expect(bereichLesen('bytes=0-99,200-299', 1000)).toBeNull();
  });

  it('lehnt ab, was es nicht versteht', () => {
    expect(bereichLesen(null, 1000)).toBeNull();
    expect(bereichLesen('', 1000)).toBeNull();
    expect(bereichLesen('items=0-99', 1000)).toBeNull();
    expect(bereichLesen('bytes=abc-def', 1000)).toBeNull();
    expect(bereichLesen('bytes=0', 1000)).toBeNull();
    expect(bereichLesen('bytes=-0', 1000)).toBeNull();
  });

  it('lehnt ab, wenn die Gesamtgrösse unbekannt ist', () => {
    // Ohne Grösse liesse sich weder klemmen noch `Content-Range` bilden.
    expect(bereichLesen('bytes=0-99', 0)).toBeNull();
  });

  it('verträgt Grossschreibung und Leerzeichen', () => {
    expect(bereichLesen('Bytes= 10 - 20 ', 1000)).toEqual({ start: 10, ende: 20 });
  });
});
