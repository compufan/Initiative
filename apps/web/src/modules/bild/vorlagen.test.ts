import { describe, expect, it } from 'vitest';

import { NEUTRAL, gewichteteLuminanz, luminanz, tonPunkt } from './ton.js';
import { VORLAGEN, vorlageAnwenden } from './vorlagen.js';

/*
 * Eine rote Rose und ein blauer Himmel – GLEICH HELL nach Rec.709.
 *
 * Das ist die Bedingung, ohne die der ganze Test nichts zeigt: Nur wenn beide
 * ohne Filter denselben Grauton ergeben, beweist ein Unterschied MIT Filter
 * etwas. Meine erste Wahl war (0,35 / 0,55 / 0,85) für den Himmel – der ist
 * nach Rec.709 bei 135 von 255 und die Rose bei 74, also von vornherein 61
 * Stufen auseinander. Der Test wäre grün gewesen, ohne dass der Filter etwas
 * getan hätte.
 *
 * Beide liegen jetzt auf 74 von 255.
 */
const ROSE: [number, number, number] = [0.8, 0.15, 0.2];
const HIMMEL: [number, number, number] = [0.25, 0.24, 0.9];

const nach255 = (wert: number) => Math.round(wert * 255);

describe('gewichteteLuminanz', () => {
  it('ist bei null exakt Rec.709', () => {
    for (const farbe of [ROSE, HIMMEL, [0.5, 0.5, 0.5] as const]) {
      expect(gewichteteLuminanz(farbe[0], farbe[1], farbe[2], 0, 0)).toBe(
        luminanz(farbe[0], farbe[1], farbe[2]),
      );
    }
  });

  it('hält ein Grau bei jedem Filter grau', () => {
    /*
     * Die Gewichte werden auf Summe 1 gebracht. Ohne das machte jeder Filter
     * das ganze Bild heller oder dunkler, und man drehte hinterher an der
     * Belichtung, um nichts zu gewinnen.
     */
    for (const [r, g] of [
      [1, -0.9],
      [-0.5, 0.5],
      [0.4, -0.35],
    ]) {
      expect(gewichteteLuminanz(0.5, 0.5, 0.5, r, g)).toBeCloseTo(0.5, 10);
    }
  });

  it('trennt, was Rec.709 nicht trennt', () => {
    /*
     * Der ganze Grund für dieses Feld. Ohne Filter landen Rose und Himmel auf
     * demselben Grauton – nachgerechnet 73 und 73 von 255. Ein Schwarz-Weiss,
     * in dem eine rote Rose und ein blauer Himmel gleich aussehen, ist kein
     * Schwarz-Weiss-Film, sondern eine Graustufenumrechnung.
     */
    const ohne = Math.abs(nach255(luminanz(...ROSE)) - nach255(luminanz(...HIMMEL)));
    expect(ohne).toBeLessThan(3);

    const mitRot = Math.abs(
      nach255(gewichteteLuminanz(...ROSE, 1, -0.9)) -
        nach255(gewichteteLuminanz(...HIMMEL, 1, -0.9)),
    );
    expect(mitRot, 'ein Rotfilter muss die beiden weit auseinanderziehen').toBeGreaterThan(60);
    // Und in der richtigen Richtung: Rot wird hell, Blau dunkel.
    expect(gewichteteLuminanz(...ROSE, 1, -0.9)).toBeGreaterThan(
      gewichteteLuminanz(...HIMMEL, 1, -0.9),
    );
  });

  it('dreht sich mit dem Grünfilter um', () => {
    // Ein Grünfilter hebt Laub und senkt Rot – die umgekehrte Reihenfolge.
    const laub: [number, number, number] = [0.24, 0.47, 0.2];
    expect(gewichteteLuminanz(...laub, -0.15, 0.5)).toBeGreaterThan(
      gewichteteLuminanz(...ROSE, -0.15, 0.5),
    );
    expect(gewichteteLuminanz(...laub, 1, -0.9)).toBeLessThan(gewichteteLuminanz(...ROSE, 1, -0.9));
  });

  it('lässt kein Gewicht unter null fallen', () => {
    // Sonst würde ein Kanal die Helligkeit ABZIEHEN, und ein sattes Blau
    // käme heller heraus als Schwarz.
    for (const [r, g] of [
      [3, 3],
      [-3, -3],
      [5, -5],
    ]) {
      const wert = gewichteteLuminanz(0.9, 0.1, 0.1, r, g);
      expect(wert).toBeGreaterThanOrEqual(0);
      expect(wert).toBeLessThanOrEqual(1);
    }
  });
});

describe('der Filter wirkt über den Sättigungsregler', () => {
  it('tut ohne Entsättigung nichts', () => {
    /*
     * Ein Farbfilter im Schwarz-Weiss verschiebt die HELLIGKEITEN beim
     * Entsättigen. Steht die Sättigung auf null, wird der Block gar nicht
     * betreten – ein gesetzter Filter darf dann kein farbiges Bild verändern.
     */
    const ohne = tonPunkt(ROSE, NEUTRAL);
    const mit = tonPunkt(ROSE, { ...NEUTRAL, swRot: 1, swGruen: -0.9 });
    expect(mit).toEqual(ohne);
  });

  it('wächst stetig mit der Entsättigung, ohne Sprung am Ende', () => {
    /*
     * Ein Entwurf sah vor, den Mischer NUR bei saettigung = −1 greifen zu
     * lassen. Nachgemessen wäre die Rose bei Stärke 0,99 noch bunt und bei
     * 1,00 plötzlich ein heller Grauton – ein Sprung von rund hundert Stufen
     * an der letzten Raste des Reglers. Über die Luminanzachse gibt es diesen
     * Sprung nicht.
     */
    const stufen = [0.9, 0.95, 0.99, 1].map((s) =>
      nach255(tonPunkt(ROSE, { ...NEUTRAL, saettigung: -s, swRot: 1, swGruen: -0.9 })[0]),
    );
    for (let i = 1; i < stufen.length; i += 1) {
      expect(Math.abs(stufen[i] - stufen[i - 1]), `Sprung bei Stufe ${i}`).toBeLessThan(12);
    }
  });
});

describe('VORLAGEN', () => {
  it('haben eindeutige Kennungen und vollständige Anpassungen', () => {
    const ids = VORLAGEN.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const vorlage of VORLAGEN) {
      expect(Object.keys(vorlage.anpassung).sort()).toEqual(Object.keys(NEUTRAL).sort());
    }
  });

  it('tragen keine Markennamen', () => {
    /*
     * § 23 Abs. 1 Nr. 3 MarkenG deckt das Verweisen auf fremde Ware ALS DIE
     * DES INHABERS. Ein Knopf, der „Velvia“ heisst, verweist nicht auf Fujis
     * Film – er benennt unser Erzeugnis. Dazu verlangt Absatz 2 „anständige
     * Gepflogenheiten“, und die enden, wo der Ruf der Marke der Grund für den
     * Namen ist. Dieser Test ist die Bremse gegen den nächsten, der es „nur
     * als Beschreibung“ hineinschreiben will.
     */
    const marken = [
      'velvia',
      'provia',
      'astia',
      'portra',
      'ektar',
      'tri-x',
      'trix',
      'kodachrome',
      'kodak',
      'fuji',
      'ilford',
      'agfa',
      'polaroid',
      'instax',
      'cinestill',
      'hp5',
      'delta 400',
    ];
    for (const vorlage of VORLAGEN) {
      const text = `${vorlage.id} ${vorlage.name} ${vorlage.beschreibung}`.toLowerCase();
      for (const marke of marken) {
        expect(text, `„${vorlage.name}“ nennt die Marke „${marke}“`).not.toContain(marke);
      }
    }
  });

  it('versprechen nichts, was sie nicht tun: „Klar“ hebt wirklich den Kontrast', () => {
    /*
     * Ein früherer Entwurf hatte diese Vorlage mit `kontrast 0.18`,
     * `lichter -0.15` und `tiefen +0.12` bestückt und „mehr Biss“
     * darübergeschrieben. Nachgerechnet nahmen Lichter und Tiefen den
     * Kontrast fast vollständig zurück: Die Tonwertspanne änderte sich um
     * 1,6 %, und was tatsächlich passierte, war Farbe. Deshalb misst dieser
     * Test die SPANNE und nicht die Buntheit.
     */
    const vorlage = VORLAGEN.find((v) => v.id === 'klar');
    expect(vorlage).toBeDefined();
    const dunkel = tonPunkt([0.24, 0.24, 0.24], vorlage!.anpassung)[0];
    const hell = tonPunkt([0.78, 0.78, 0.78], vorlage!.anpassung)[0];
    const spanneNeutral = 0.78 - 0.24;
    // „Etwas mehr Tiefe“ – gemessen 1,10-fache Spanne. Der Test prüft genau
    // das Versprechen, nicht mehr: Wer hier eine Vorlage einträgt, deren
    // Lichter und Tiefen den Kontrast wieder auffressen, wird rot.
    expect(hell - dunkel, 'die Tonwertspanne muss wachsen').toBeGreaterThan(spanneNeutral * 1.05);

    // „… und Farbe“: die Buntheit muss ebenfalls steigen.
    const bunt = (a: typeof NEUTRAL) => {
      const [r, g, b] = tonPunkt([0.6, 0.3, 0.3], a);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    expect(bunt(vorlage!.anpassung)).toBeGreaterThan(bunt(NEUTRAL) * 1.05);
  });

  it('machen aus „Schwarz-Weiss“ wirklich Grau', () => {
    const sw = VORLAGEN.find((v) => v.id === 'sw')!;
    const [r, g, b] = tonPunkt(ROSE, sw.anpassung);
    expect(Math.abs(r - g)).toBeLessThan(0.004);
    expect(Math.abs(g - b)).toBeLessThan(0.004);
  });

  it('trennen mit dem Rotfilter, was ohne Filter gleich aussieht', () => {
    const ohne = VORLAGEN.find((v) => v.id === 'sw')!;
    const rot = VORLAGEN.find((v) => v.id === 'sw-rot')!;
    const abstand = (v: typeof ohne) =>
      Math.abs(nach255(tonPunkt(ROSE, v.anpassung)[0]) - nach255(tonPunkt(HIMMEL, v.anpassung)[0]));
    expect(abstand(ohne)).toBeLessThan(10);
    expect(abstand(rot)).toBeGreaterThan(60);
  });
});

describe('vorlageAnwenden', () => {
  it('ist bei Stärke 0 genau neutral', () => {
    for (const vorlage of VORLAGEN) {
      expect(vorlageAnwenden(vorlage, 0)).toEqual(NEUTRAL);
    }
  });

  it('ist bei Stärke 1 genau die Vorlage', () => {
    for (const vorlage of VORLAGEN) {
      expect(vorlageAnwenden(vorlage, 1)).toEqual(vorlage.anpassung);
    }
  });

  it('liegt dazwischen in der Mitte', () => {
    const kraeftig = VORLAGEN.find((v) => v.id === 'kraeftig')!;
    const halb = vorlageAnwenden(kraeftig, 0.5);
    expect(halb.saettigung).toBeCloseTo(kraeftig.anpassung.saettigung / 2, 10);
    expect(halb.schaerfe).toBeCloseTo(kraeftig.anpassung.schaerfe / 2, 10);
  });

  it('klemmt unsinnige Stärken', () => {
    const v = VORLAGEN[0];
    expect(vorlageAnwenden(v, -3)).toEqual(NEUTRAL);
    expect(vorlageAnwenden(v, 7)).toEqual(v.anpassung);
  });
});
