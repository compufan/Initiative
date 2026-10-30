import { describe, expect, it } from 'vitest';
import type { PressenVerlaufPunkt } from '@initiative/shared';
import {
  dauerLang,
  datum,
  gleitendesMittel,
  histogramm,
  liter,
  metrikWert,
  mitVorzeichen,
  nachTageszeit,
  nachWochentag,
  prozent,
  reihe,
  schoeneTicks,
  sekunden,
  skala,
  zahl,
  zeitraumVon,
} from './pressenStatistik.js';

function punkt(
  nr: number,
  dauerMs: number,
  verschuettetDezi = 0,
  extra: Partial<PressenVerlaufPunkt> = {},
): PressenVerlaufPunkt {
  return {
    id: `00000000-0000-4000-8000-${String(nr).padStart(12, '0')}`,
    gespieltAm: `2026-05-0${nr}T09:00:00.000Z`,
    modus: 'duell',
    ausgang: 'sieg',
    dauerMs,
    verschuettetDezi,
    wertungMs: dauerMs + verschuettetDezi * 10,
    vorzeitig: false,
    malusMs: 0,
    ...extra,
  };
}

describe('gleitendes Mittel', () => {
  it('mittelt die letzten Werte, am Anfang entsprechend weniger', () => {
    expect(gleitendesMittel([10, 20, 30, 40], 2)).toEqual([10, 15, 25, 35]);
    expect(gleitendesMittel([10, 20, 30, 40], 3)).toEqual([10, 15, 20, 30]);
  });
  it('lässt sich nicht von Fenstern unter 1 oder über der Länge irritieren', () => {
    expect(gleitendesMittel([4, 8], 0)).toEqual([4, 8]);
    expect(gleitendesMittel([4, 8], 99)).toEqual([4, 6]);
    expect(gleitendesMittel([], 5)).toEqual([]);
  });
});

describe('Reihe fürs Liniendiagramm', () => {
  const verlauf = [
    punkt(1, 15000, 0),
    punkt(2, 3000, 2900, { vorzeitig: true }),
    punkt(3, 12000, 100),
    punkt(4, 14000, 0),
  ];
  it('rechnet in Sekunden und Milliliter um', () => {
    expect(metrikWert(verlauf[0]!, 'zeit')).toBe(15);
    expect(metrikWert(verlauf[2]!, 'verschuettet')).toBe(10);
    expect(metrikWert(verlauf[2]!, 'wertung')).toBe(13);
  });
  it('lässt vorzeitig abgestellte Läufe weg und nummeriert, was bleibt', () => {
    const r = reihe(verlauf, 'zeit', 2);
    expect(r.map((p) => p.nr)).toEqual([1, 2, 3]);
    expect(r.map((p) => p.wert)).toEqual([15, 12, 14]);
    expect(r.map((p) => p.mittel)).toEqual([15, 13.5, 13]);
  });
  it('ist ohne Läufe leer', () => {
    expect(reihe([], 'wertung')).toEqual([]);
  });
});

describe('Histogramm', () => {
  it('zählt jeden Wert genau einmal und bleibt bei der Spanne', () => {
    const werte = [12.1, 12.9, 13.0, 14.5, 14.9, 18.2];
    const klassen = histogramm(werte, 8);
    expect(klassen.reduce((s, k) => s + k.anzahl, 0)).toBe(werte.length);
    expect(klassen[0]!.von).toBeLessThanOrEqual(12.1);
    expect(klassen[klassen.length - 1]!.bis).toBeGreaterThanOrEqual(18.2);
    expect(klassen.length).toBeGreaterThanOrEqual(2);
    expect(klassen.length).toBeLessThanOrEqual(12);
  });
  it('wählt runde Klassenbreiten und behält leere Klassen dazwischen', () => {
    const klassen = histogramm([10, 10.4, 20.2], 8);
    const breiten = new Set(klassen.map((k) => Math.round((k.bis - k.von) * 1000) / 1000));
    expect(breiten.size).toBe(1);
    expect([1, 2, 2.5, 5]).toContain([...breiten][0]);
    expect(klassen.some((k) => k.anzahl === 0)).toBe(true);
  });
  it('legt den größten Wert in die letzte Klasse und einen einzelnen Wert in eine', () => {
    const k = histogramm([15, 20], 4);
    expect(k[k.length - 1]!.anzahl).toBe(1);
    const einer = histogramm([13.2]);
    expect(einer).toHaveLength(1);
    expect(einer[0]!.anzahl).toBe(1);
    expect(histogramm([])).toEqual([]);
  });
});

describe('Tageszeit und Wochentag', () => {
  // Mittags in lokaler Zeit, damit die Zeitzone des Testrechners keine Rolle spielt.
  const lokal = (jahr: number, monat: number, tag: number, stunde: number) =>
    new Date(jahr, monat - 1, tag, stunde, 0, 0).toISOString();
  const verlauf = [
    punkt(1, 15000, 0, { gespieltAm: lokal(2026, 5, 4, 13) }), // Montag
    punkt(2, 17000, 0, { gespieltAm: lokal(2026, 5, 4, 22) }), // Montag
    punkt(3, 12000, 0, { gespieltAm: lokal(2026, 5, 10, 7) }), // Sonntag
    punkt(4, 1000, 0, { gespieltAm: lokal(2026, 5, 10, 8), vorzeitig: true }),
  ];
  it('ordnet die Woche mit Montag zuerst und mittelt nur Läufe im Ziel', () => {
    const w = nachWochentag(verlauf);
    expect(w.map((g) => g.text)[0]).toBe('Montag');
    expect(w[0]).toMatchObject({ laeufe: 2, wertungMs: 16000 });
    expect(w[6]).toMatchObject({ text: 'Sonntag', laeufe: 2, wertungMs: 12000 });
    expect(w[2]).toMatchObject({ laeufe: 0, wertungMs: null });
  });
  it('teilt den Tag in vier Blöcke', () => {
    const t = nachTageszeit(verlauf);
    expect(t.map((g) => g.laeufe)).toEqual([0, 2, 1, 1]);
    expect(t[3]!.wertungMs).toBe(17000);
    expect(t[0]!.wertungMs).toBeNull();
  });
});

describe('Achsen', () => {
  it('liefert schöne Werte innerhalb des Bereichs', () => {
    expect(schoeneTicks(12, 19, 4)).toEqual([12, 14, 16, 18]);
    expect(schoeneTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(schoeneTicks(5, 5)).toEqual([5]);
    expect(schoeneTicks(0.12, 0.31, 4).every((t) => t >= 0.12 && t <= 0.31)).toBe(true);
  });
  it('bildet linear ab und hält eine Spanne von null aus', () => {
    const y = skala(10, 20, 200, 0);
    expect(y(10)).toBe(200);
    expect(y(15)).toBe(100);
    expect(skala(5, 5, 0, 100)(5)).toBe(50);
  });
});

describe('Formate', () => {
  it('schreibt deutsch: Komma, Einheit, Vorzeichen', () => {
    expect(zahl(1234.5, 1)).toBe('1.234,5');
    expect(sekunden(13_450)).toBe('13,5 s');
    expect(prozent(0.6667)).toBe('67 %');
    expect(prozent(0.99855, 1)).toBe('99,9 %');
    expect(liter(25_000)).toBe('2,50 l');
    expect(liter(4_500)).toBe('450,0 ml');
    expect(mitVorzeichen(-8_550)).toBe('−8,6 s');
    expect(mitVorzeichen(1_000)).toBe('+1,0 s');
    expect(dauerLang(45_000)).toBe('45 s');
    expect(dauerLang(7_500_000)).toBe('2 h 5 min');
    expect(datum('2026-05-03T09:00:00Z')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });
  it('beginnt „7 Tage“ eine Woche zurück und „Alles“ ohne Grenze', () => {
    const jetzt = new Date('2026-05-10T12:00:00Z');
    expect(zeitraumVon('7', jetzt)).toBe('2026-05-03T12:00:00.000Z');
    expect(zeitraumVon('30', jetzt)).toBe('2026-04-10T12:00:00.000Z');
    expect(zeitraumVon('alles', jetzt)).toBeUndefined();
  });
});
