import { describe, expect, it } from 'vitest';

import { stilleGrenzen } from './stille.js';

const RATE = 24_000;

/**
 * Ein Signal aus Abschnitten bauen.
 *
 * `pegel` ist die Amplitude: sehr klein heisst Grundrauschen, gross heisst
 * jemand spricht. Gerauscht wird mit einem eigenen, wiederholbaren Zufall –
 * `Math.random` würde die Prüfung manchmal bestehen lassen und manchmal nicht,
 * und ein Test, der würfelt, ist kein Test.
 */
function signal(abschnitte: { sekunden: number; pegel: number; ton?: boolean }[]): Float32Array {
  let saat = 42;
  const wuerfel = () => {
    // Ein linearer Kongruenzgenerator – klein, wiederholbar, gut genug.
    saat = (saat * 1103515245 + 12345) & 0x7fffffff;
    return saat / 0x7fffffff;
  };
  const gesamt = abschnitte.reduce((summe, a) => summe + Math.round(a.sekunden * RATE), 0);
  const aus = new Float32Array(gesamt);
  let at = 0;
  for (const abschnitt of abschnitte) {
    const laenge = Math.round(abschnitt.sekunden * RATE);
    for (let i = 0; i < laenge; i += 1) {
      aus[at + i] = abschnitt.ton
        ? Math.sin((2 * Math.PI * 440 * i) / RATE) * abschnitt.pegel
        : (wuerfel() * 2 - 1) * abschnitt.pegel;
    }
    at += laenge;
  }
  return aus;
}

describe('stilleGrenzen', () => {
  it('findet Anfang und Ende eines Signals zwischen Rauschen', () => {
    /*
     * Ein halbe Sekunde Grundrauschen, eine Sekunde Sprache, acht Zehntel
     * Grundrauschen. Erwartet wird der Anfang bei 0,5 s minus Vorlauf und das
     * Ende bei 1,5 s plus Nachlauf.
     */
    const werte = signal([
      { sekunden: 0.5, pegel: 0.0005 },
      { sekunden: 1.0, pegel: 0.3, ton: true },
      { sekunden: 0.8, pegel: 0.0005 },
    ]);
    const grenzen = stilleGrenzen(werte, RATE);
    expect(grenzen.gefunden).toBe(true);
    // Vorlauf 80 ms – mit etwas Spielraum für die Fensterlage.
    expect(grenzen.beginn).toBeGreaterThan(0.38);
    expect(grenzen.beginn).toBeLessThan(0.46);
    // Nachlauf 120 ms.
    expect(grenzen.ende).toBeGreaterThan(1.58);
    expect(grenzen.ende).toBeLessThan(1.68);
  });

  it('lässt einen Vorlauf stehen, damit ein „P" nicht abreisst', () => {
    // Ein Laut wie „P" beginnt mit einer Stille, in der sich Druck aufbaut.
    // Genau am Energieanstieg zu schneiden klingt, als hätte es jemand
    // angestossen.
    const werte = signal([
      { sekunden: 0.6, pegel: 0.0005 },
      { sekunden: 0.6, pegel: 0.3, ton: true },
    ]);
    const grenzen = stilleGrenzen(werte, RATE);
    expect(grenzen.gefunden).toBe(true);
    expect(grenzen.beginn).toBeLessThan(0.6);
    expect(0.6 - grenzen.beginn).toBeGreaterThan(0.05);
  });

  it('schneidet nichts, wenn die Aufnahme durchgehend leise ist', () => {
    /*
     * Der gefährliche Fall. Wer hier „alles ist unter der Schwelle, also weg
     * damit" rechnet, löscht eine leise Aufnahme vollständig – und der
     * Anwender sieht nur, dass sein Ton verschwunden ist.
     */
    const werte = signal([{ sekunden: 2, pegel: 0.0004 }]);
    const grenzen = stilleGrenzen(werte, RATE);
    expect(grenzen.gefunden).toBe(false);
    expect(grenzen.beginn).toBe(0);
    expect(grenzen.ende).toBeCloseTo(2, 1);
  });

  it('schneidet nichts, wenn von Anfang bis Ende gesprochen wird', () => {
    // Ein Knopf, der scheinbar nichts tut, wird für kaputt gehalten. Besser
    // ausdrücklich „nichts gefunden" melden.
    const werte = signal([{ sekunden: 1.5, pegel: 0.3, ton: true }]);
    expect(stilleGrenzen(werte, RATE).gefunden).toBe(false);
  });

  it('schneidet nichts, wenn zu wenig übrig bliebe', () => {
    // Ein Huster von einem Zehntel zwischen zwei Sekunden Stille: Was hier
    // herauskäme, wäre kürzer als die Mindestlänge – also lieber nichts.
    const werte = signal([
      { sekunden: 1.0, pegel: 0.0005 },
      { sekunden: 0.04, pegel: 0.4 },
      { sekunden: 1.0, pegel: 0.0005 },
    ]);
    const grenzen = stilleGrenzen(werte, RATE);
    // Entweder nichts gefunden, oder das Ergebnis ist mindestens 250 ms lang.
    if (grenzen.gefunden) expect(grenzen.ende - grenzen.beginn).toBeGreaterThanOrEqual(0.25);
  });

  it('lässt sich von einem einzelnen Knacken nicht umwerfen', () => {
    /*
     * Genau dafür stehen Perzentile statt Minimum und Maximum in der
     * Rechnung. Ein einzelner Wert auf Vollausschlag mitten in der Stille
     * würde als „laut" das 95.-Perzentil kaum bewegen – als Maximum hätte er
     * die Schwelle in die Höhe gezogen, und die echte Sprache wäre darunter
     * verschwunden.
     */
    const werte = signal([
      { sekunden: 0.5, pegel: 0.0005 },
      { sekunden: 1.0, pegel: 0.3, ton: true },
      { sekunden: 0.5, pegel: 0.0005 },
    ]);
    werte[Math.round(0.2 * RATE)] = 1;
    const grenzen = stilleGrenzen(werte, RATE);
    expect(grenzen.gefunden).toBe(true);
    // Die Sprache muss noch vollständig enthalten sein.
    expect(grenzen.ende).toBeGreaterThan(1.5);
  });

  it('kommt mit einem Signal zurecht, das kürzer ist als ein Fenster', () => {
    expect(stilleGrenzen(new Float32Array(10), RATE).gefunden).toBe(false);
    expect(stilleGrenzen(new Float32Array(0), RATE).gefunden).toBe(false);
  });
});
