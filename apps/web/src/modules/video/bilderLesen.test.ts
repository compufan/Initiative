import { describe, expect, it } from 'vitest';

import { brauchtDauerSuche, masse, VideoLeseError } from './bilderLesen.js';

/**
 * Geprüft wird hier das Rechenbare.
 *
 * Ob `currentTime` wirklich auf das richtige Bild springt, entscheidet der
 * Browser und niemand sonst; das steht in `e2e/videoGif.spec.ts`. Was hier
 * steht, sind die beiden Stellen, an denen sich ohne Browser etwas falsch
 * machen lässt – die Zielgrösse und die Frage, ob die Länge erst gesucht
 * werden muss.
 */

describe('masse', () => {
  it('legt die LÄNGERE Kante auf das Mass', () => {
    expect(masse(1920, 1080, 384)).toEqual({ b: 384, h: 216 });
    expect(masse(1080, 1920, 384)).toEqual({ b: 216, h: 384 });
  });

  it('rechnet ein kleines Video NICHT hoch', () => {
    /*
     * Ein hochgerechnetes Bild hat keinen Punkt mehr Inhalt, aber im GIF
     * viermal so viele Punkte zu packen. Die einzige Wirkung wäre eine
     * grössere Datei.
     */
    expect(masse(320, 240, 512)).toEqual({ b: 320, h: 240 });
  });

  it('gibt immer gerade Kanten', () => {
    // `verfolgung.ts` schätzt die Bewegung in Blöcken; eine ungerade Kante
    // lässt dort einen halben Block übrig.
    for (const [b, h] of [
      [1233, 707],
      [999, 333],
      [101, 99],
    ]) {
      const ziel = masse(b, h, 385);
      expect(ziel.b % 2, `${b}×${h}`).toBe(0);
      expect(ziel.h % 2, `${b}×${h}`).toBe(0);
    }
  });

  it('behält das Seitenverhältnis', () => {
    const { b, h } = masse(1280, 720, 300);
    expect(b / h).toBeCloseTo(1280 / 720, 1);
  });

  it('fällt nie unter zwei Punkte', () => {
    // Eine Leinwand mit null Punkten Höhe wirft beim `getImageData`.
    expect(masse(1000, 3, 10).h).toBeGreaterThanOrEqual(2);
  });

  it('sagt es, wenn das Video gar keine Grösse hat', () => {
    /*
     * Das ist kein erfundener Fall: Eine Tondatei mit der Endung `.mp4` lädt
     * ihre Metadaten sauber und hat `videoWidth === 0`. Ohne diese Prüfung
     * entstünde eine Leinwand mit null Punkten und eine Fehlermeldung aus dem
     * Browser, die niemandem hilft.
     */
    expect(() => masse(0, 0, 384)).toThrow(VideoLeseError);
    expect(() => masse(640, 0, 384)).toThrow(VideoLeseError);
  });
});

describe('brauchtDauerSuche', () => {
  it('erkennt die Aufnahme aus der eigenen App', () => {
    /*
     * `MediaRecorder` schreibt WebM im Strom und kennt beim Schreiben des
     * Kopfes die Länge noch nicht. Sie bleibt `Infinity`, jeder Sprung landet
     * am Anfang – und ohne diese Prüfung bekäme man fünfzig Mal dasselbe Bild,
     * ohne dass irgendwo ein Fehler stünde.
     */
    expect(brauchtDauerSuche(Number.POSITIVE_INFINITY)).toBe(true);
    expect(brauchtDauerSuche(Number.NaN)).toBe(true);
    expect(brauchtDauerSuche(0)).toBe(true);
  });

  it('lässt eine gewöhnliche Datei in Ruhe', () => {
    // Der Umweg kostet zwei Sprünge über die ganze Datei. Bei einem Video mit
    // ordentlichem Kopf wäre das verschenkte Zeit.
    expect(brauchtDauerSuche(5.31)).toBe(false);
  });
});
