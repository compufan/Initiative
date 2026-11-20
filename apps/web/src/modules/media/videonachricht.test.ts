import { describe, expect, it } from 'vitest';
import {
  istVideonachricht,
  mittigesQuadrat,
  ringStrich,
  videonachrichtMetadaten,
} from './videonachricht.js';

describe('Videonachricht', () => {
  it('erkennt sich an den Modul-Angaben', () => {
    const metadata = videonachrichtMetadaten(12_345.6);
    expect(metadata).toEqual({ module: { videonachricht: { dauerMs: 12_346 } } });
    expect(istVideonachricht({ type: 'video', metadata })).toBe(true);
    expect(istVideonachricht({ type: 'video', metadata: {} })).toBe(false);
    expect(istVideonachricht({ type: 'image', metadata })).toBe(false);
  });

  it('schneidet die Mitte quadratisch aus', () => {
    expect(mittigesQuadrat(1280, 720)).toEqual([280, 0, 720]);
    expect(mittigesQuadrat(720, 1280)).toEqual([0, 280, 720]);
    expect(mittigesQuadrat(500, 500)).toEqual([0, 0, 500]);
  });

  it('rechnet den Fortschrittsring', () => {
    const halb = ringStrich(0.5, 10);
    expect(halb.umfang).toBeCloseTo(2 * Math.PI * 10);
    expect(halb.versatz).toBeCloseTo(Math.PI * 10);
    expect(ringStrich(2, 10).versatz).toBe(0);
    expect(ringStrich(Number.NaN, 10).versatz).toBeCloseTo(2 * Math.PI * 10);
  });
});
