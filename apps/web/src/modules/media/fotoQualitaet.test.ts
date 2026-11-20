import { describe, expect, it } from 'vitest';
import { HD_KANTE, STANDARD_KANTE, fotoKante, hdZiel, istHd, zielMasse } from './fotoQualitaet.js';

describe('Foto-Qualität (HD)', () => {
  it('Standard: 1920 Punkte, HD: 4096 Punkte und höhere Güte', () => {
    expect(fotoKante(false)).toBe(STANDARD_KANTE);
    expect(fotoKante(true)).toBe(HD_KANTE);
    expect(hdZiel(false)).toEqual({ kante: 1920, guete: 0.82 });
    expect(hdZiel(true).kante).toBe(4096);
    expect(hdZiel(true).guete).toBeGreaterThan(hdZiel(false).guete);
  });

  it('verkleinert auf die lange Kante, vergrössert nie', () => {
    expect(zielMasse(6000, 4000, 1920)).toEqual({ breite: 1920, hoehe: 1280 });
    expect(zielMasse(6000, 4000, 4096)).toEqual({ breite: 4096, hoehe: 2731 });
    // Originalauflösung bis zur Grenze: ein 12-MP-Foto bleibt in HD, wie es ist.
    expect(zielMasse(4000, 3000, 4096)).toEqual({ breite: 4000, hoehe: 3000 });
    expect(zielMasse(3000, 4000, 1920)).toEqual({ breite: 1440, hoehe: 1920 });
    expect(zielMasse(800, 600, 1920)).toEqual({ breite: 800, hoehe: 600 });
  });

  it('das Abzeichen gibt es nur über Standard', () => {
    expect(istHd(1920, 1080)).toBe(false);
    expect(istHd(1080, 2400)).toBe(true);
    expect(istHd(null, undefined)).toBe(false);
  });
});
