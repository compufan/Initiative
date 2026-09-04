import { describe, expect, it } from 'vitest';
import { aufLeinwand, basisAus, lupeHalten, zoomAusSpanne } from './lupe.js';

/** Eine Leinwand von 600 × 800 Punkten, Bild doppelt so gross. */
const BASIS = basisAus(600, 1200);

describe('zoomAusSpanne', () => {
  it('verdoppelt den Zoom bei doppeltem Fingerabstand', () => {
    expect(zoomAusSpanne(2, 100, 200)).toBe(4);
  });

  it('bleibt zwischen 1 und 8', () => {
    expect(zoomAusSpanne(2, 100, 10)).toBe(1);
    expect(zoomAusSpanne(2, 100, 10_000)).toBe(8);
  });

  it('rührt den Zoom nicht an, wenn der Startabstand null war', () => {
    expect(zoomAusSpanne(3, 0, 200)).toBe(3);
  });
});

describe('lupeHalten', () => {
  it('lässt den angefassten Punkt unter der Fingermitte stehen', () => {
    // Finger deutlich ausserhalb der Leinwandmitte: oben links.
    const anker = { x: 400, y: 300 };
    const mitte = { x: 50, y: 60 };
    const lupe = lupeHalten({ ankerAnsicht: anker, mitteLeinwand: mitte, basis: BASIS, zoom: 3 });
    const zurueck = aufLeinwand(anker, lupe, BASIS);
    expect(zurueck.x).toBeCloseTo(mitte.x, 6);
    expect(zurueck.y).toBeCloseTo(mitte.y, 6);
  });

  it('hält ihn auch, während sich der Zoom ändert', () => {
    const anker = { x: 900, y: 100 };
    const mitte = { x: 520, y: 740 };
    for (const zoom of [1, 1.7, 3, 8]) {
      const lupe = lupeHalten({ ankerAnsicht: anker, mitteLeinwand: mitte, basis: BASIS, zoom });
      const zurueck = aufLeinwand(anker, lupe, BASIS);
      expect(zurueck.x).toBeCloseTo(mitte.x, 6);
      expect(zurueck.y).toBeCloseTo(mitte.y, 6);
    }
  });

  it('schiebt bei gleichbleibendem Zoom genau so weit wie die Finger', () => {
    const anker = { x: 400, y: 300 };
    const zoom = 3;
    const a = lupeHalten({
      ankerAnsicht: anker,
      mitteLeinwand: { x: 200, y: 200 },
      basis: BASIS,
      zoom,
    });
    const b = lupeHalten({
      ankerAnsicht: anker,
      mitteLeinwand: { x: 260, y: 200 },
      basis: BASIS,
      zoom,
    });
    // 60 Leinwandpunkte nach rechts geschoben heisst: der Ausschnitt beginnt
    // 60 / (basis · zoom) Ansichtspunkte weiter links.
    expect(a.x - b.x).toBeCloseTo(60 / (BASIS * zoom), 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it('zentriert nicht – die alte Rechnung tat genau das', () => {
    // Die alte Fassung setzte statt der Fingermitte die halbe Leinwand ein:
    //   x = anker − breite / (basis · zoom) / 2
    // Der Anker landete damit immer in der Bildmitte, egal wo die Finger
    // lagen. Diese Prüfung schlägt fehl, sobald jemand dorthin zurückgeht.
    const anker = { x: 400, y: 300 };
    const zoom = 3;
    const lupe = lupeHalten({
      ankerAnsicht: anker,
      mitteLeinwand: { x: 60, y: 80 },
      basis: BASIS,
      zoom,
    });
    const zentriert = anker.x - 600 / (BASIS * zoom) / 2;
    expect(Math.abs(lupe.x - zentriert)).toBeGreaterThan(100);
  });
});

describe('basisAus', () => {
  it('ist unabhängig vom Zoom, weil die Leinwandbreite es ist', () => {
    expect(basisAus(600, 1200)).toBeCloseTo(0.5, 9);
    expect(basisAus(1200, 1200)).toBeCloseTo(1, 9);
  });

  it('teilt nicht durch null', () => {
    expect(Number.isFinite(basisAus(600, 0))).toBe(true);
  });
});
