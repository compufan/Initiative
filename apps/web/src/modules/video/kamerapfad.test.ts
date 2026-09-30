import { describe, expect, it } from 'vitest';

import { Kamerapfad, schrittMessen } from './kamerapfad.js';
import { LAGE_RUHE, punktZurueck, type Grau } from './verfolgung.js';

/**
 * Der geteilte Kamerapfad: Schritte einzeln eintragen, Lagen über beliebige
 * Strecken abfragen.
 *
 * Die Szene ist ein gemusterter Grund, den die Kamera je Bild um (3, 1)
 * Graupunkte schwenkt: Bild n zeigt die Welt ab (3n, n). Ein Punkt (x, y) in
 * Bild k liegt deshalb in Bild a bei (x + 3(k − a), y + (k − a)) – das ist
 * die Wahrheit, gegen die gemessen wird.
 */

const B = 160;
const H = 120;
const VX = 3;
const VY = 1;

function welt(x: number, y: number): number {
  return 128 + 60 * Math.sin(x / 5.3 + Math.cos(y / 7.1)) * Math.cos(y / 4.7 - x / 13);
}

function bild(n: number): Grau {
  const werte = new Float32Array(B * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) werte[y * B + x] = welt(x + VX * n, y + VY * n);
  }
  return { breite: B, hoehe: H, werte };
}

function flach(): Grau {
  return { breite: B, hoehe: H, werte: new Float32Array(B * H).fill(90) };
}

describe('Kamerapfad', () => {
  it('trifft einen Schwenk über viele Bilder auf einen Bildpunkt genau', () => {
    const pfad = new Kamerapfad();
    const bilder = Array.from({ length: 21 }, (_, n) => bild(n));
    for (let k = 1; k <= 20; k += 1) {
      const { lage, faktor } = schrittMessen(bilder[k - 1], bilder[k], B);
      pfad.schrittSetzen(k, lage, faktor);
    }
    expect(pfad.faktor).toBe(1);
    for (const [a, k] of [
      [0, 20],
      [5, 12],
      [20, 3],
      [7, 7],
    ]) {
      const lage = pfad.lage(a, k);
      expect(lage, `${a} → ${k}`).not.toBeNull();
      const p = punktZurueck(lage ?? LAGE_RUHE, pfad.faktor, 80, 60);
      expect(Math.abs(p.x - (80 + VX * (k - a))), `${a} → ${k}`).toBeLessThan(1);
      expect(Math.abs(p.y - (60 + VY * (k - a))), `${a} → ${k}`).toBeLessThan(1);
    }
  });

  it('weiss nichts über eine Lücke – und fügt Schritte in beliebiger Reihenfolge zusammen', () => {
    const pfad = new Kamerapfad();
    const bilder = Array.from({ length: 11 }, (_, n) => bild(n));
    const setzen = (k: number) => {
      const { lage, faktor } = schrittMessen(bilder[k - 1], bilder[k], B);
      pfad.schrittSetzen(k, lage, faktor);
    };
    for (const k of [1, 2, 3, 4, 7, 8, 9, 10]) setzen(k);
    expect(pfad.lage(0, 4)).not.toBeNull();
    expect(pfad.lage(7, 10)).not.toBeNull();
    // Die Schritte 5 und 6 fehlen: zwischen 3 und 8 gibt es keine Lage.
    expect(pfad.lage(3, 8)).toBeNull();
    expect(pfad.schrittBekannt(5)).toBe(false);
    const vorher = pfad.version;
    setzen(6);
    setzen(5);
    expect(pfad.version).toBe(vorher + 2);
    const lage = pfad.lage(3, 8);
    expect(lage).not.toBeNull();
    const p = punktZurueck(lage ?? LAGE_RUHE, 1, 50, 50);
    expect(Math.abs(p.x - (50 + VX * 5))).toBeLessThan(1);
  });

  it('nimmt für einen Schritt ohne Struktur die Ruhe – er gilt als bekannt', () => {
    /*
     * Eine Brücke über ein einfarbiges Stück Film: Die Blocksuche findet
     * nichts, und `lageRobust` sagt `null`. Der Schritt ist dann die Ruhe,
     * und der Pfad reisst dort nicht ab – sonst stünde eine Form hinter
     * jeder weissen Wand für immer auf „offen".
     */
    const pfad = new Kamerapfad();
    const { lage, faktor } = schrittMessen(flach(), flach(), B);
    expect(lage).toEqual(LAGE_RUHE);
    pfad.schrittSetzen(1, lage, faktor);
    expect(pfad.lage(0, 1)).toEqual(LAGE_RUHE);
  });

  it('überschreibt einen bekannten Schritt nicht', () => {
    const pfad = new Kamerapfad();
    pfad.schrittSetzen(1, { s: 1, w: 0, tx: 2, ty: 0, sicher: 9 }, 3);
    pfad.schrittSetzen(1, { s: 1, w: 0, tx: 7, ty: 0, sicher: 9 }, 3);
    expect(pfad.lage(0, 1)?.tx).toBe(2);
    expect(pfad.version).toBe(1);
    expect(pfad.faktor).toBe(3);
  });
});
