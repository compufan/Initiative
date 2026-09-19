import { describe, expect, it } from 'vitest';

import { ZIEL_RATE, dezimieren, nachMono, wavSchreiben } from './wav.js';

/**
 * Die Prüfungen für den WAV-Schreiber.
 *
 * Geprüft wird der Kopf BYTE FÜR BYTE. Das ist nicht Pedanterie: Eine
 * WAV-Datei mit einem falschen Grössenfeld spielt in manchen Abspielern
 * tadellos und in anderen gar nicht, und welcher welcher ist, merkt man erst,
 * wenn jemand die Nachricht bekommen hat.
 */

async function bytesVon(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function text(sicht: DataView, at: number, laenge: number): string {
  let aus = '';
  for (let i = 0; i < laenge; i += 1) aus += String.fromCharCode(sicht.getUint8(at + i));
  return aus;
}

describe('wavSchreiben', () => {
  it('schreibt einen Kopf, der Byte für Byte stimmt', async () => {
    const werte = new Float32Array([0, 0.5, -0.5, 1]);
    const sicht = await bytesVon(wavSchreiben([werte], 24_000));

    expect(text(sicht, 0, 4)).toBe('RIFF');
    expect(text(sicht, 8, 4)).toBe('WAVE');
    expect(text(sicht, 12, 4)).toBe('fmt ');
    expect(text(sicht, 36, 4)).toBe('data');

    // Kleinendig – RIFF kommt von Intel, anders als PNG und GIF.
    expect(sicht.getUint32(16, true)).toBe(16); // Länge des fmt-Abschnitts
    expect(sicht.getUint16(20, true)).toBe(1); // lineares PCM
    expect(sicht.getUint16(22, true)).toBe(1); // ein Kanal
    expect(sicht.getUint32(24, true)).toBe(24_000);
    expect(sicht.getUint32(28, true)).toBe(24_000 * 2); // Bytes je Sekunde
    expect(sicht.getUint16(32, true)).toBe(2); // Bytes je Zeitpunkt
    expect(sicht.getUint16(34, true)).toBe(16); // Bit je Wert

    // Die beiden Grössenfelder müssen zur Datei passen.
    expect(sicht.getUint32(40, true)).toBe(4 * 2);
    expect(sicht.getUint32(4, true)).toBe(36 + 4 * 2);
    expect(sicht.byteLength).toBe(44 + 4 * 2);
  });

  it('klemmt, was über die Aussteuerung hinausgeht', async () => {
    /*
     * Ohne Klemmung liefe `setInt16` über, und aus dem LAUTESTEN Ton würde
     * der leiseste – ein Knacken genau an der Stelle, an der es am meisten
     * stört. Die Web Audio API lässt Werte über eins ausdrücklich zu.
     */
    const sicht = await bytesVon(wavSchreiben([new Float32Array([1.5, -1.5, 1, -1])], 8000));
    expect(sicht.getInt16(44, true)).toBe(32767);
    expect(sicht.getInt16(46, true)).toBe(-32767);
    expect(sicht.getInt16(48, true)).toBe(32767);
    expect(sicht.getInt16(50, true)).toBe(-32767);
  });

  it('verschränkt zwei Kanäle Zeitpunkt für Zeitpunkt', async () => {
    // Links, rechts, links, rechts – nicht erst alles links. Wer das
    // vertauscht, bekommt eine Datei, die doppelt so lang klingt und in der
    // Mitte umschlägt.
    const links = new Float32Array([1, 0]);
    const rechts = new Float32Array([-1, 0]);
    const sicht = await bytesVon(wavSchreiben([links, rechts], 8000));
    expect(sicht.getUint16(22, true)).toBe(2);
    expect(sicht.getInt16(44, true)).toBe(32767);
    expect(sicht.getInt16(46, true)).toBe(-32767);
  });

  it('nennt sich audio/wav', async () => {
    // `buildAttachment` normiert über den Typ des Blobs; heisst er anders,
    // landet die Datei mit dem falschen MIME beim Server und wird abgelehnt.
    expect(wavSchreiben([new Float32Array(2)], 8000).type).toBe('audio/wav');
  });

  it('lehnt eine leere Kanalliste ab', () => {
    expect(() => wavSchreiben([], 8000)).toThrow();
  });
});

describe('nachMono', () => {
  it('reicht einen einzelnen Kanal unverändert durch', () => {
    const eins = new Float32Array([0.25, -0.25]);
    expect(nachMono([eins])).toBe(eins);
  });

  it('mittelt mehrere Kanäle', () => {
    const aus = nachMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(Array.from(aus)).toEqual([0.5, 0.5]);
  });
});

describe('dezimieren', () => {
  it('lässt in Ruhe, was nicht kleiner werden soll', () => {
    const werte = new Float32Array([1, 2, 3]);
    expect(dezimieren(werte, 8000, 8000)).toBe(werte);
    expect(dezimieren(werte, 8000, 16000)).toBe(werte);
  });

  it('mittelt über das Fenster, statt Werte wegzulassen', () => {
    /*
     * Die Falle, für die es diese Prüfung gibt: Jeden zweiten Wert zu nehmen
     * ist eine Zeile weniger und erfindet Töne, die es nicht gab – alles
     * oberhalb der halben neuen Rate klappt nach unten um. Bei Sprache hört
     * man das als metallisches Zischen.
     *
     * Ein Signal, das zwischen +1 und −1 springt, ist genau dieser Fall: Wer
     * jeden zweiten Wert nimmt, bekommt eine Gleichspannung von +1. Wer
     * mittelt, bekommt null – und null ist richtig, denn dieser Ton liegt
     * oberhalb dessen, was die neue Rate tragen kann.
     */
    const werte = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
    const aus = dezimieren(werte, 8000, 4000);
    expect(aus.length).toBe(4);
    for (const wert of aus) expect(Math.abs(wert)).toBeLessThan(1e-6);
  });

  it('trifft die Länge, die zur neuen Rate gehört', () => {
    const werte = new Float32Array(48_000); // eine Sekunde bei 48 kHz
    expect(dezimieren(werte, 48_000, ZIEL_RATE).length).toBe(ZIEL_RATE);
  });
});
