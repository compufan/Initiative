import { describe, expect, it } from 'vitest';
import { kanteWeichzeichnen, maskeTraegt } from './prepare.js';
import { STICKER_SIZE, createDoc, sourceRect, toSourcePoint } from '../render.js';

describe('Geometrie zwischen Bild und Sticker-Flaeche', () => {
  it('fuellt die Flaeche vollstaendig', () => {
    // Ein breites Bild: die Hoehe muss genau passen, die Breite ueberstehen.
    const rect = sourceRect({ width: 1600, height: 900 }, createDoc());
    expect(rect.height).toBeCloseTo(STICKER_SIZE, 5);
    expect(rect.width).toBeGreaterThan(STICKER_SIZE);
    // Mittig: links und rechts steht gleich viel ueber.
    expect(rect.x + rect.width / 2).toBeCloseTo(STICKER_SIZE / 2, 5);
  });

  it('rechnet einen Punkt hin und zurueck', () => {
    // Genau das braucht "Gesicht": der Finger tippt auf die Flaeche, das
    // Modell arbeitet im Bild. Stimmt die Umrechnung nicht, wird beim
    // Gruppenfoto das falsche Gesicht ausgewaehlt.
    const quelle = { width: 1600, height: 900 };
    const doc = { ...createDoc(), scale: 1.7, offsetX: -40, offsetY: 25 };

    const imBild = toSourcePoint({ x: 300, y: 210 }, quelle, doc);
    const rect = sourceRect(quelle, doc);
    const zurueck = {
      x: rect.x + (imBild.x / quelle.width) * rect.width,
      y: rect.y + (imBild.y / quelle.height) * rect.height,
    };
    expect(zurueck.x).toBeCloseTo(300, 5);
    expect(zurueck.y).toBeCloseTo(210, 5);
  });

  it('beruecksichtigt Verschieben und Zoomen', () => {
    const quelle = { width: 800, height: 800 };
    const ohne = sourceRect(quelle, createDoc());
    const mit = sourceRect(quelle, { ...createDoc(), offsetX: 30, scale: 2 });
    expect(mit.width).toBeCloseTo(ohne.width * 2, 5);
    // Doppelt so gross, also ragt es je Seite um die halbe Zunahme heraus –
    // und zusaetzlich um das Verschieben.
    expect(mit.x).toBeCloseTo(ohne.x - ohne.width / 2 + 30, 5);
  });
});

describe('Maske nachbearbeiten', () => {
  it('macht die harte Kante weich', () => {
    const breite = 16;
    const hoehe = 16;
    const alpha = new Uint8Array(breite * hoehe);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        alpha[y * breite + x] = x < 8 ? 255 : 0;
      }
    }

    const weich = kanteWeichzeichnen(alpha, breite, hoehe, 1);

    // Innen und aussen bleiben, was sie waren.
    expect(weich[8 * breite + 2]).toBe(255);
    expect(weich[8 * breite + 13]).toBe(0);
    // Genau an der Kante entsteht ein Zwischenwert – vorher gab es nur 0/255.
    const kante = weich[8 * breite + 8];
    expect(kante).toBeGreaterThan(0);
    expect(kante).toBeLessThan(255);
  });

  it('erkennt eine leere Maske', () => {
    // Findet ein Modell nichts, waere der Sticker durchsichtig. Lieber eine
    // ehrliche Meldung als ein leeres Bild.
    const leer = new Uint8Array(100 * 100);
    expect(maskeTraegt(leer)).toBe(false);

    const kaum = new Uint8Array(100 * 100);
    kaum.fill(255, 0, 50); // 0,5 % der Flaeche
    expect(maskeTraegt(kaum)).toBe(false);

    const motiv = new Uint8Array(100 * 100);
    motiv.fill(255, 0, 3000); // 30 %
    expect(maskeTraegt(motiv)).toBe(true);
  });

  it('zaehlt halbdurchsichtige Raender nicht als Motiv', () => {
    const knapp = new Uint8Array(100 * 100).fill(20);
    expect(maskeTraegt(knapp)).toBe(false);
  });
});
