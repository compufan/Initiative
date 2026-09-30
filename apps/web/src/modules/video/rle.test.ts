import { describe, expect, it } from 'vitest';

import {
  META_LEER,
  RLE_LEER,
  metaLeer,
  metaMessen,
  quantisieren,
  rleDekodieren,
  rleKodieren,
  rleLeer,
} from './rle.js';
import { bewegtGlaetten } from './verfolgung.js';

/**
 * Masken als Lauflängen – so liegen die Spuren der Verfolgung im Speicher.
 *
 * Ein Fehler hier zeigt sich nicht als Absturz, sondern als Maske, die an
 * einem Bild um ein paar Punkte verrutscht oder am Rand ausfranst. Deshalb
 * geht jede Probe hin und zurück und wird Punkt für Punkt verglichen – gegen
 * die GERUNDETE Vorlage, denn das Runden ist Absicht (siehe `rle.ts`).
 */

function gerundet(alpha: Uint8Array): Uint8Array {
  return alpha.map(quantisieren);
}

/**
 * Die erste Stelle, an der zwei Masken sich unterscheiden – oder −1.
 *
 * Statt `toEqual`: Das vergleicht eine halbe Million Werte einzeln mit
 * Protokoll und braucht dafür anderthalb Sekunden.
 */
function abweichung(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

function weicheScheibe(b: number, h: number, mx: number, my: number, r: number, rand = 3) {
  const alpha = new Uint8Array(b * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < b; x += 1) {
      const d = Math.hypot(x - mx, y - my);
      alpha[y * b + x] = Math.round(255 * Math.min(1, Math.max(0, (r - d) / rand + 0.5)));
    }
  }
  return alpha;
}

function zufall(saat: number): () => number {
  let wert = saat;
  return () => {
    wert = (wert * 1103515245 + 12345) % 2 ** 31;
    return wert / 2 ** 31;
  };
}

describe('rleKodieren / rleDekodieren', () => {
  it('kommt bei zufälligen Werten unverändert zurück (bis aufs Runden)', () => {
    const naechste = zufall(7);
    const alpha = new Uint8Array(10_000).map(() => Math.floor(naechste() * 256));
    const rle = rleKodieren(alpha);
    expect(abweichung(rleDekodieren(rle, alpha.length), gerundet(alpha))).toBe(-1);
  });

  it('packt eine leere Maske zu nichts – und aus zu Nullen voller Länge', () => {
    expect(rleKodieren(new Uint8Array(518_400))).toBe(RLE_LEER);
    // Fast leer ist leer: bis 5 wird 0.
    expect(rleKodieren(new Uint8Array(100).fill(5))).toBe(RLE_LEER);
    expect(rleLeer(RLE_LEER)).toBe(true);
    const aus = rleDekodieren(RLE_LEER, 64);
    expect(aus).toHaveLength(64);
    expect(aus.every((wert) => wert === 0)).toBe(true);
  });

  it('packt eine volle Maske in ein paar Byte', () => {
    const alpha = new Uint8Array(518_400).fill(255);
    const rle = rleKodieren(alpha);
    expect(rle.length).toBeLessThan(12);
    expect(abweichung(rleDekodieren(rle, alpha.length), alpha)).toBe(-1);
  });

  it('packt eine weiche Scheibe bei 960 × 540 in unter 16 KB', () => {
    const alpha = weicheScheibe(960, 540, 480, 270, 150);
    const rle = rleKodieren(alpha);
    expect(rle.length).toBeLessThan(16_000);
    expect(abweichung(rleDekodieren(rle, alpha.length), gerundet(alpha))).toBe(-1);
  });

  it('kommt mit geglätteten Masken zurecht', () => {
    // So kommen sie aus der Verfolgung: drei Bilder, bewegt gemittelt.
    const b = 320;
    const h = 180;
    const masken = [100, 108, 116].map((mx) => weicheScheibe(b, h, mx, 90, 40));
    const versatz = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 0 },
    ];
    for (const maske of bewegtGlaetten(masken, b, h, versatz)) {
      expect(abweichung(rleDekodieren(rleKodieren(maske), maske.length), gerundet(maske))).toBe(-1);
    }
  });

  it('trägt Läufe jeder Länge – kurz, mittel und über die Kurzform hinaus', () => {
    for (const laenge of [1, 2, 3, 4, 128, 129, 130, 131, 5000]) {
      const alpha = new Uint8Array(laenge + 2);
      alpha.fill(200, 1, 1 + laenge);
      expect(rleDekodieren(rleKodieren(alpha), alpha.length)).toEqual(alpha);
    }
  });

  it('rundet fast volle und fast leere Zuversicht', () => {
    const alpha = Uint8Array.from([250, 251, 254, 249, 6, 5, 1, 0]);
    expect(Array.from(rleDekodieren(rleKodieren(alpha), alpha.length))).toEqual([
      255, 255, 255, 249, 6, 0, 0, 0,
    ]);
  });

  it('packt in ein vorhandenes Feld aus – auch eine leere Maske', () => {
    const alpha = weicheScheibe(64, 48, 30, 20, 10);
    const ziel = new Uint8Array(64 * 48).fill(99);
    expect(rleDekodieren(rleKodieren(alpha), ziel.length, ziel)).toBe(ziel);
    expect(ziel).toEqual(gerundet(alpha));
    rleDekodieren(RLE_LEER, ziel.length, ziel);
    expect(ziel.every((wert) => wert === 0)).toBe(true);
  });

  it('lehnt eine falsche Länge ab, statt Unsinn auszupacken', () => {
    const rle = rleKodieren(weicheScheibe(64, 48, 30, 20, 10));
    expect(() => rleDekodieren(rle, 64 * 47)).toThrow();
    expect(() => rleDekodieren(rle, 64 * 48, new Uint8Array(10))).toThrow();
  });
});

describe('metaMessen', () => {
  it('misst Fläche, Schwerpunkt und Kasten', () => {
    const b = 100;
    const h = 80;
    const alpha = new Uint8Array(b * h);
    for (let y = 10; y < 20; y += 1) for (let x = 30; x < 50; x += 1) alpha[y * b + x] = 255;
    const meta = metaMessen(alpha, b, h);
    expect(meta.flaeche).toBe(200);
    expect(meta.mx).toBeCloseTo(39.5, 6);
    expect(meta.my).toBeCloseTo(14.5, 6);
    expect(meta).toMatchObject({ x0: 30, y0: 10, x1: 49, y1: 19 });
    expect(metaLeer(meta)).toBe(false);
  });

  it('zählt Schwaches in die Fläche, aber nicht in den Kasten', () => {
    const alpha = new Uint8Array(100);
    alpha[5] = 40;
    const meta = metaMessen(alpha, 10, 10);
    expect(meta.flaeche).toBeCloseTo(40 / 255, 6);
    expect(meta.x1).toBeLessThan(meta.x0);
    expect(metaLeer(meta)).toBe(true);
  });

  it('gibt für eine leere Maske die leeren Werte', () => {
    expect(metaMessen(new Uint8Array(100).fill(3), 10, 10)).toBe(META_LEER);
  });
});
