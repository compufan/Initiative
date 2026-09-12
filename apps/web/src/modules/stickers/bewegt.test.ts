import { describe, expect, it } from 'vitest';
import { bildlageAus } from './bewegt.js';

/** Baut ein GIF mit `n` Teilbildern – nur so viel Kopf, wie der Leser braucht. */
function gif(n: number, mitGlobalerTabelle = true): Uint8Array {
  const bytes: number[] = [];
  for (const z of 'GIF89a') bytes.push(z.charCodeAt(0));
  // Logical Screen Descriptor: Breite, Höhe, packed, Hintergrund, Seitenformat
  bytes.push(1, 0, 1, 0, mitGlobalerTabelle ? 0x80 : 0x00, 0, 0);
  if (mitGlobalerTabelle) {
    // Zwei Farben à drei Byte.
    for (let i = 0; i < 6; i += 1) bytes.push(0);
  }
  for (let i = 0; i < n; i += 1) {
    // Graphic Control Extension – das, was eine naive Suche zählen würde.
    bytes.push(0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00);
    // Image Descriptor: Marke, x, y, Breite, Höhe, packed (keine lokale Tabelle)
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00);
    // LZW-Mindestcodegrösse, ein Datenblock, Abschluss
    bytes.push(0x02, 0x02, 0x44, 0x01, 0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

/** Ein WebP – mit oder ohne Animationsbit im VP8X-Kopf. */
function webp(bewegt: boolean): Uint8Array {
  const bytes: number[] = [];
  const schreibe = (s: string) => {
    for (const z of s) bytes.push(z.charCodeAt(0));
  };
  schreibe('RIFF');
  bytes.push(0, 0, 0, 0);
  schreibe('WEBP');
  schreibe('VP8X');
  bytes.push(10, 0, 0, 0);
  bytes.push(bewegt ? 0x02 : 0x00, 0, 0, 0);
  for (let i = 0; i < 6; i += 1) bytes.push(0);
  return new Uint8Array(bytes);
}

describe('bildlageAus', () => {
  it('erkennt ein bewegtes GIF und zählt seine Teilbilder', () => {
    const lage = bildlageAus(gif(4));
    expect(lage.bewegt).toBe(true);
    expect(lage.bewegt && lage.format).toBe('gif');
    expect(lage.bewegt && lage.bilder).toBe(4);
  });

  it('hält ein GIF mit einem einzigen Teilbild für ein Standbild', () => {
    expect(bildlageAus(gif(1)).bewegt).toBe(false);
  });

  /*
   * Der Grund für den Blockdurchlauf statt einer Suche nach `0x2C`: Eine
   * Farbtabelle darf dieses Byte enthalten, und eine naive Suche zählte es
   * als Teilbild. Ein Standbild würde dann als bewegt gemeldet.
   */
  it('lässt sich von einem 0x2C in der Farbtabelle nicht täuschen', () => {
    const daten = gif(1);
    // Die globale Tabelle liegt hinter dem 13 Byte langen Kopf.
    daten[13] = 0x2c;
    daten[14] = 0x2c;
    expect(bildlageAus(daten).bewegt).toBe(false);
  });

  it('kommt auch ohne globale Farbtabelle zurecht', () => {
    expect(bildlageAus(gif(3, false)).bewegt).toBe(true);
  });

  it('erkennt ein bewegtes WebP am Animationsbit', () => {
    const lage = bildlageAus(webp(true));
    expect(lage.bewegt).toBe(true);
    expect(lage.bewegt && lage.format).toBe('webp');
    // Die Zahl steht im Kopf nicht – dann wird sie auch nicht behauptet.
    expect(lage.bewegt && lage.bilder).toBeNull();
  });

  it('hält ein ruhendes WebP für ein Standbild', () => {
    expect(bildlageAus(webp(false)).bewegt).toBe(false);
  });

  it('hält ein PNG für ein Standbild', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(bildlageAus(png).bewegt).toBe(false);
  });

  it('verschluckt sich nicht an einer abgeschnittenen Datei', () => {
    expect(bildlageAus(new Uint8Array([0x47, 0x49, 0x46, 0x38])).bewegt).toBe(false);
    expect(bildlageAus(new Uint8Array(0)).bewegt).toBe(false);
  });
});
