import { describe, expect, it } from 'vitest';
import { pressen, type PressenAnsicht, type PressenErgebnis } from '@initiative/shared';
import { aufzaehlung, ergebnisAnsage, ergebnisAnzeige } from './pressenErgebnis.js';

const NAMEN = ['Du', 'Anna', 'Bodo', 'Cleo', 'Dora'];
const nameVon = (sitz: number) => NAMEN[sitz] ?? `Spieler ${sitz + 1}`;

function lauf(dauerMs: number, verschuettetDezi = 0): PressenErgebnis {
  return {
    dauerMs,
    verschuettetDezi,
    reaktionMs: 300,
    vorzeitig: false,
    verzoegerungMs: 0,
    versatzMs: 0,
    wertungMs:
      dauerMs + Math.floor((1000 * verschuettetDezi + 2 * verschuettetDezi ** 2 + 50) / 100),
    getruemmert: false,
  };
}

function stand(n: number, aenderung: Partial<PressenAnsicht> = {}): PressenAnsicht {
  const sitze = Array.from({ length: n }, (_, seat) => ({ seat, userId: `u${seat}` }));
  return { ...(pressen.createInitialState(sitze) as PressenAnsicht), ...aenderung };
}

describe('ergebnisAnzeige', () => {
  it('sagt mitten in der Runde nichts', () => {
    expect(ergebnisAnzeige(stand(2), 0, nameVon)).toBeNull();
    const halb = stand(2, { ergebnisse: [lauf(9000), { verborgen: true }] });
    expect(ergebnisAnzeige(halb, 0, nameVon)).toBeNull();
  });

  it('Duell: „Du hast gewonnen“ mit Zeit, verschüttet und Score je Spieler', () => {
    const s = stand(2, {
      fertig: true,
      sieger: [0],
      ergebnisse: [lauf(9000, 20), lauf(9500, 40)],
    });
    const a = ergebnisAnzeige(s, 0, nameVon)!;
    expect(a.art).toBe('sieg');
    expect(a.titel).toBe('Du hast gewonnen');
    expect(a.listenTitel).toBe('Endwertung');
    expect(a.zeilen).toHaveLength(2);
    expect(a.zeilen[0]).toMatchObject({
      name: 'Du',
      ich: true,
      sieger: true,
      dauerMs: 9000,
      verschuettetDezi: 20,
    });
    expect(a.zeilen[0]!.wertungMs).toBeGreaterThan(9000);
    expect(a.zeilen[1]).toMatchObject({ name: 'Anna', ich: false, sieger: false });
  });

  it('Duell: wer unterliegt, wurde abgeschluckt', () => {
    const s = stand(2, { fertig: true, sieger: [1], ergebnisse: [lauf(12000), lauf(9000)] });
    const a = ergebnisAnzeige(s, 0, nameVon)!;
    expect(a.art).toBe('niederlage');
    expect(a.titel).toBe('Du wurdest abgeschluckt');
    expect(a.zeilen.find((z) => z.ich)?.sieger).toBe(false);
  });

  it('ohne Sitz neutral: „Anna hat gewonnen“', () => {
    const s = stand(2, { fertig: true, sieger: [1], ergebnisse: [lauf(12000), lauf(9000)] });
    const a = ergebnisAnzeige(s, null, nameVon)!;
    expect(a.art).toBe('neutral');
    expect(a.titel).toBe('Anna hat gewonnen');
    expect(a.zeilen.every((z) => !z.ich)).toBe(true);
  });

  it('Atempo: nach unentschiedener Runde, aus der Vorrunde, mit dem Abstand', () => {
    const s = stand(2, {
      runde: 2,
      atempo: 1,
      letzterAbstandMs: 120,
      vorrunde: [lauf(9000), lauf(9120)],
    });
    const a = ergebnisAnzeige(s, 1, nameVon)!;
    expect(a.art).toBe('atempo');
    expect(a.titel).toBe('Atempo');
    expect(a.untertitel).toContain('120 ms');
    expect(a.untertitel).toContain('Runde 2');
    expect(a.listenTitel).toBe('Runde 1');
    expect(a.zeilen).toHaveLength(2);
  });

  it('Atempo gilt nur, bis die neue Runde ein erstes Ergebnis hat', () => {
    const s = stand(2, {
      runde: 2,
      atempo: 1,
      letzterAbstandMs: 120,
      vorrunde: [lauf(9000), lauf(9120)],
      ergebnisse: [lauf(8000), null],
    });
    expect(ergebnisAnzeige(s, 0, nameVon)).toBeNull();
  });

  it('Spiegel: immer Atempo, mit eigenem Satz', () => {
    const s = stand(1, { runde: 3, atempo: 2, letzterAbstandMs: 0, vorrunde: [lauf(9000, 10)] });
    const a = ergebnisAnzeige(s, 0, nameVon)!;
    expect(a.art).toBe('atempo');
    expect(a.untertitel).toContain('Spiegel');
  });

  it('Fremde Zeiten bleiben verborgen, solange sie verborgen sind', () => {
    const s = stand(2, {
      fertig: true,
      sieger: [0],
      ergebnisse: [lauf(9000), { verborgen: true }],
    });
    const a = ergebnisAnzeige(s, 0, nameVon)!;
    expect(a.zeilen.map((z) => z.name)).toEqual(['Du']);
  });

  it('Staffette: Team-Ergebnis, Team-Sieg und -Niederlage', () => {
    const ergebnisse = [lauf(9000), lauf(11000), lauf(9100), lauf(11200)];
    const s = stand(4, {
      fertig: true,
      sieger: [0, 2],
      teamWertung: [18100, 22200],
      ergebnisse,
    });
    const sieg = ergebnisAnzeige(s, 2, nameVon)!;
    expect(sieg.art).toBe('sieg');
    expect(sieg.untertitel).toBe('Team A 18,1 s : Team B 22,2 s');
    expect(sieg.zeilen.map((z) => z.rolle)).toEqual(['Team A', 'Team B', 'Team A', 'Team B']);
    expect(ergebnisAnzeige(s, 1, nameVon)!.art).toBe('niederlage');
    expect(ergebnisAnzeige(s, null, nameVon)!.titel).toBe('Team A hat gewonnen');
  });

  it('Ampel: wer sie macht, wird nicht gewertet und liest neutral, wer gewann', () => {
    const s = stand(3, {
      fertig: true,
      sieger: [1],
      ergebnisse: [lauf(9000), lauf(8000), lauf(10000)],
    });
    expect(s.ampel).toBe(2);
    const ampel = ergebnisAnzeige(s, 2, nameVon)!;
    expect(ampel.art).toBe('neutral');
    expect(ampel.titel).toBe('Anna hat gewonnen');
    expect(ampel.zeilen.find((z) => z.sitz === 2)).toMatchObject({
      nichtGewertet: true,
      rolle: 'Ampel',
    });
    expect(ergebnisAnzeige(s, 0, nameVon)!.art).toBe('niederlage');
  });
});

describe('Aufzählung und Ansage', () => {
  it('zählt Namen auf', () => {
    expect(aufzaehlung([])).toBe('');
    expect(aufzaehlung(['Anna'])).toBe('Anna');
    expect(aufzaehlung(['Anna', 'Bodo'])).toBe('Anna und Bodo');
    expect(aufzaehlung(['Anna', 'Bodo', 'Cleo'])).toBe('Anna, Bodo und Cleo');
  });

  it('spricht Ergebnis und eigene Zahlen', () => {
    const s = stand(2, { fertig: true, sieger: [0], ergebnisse: [lauf(9000, 20), lauf(9500)] });
    const text = ergebnisAnsage(ergebnisAnzeige(s, 0, nameVon)!);
    expect(text).toContain('Du hast gewonnen.');
    expect(text).toContain('9,0 s');
    expect(text).toContain('2,0 Milliliter');
  });
});
