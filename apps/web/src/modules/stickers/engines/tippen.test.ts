/**
 * Die Rechnung, an der ein SAM-Einbau lautlos scheitert.
 *
 * Drei Zahlen, die alle nach „Aufloesung“ aussehen: Das Bild geht mit 512
 * hinein, die Punkte im Massstab 1024, die Antwort kommt auf 256. Wer sie
 * verwechselt, bekommt keine Fehlermeldung, sondern eine Maske, die um das
 * Seitenverhaeltnis danebenliegt.
 *
 * Der haeufigste Einzelfehler ist, den GANZEN 256er Block zu skalieren statt
 * nur den gueltigen Ausschnitt. Genau darauf zielt der erste Test.
 */
import { describe, expect, it } from 'vitest';
import { maskeAusLogits } from './tippen.js';

const MASKE = 256;

/** Ein Block mit vier Masken; in `index` steht ein Rechteck aus Einsen. */
function logits(index: number, rechteck: { x0: number; y0: number; x1: number; y1: number }) {
  const daten = new Float32Array(4 * MASKE * MASKE).fill(-8);
  const versatz = index * MASKE * MASKE;
  for (let y = rechteck.y0; y < rechteck.y1; y += 1) {
    for (let x = rechteck.x0; x < rechteck.x1; x += 1) {
      daten[versatz + y * MASKE + x] = 8;
    }
  }
  return daten;
}

describe('maskeAusLogits', () => {
  it('nimmt nur den gueltigen Ausschnitt – nicht den ganzen 256er Block', () => {
    // Querformat 2:1. Gueltig sind damit 256 x 128; alles unterhalb von
    // Zeile 128 ist Rand der Briefkasten-Einbettung und enthaelt Unsinn.
    // Hier steht dort ausdruecklich eine zweite, falsche Flaeche.
    const daten = logits(0, { x0: 0, y0: 0, x1: 256, y1: 64 });
    const versatz = 0;
    for (let y = 130; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) daten[versatz + y * MASKE + x] = 8;
    }

    const alpha = maskeAusLogits(daten, 0, 400, 200);
    // Die obere Haelfte gehoert dazu …
    expect(alpha[0]).toBeGreaterThan(200);
    // … und die untere nicht: Der Unsinn aus dem Rand darf nicht auftauchen.
    expect(alpha[199 * 400 + 200]).toBeLessThan(60);
  });

  it('waehlt die angegebene der vier Masken', () => {
    const daten = logits(2, { x0: 0, y0: 0, x1: 256, y1: 256 });
    expect(maskeAusLogits(daten, 2, 64, 64)[0]).toBeGreaterThan(200);
    expect(maskeAusLogits(daten, 0, 64, 64)[0]).toBeLessThan(60);
  });

  it('spiegelt nicht und vertauscht die Achsen nicht', () => {
    // Nur oben links im gueltigen Bereich. Bei vertauschten Achsen oder einer
    // Spiegelung landet die Flaeche in einer anderen Ecke.
    const daten = logits(0, { x0: 0, y0: 0, x1: 32, y1: 64 });
    const alpha = maskeAusLogits(daten, 0, 256, 256);
    const at = (x: number, y: number) => alpha[y * 256 + x];
    expect(at(10, 10)).toBeGreaterThan(200); // oben links: drin
    expect(at(200, 10)).toBeLessThan(60); // oben rechts: draussen
    expect(at(10, 200)).toBeLessThan(60); // unten links: draussen
  });

  it('stuft um die Null herum ab, statt hart zu schneiden', () => {
    // Ein Verlauf von -8 nach +8 muss Zwischenwerte ergeben – sonst sieht die
    // Kante auf einem Sticker ausgerissen aus.
    const daten = new Float32Array(4 * MASKE * MASKE);
    for (let y = 0; y < MASKE; y += 1) {
      for (let x = 0; x < MASKE; x += 1) daten[y * MASKE + x] = (x / MASKE) * 16 - 8;
    }
    const alpha = maskeAusLogits(daten, 0, 256, 256);
    const zeile = Array.from(alpha.slice(0, 256));
    expect(zeile.filter((w) => w > 20 && w < 235).length).toBeGreaterThan(20);
    expect(zeile[0]).toBeLessThan(20);
    expect(zeile[255]).toBeGreaterThan(235);
  });

  it('bleibt in 0…255', () => {
    const daten = logits(0, { x0: 0, y0: 0, x1: 256, y1: 256 });
    const alpha = maskeAusLogits(daten, 0, 100, 300);
    expect(Array.from(alpha).every((w) => w >= 0 && w <= 255)).toBe(true);
  });
});
