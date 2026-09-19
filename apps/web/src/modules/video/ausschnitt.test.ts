import { describe, expect, it } from 'vitest';

import {
  BILDRATEN,
  dauerJeBildMs,
  groesseSchaetzenB,
  groesseText,
  zeitpunkte,
} from './ausschnitt.js';

describe('Die angebotenen Bildraten', () => {
  it('gehen alle in Hundertsteln auf', () => {
    /*
     * Der Grund, warum es überhaupt eine Liste gibt und kein Zahlenfeld. Geht
     * eine Rate nicht auf, läuft das GIF messbar schneller oder langsamer als
     * das Video – und niemand käme auf die Idee, das an der Bildrate
     * festzumachen.
     */
    for (const { rate } of BILDRATEN) {
      const hundertstel = 100 / rate;
      expect(hundertstel, `${rate}/s`).toBe(Math.round(hundertstel));
    }
  });

  it('bleibt bei mindestens zwei Hundertsteln Standzeit', () => {
    // `gifSchreiben` hebt alles darunter auf zwei an. Eine Rate, die das
    // reisst, liefe im GIF langsamer als angeschrieben.
    for (const { rate } of BILDRATEN) {
      expect(dauerJeBildMs(rate), `${rate}/s`).toBeGreaterThanOrEqual(20);
    }
  });

  it('gibt jeder Rate einen Titel und einen Satz', () => {
    for (const rate of BILDRATEN) {
      expect(rate.titel.length, String(rate.rate)).toBeGreaterThan(1);
      expect(rate.beschreibung.length, String(rate.rate)).toBeGreaterThan(8);
    }
  });
});

describe('dauerJeBildMs', () => {
  it('rechnet die üblichen Raten genau um', () => {
    expect(dauerJeBildMs(5)).toBe(200);
    expect(dauerJeBildMs(10)).toBe(100);
    expect(dauerJeBildMs(12.5)).toBe(80);
    expect(dauerJeBildMs(20)).toBe(50);
    expect(dauerJeBildMs(25)).toBe(40);
  });

  it('liefert immer ein Vielfaches von zehn', () => {
    // Alles andere verliert GIF beim Schreiben, ohne sich zu beschweren.
    for (const rate of [3, 7, 9, 11, 24, 30, 60]) {
      expect(dauerJeBildMs(rate) % 10, `${rate}/s`).toBe(0);
    }
  });
});

describe('zeitpunkte', () => {
  it('legt die Bilder im Abstand der Standzeit ab', () => {
    const { zeitpunkte: liste, dauerJeBildMs: schritt } = zeitpunkte(0, 500, 10, 100);
    expect(schritt).toBe(100);
    expect(liste).toEqual([0, 100, 200, 300, 400]);
  });

  it('fängt beim gewählten Anfang an und nicht bei null', () => {
    // Der Anfang ist eine Stelle im Video, keine Verschiebung – wer bei 2,4 s
    // beginnt, will das Bild von 2,4 s.
    expect(zeitpunkte(2400, 2700, 10, 100).zeitpunkte).toEqual([2400, 2500, 2600]);
  });

  it('schneidet hinten ab, statt auszudünnen', () => {
    /*
     * Ausdünnen wäre die naheliegende Rettung und die falsche: Jedes zweite
     * Bild bei voller Standzeit ergibt Zeitlupe, bei halber Standzeit den
     * schnellen Vorlauf. Ein kürzerer Ausschnitt ist ehrlich – und er steht
     * mit `gekuerztMs` auch da.
     */
    const kurz = zeitpunkte(0, 5000, 10, 12);
    expect(kurz.zeitpunkte).toHaveLength(12);
    expect(kurz.zeitpunkte[11]).toBe(1100);
    expect(kurz.gekuerztMs).toBe(3800);
  });

  it('meldet keine Kürzung, wenn alles hineinpasst', () => {
    expect(zeitpunkte(0, 1000, 10, 50).gekuerztMs).toBe(0);
  });

  it('gibt auch für einen Punkt ohne Länge ein Bild zurück', () => {
    // Wer die beiden Griffe übereinanderschiebt, bekommt ein Standbild und
    // keine Fehlermeldung – ein GIF ohne Teilbilder wirft in `gifSchreiben`.
    expect(zeitpunkte(1200, 1200, 10, 50).zeitpunkte).toEqual([1200]);
  });

  it('nimmt einen verdrehten Bereich hin, statt rückwärts zu laufen', () => {
    const verdreht = zeitpunkte(900, 300, 10, 50);
    expect(verdreht.zeitpunkte).toEqual([900]);
  });

  it('rundet die Zahl der Bilder, statt den Rest wegzuwerfen', () => {
    // 950 ms bei zehn Bildern je Sekunde sind zehn Bilder, nicht neun.
    expect(zeitpunkte(0, 950, 10, 50).zeitpunkte).toHaveLength(10);
  });
});

describe('groesseSchaetzenB', () => {
  it('trifft die Messung, aus der die Zahlen stammen', () => {
    /*
     * Fünfzig Bilder à 512 × 512 durch `gifSchreiben`: 6 505 995 Byte als
     * Vollbild, 916 000 freigestellt. Die Schätzung darf davon ein paar
     * Prozent abweichen, aber nicht ein Vielfaches – sonst steht auf dem Knopf
     * „rund 2 MB" und heraus kommen sechs.
     */
    expect(groesseSchaetzenB(50, 512, false)).toBeCloseTo(6_506_000, -5);
    expect(groesseSchaetzenB(50, 512, true)).toBeCloseTo(916_000, -4);
  });

  it('wächst mit der FLÄCHE und nicht mit der Kante', () => {
    // Die halbe Kante ist ein Viertel der Bildpunkte. Wer linear schätzt,
    // verspricht bei 256 die Hälfte und liefert ein Viertel.
    const gross = groesseSchaetzenB(20, 512, false);
    const klein = groesseSchaetzenB(20, 256, false);
    expect(klein).toBeCloseTo(gross / 4, -3);
  });

  it('macht freigestellt deutlich leichter als Vollbild', () => {
    // Der Grund, warum Freistellen überhaupt unter die 4-MB-Grenze für
    // Sticker führt: Die durchsichtige Fläche ist EIN Tafelplatz, und eine
    // lange Reihe desselben Platzes packt LZW fast umsonst.
    expect(groesseSchaetzenB(50, 512, true) * 5).toBeLessThan(groesseSchaetzenB(50, 512, false));
  });
});

describe('groesseText', () => {
  it('wechselt bei knapp unter einem Megabyte die Einheit', () => {
    expect(groesseText(400_000)).toBe('rund 400 kB');
    expect(groesseText(1_400_000)).toBe('rund 1,4 MB');
  });

  it('schreibt das Komma deutsch', () => {
    // Ein Punkt liest sich hier als Tausendertrenner – „rund 1.4 MB" sieht
    // aus wie 1400.
    expect(groesseText(2_500_000)).not.toContain('.');
  });

  it('sagt nie „rund 0 kB"', () => {
    expect(groesseText(120)).toBe('rund 1 kB');
  });
});
