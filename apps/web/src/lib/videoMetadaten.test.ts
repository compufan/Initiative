import { describe, expect, it } from 'vitest';

import { boxenLesen, freiBox, metadatenBereiche } from './videoMetadaten.js';

/** Baut eine Box: vier Zeichen Typ, beliebiger Inhalt. */
function box(typ: string, inhalt: Uint8Array | number[] = []): Uint8Array {
  const daten = inhalt instanceof Uint8Array ? inhalt : new Uint8Array(inhalt);
  const aus = new Uint8Array(8 + daten.length);
  new DataView(aus.buffer).setUint32(0, aus.length);
  for (let i = 0; i < 4; i += 1) aus[4 + i] = typ.charCodeAt(i);
  aus.set(daten, 8);
  return aus;
}

function zusammen(...teile: Uint8Array[]): Uint8Array {
  const laenge = teile.reduce((summe, teil) => summe + teil.length, 0);
  const aus = new Uint8Array(laenge);
  let at = 0;
  for (const teil of teile) {
    aus.set(teil, at);
    at += teil.length;
  }
  return aus;
}

describe('boxenLesen', () => {
  it('liest Typ und Grenzen', () => {
    const datei = zusammen(box('ftyp', [1, 2, 3, 4]), box('mdat', [9, 9]));
    const boxen = boxenLesen(datei);
    expect(boxen.map((b) => b.typ)).toEqual(['ftyp', 'mdat']);
    expect(boxen[0]).toMatchObject({ start: 0, inhalt: 8, ende: 12 });
    expect(boxen[1]).toMatchObject({ start: 12, inhalt: 20, ende: 22 });
  });

  it('rechnet den Versatz auf die ganze Datei um', () => {
    const boxen = boxenLesen(box('udta', [7]), 1000);
    expect(boxen[0]).toMatchObject({ start: 1000, inhalt: 1008, ende: 1009 });
  });

  it('versteht die 64-Bit-Länge', () => {
    /*
     * Grösse 1 heisst: Die echte Länge steht als 64-Bit-Zahl hinter dem Typ.
     * Genau das benutzt `mdat`, sobald ein Video über 4 GB gross ist – und
     * ein Handyvideo erreicht das. Wer den Fall übersieht, liest ab dort
     * Videodaten als Boxen.
     */
    const gross = new Uint8Array(24);
    const sicht = new DataView(gross.buffer);
    sicht.setUint32(0, 1);
    gross.set([0x6d, 0x64, 0x61, 0x74], 4); // mdat
    sicht.setBigUint64(8, 24n);
    const boxen = boxenLesen(gross);
    expect(boxen).toHaveLength(1);
    expect(boxen[0]).toMatchObject({ typ: 'mdat', start: 0, inhalt: 16, ende: 24 });
  });

  it('nimmt Grösse 0 als „bis zum Ende“', () => {
    const rest = new Uint8Array(20);
    rest.set([0x6d, 0x64, 0x61, 0x74], 4);
    const boxen = boxenLesen(rest);
    expect(boxen[0]).toMatchObject({ typ: 'mdat', ende: 20 });
  });

  it('hört auf, statt Unsinn zu lesen', () => {
    // Eine Länge, die über das Ende hinausgeht.
    const kaputt = new Uint8Array(12);
    new DataView(kaputt.buffer).setUint32(0, 9999);
    kaputt.set([0x6d, 0x6f, 0x6f, 0x76], 4);
    expect(boxenLesen(kaputt)).toEqual([]);
  });

  it('hört auf, wenn der Typ kein Text ist', () => {
    /*
     * Ohne diese Prüfung liest der Leser in `mdat` weiter und findet dort
     * zufällige „Boxen“ – Videodaten sehen streckenweise genau so aus. Er
     * würde dann Bereiche zum Nullen melden, die mitten im Bild liegen.
     */
    const datei = new Uint8Array(16);
    const sicht = new DataView(datei.buffer);
    sicht.setUint32(0, 16);
    datei.set([0x00, 0x01, 0x02, 0x03], 4);
    expect(boxenLesen(datei)).toEqual([]);
  });

  it('bricht bei einer Länge unter dem Kopf ab', () => {
    const datei = new Uint8Array(12);
    new DataView(datei.buffer).setUint32(0, 4);
    datei.set([0x66, 0x72, 0x65, 0x65], 4);
    expect(boxenLesen(datei)).toEqual([]);
  });
});

describe('metadatenBereiche', () => {
  it('findet udta und meta unter moov', () => {
    const moov = zusammen(box('mvhd', [0, 0, 0, 0]), box('udta', [1, 2, 3]), box('meta', [4]));
    const treffer = metadatenBereiche(moov, 100);
    expect(treffer).toHaveLength(2);
    expect(treffer[0]).toEqual({ start: 112, ende: 123 });
    expect(treffer[1]).toEqual({ start: 123, ende: 132 });
  });

  it('findet auch ein udta tief in einer Spur', () => {
    // moov / trak / mdia / udta – manche Kameras legen es dort ab.
    const udta = box('udta', [1, 2]);
    const mdia = box('mdia', udta);
    const trak = box('trak', mdia);
    const moov = zusammen(box('mvhd', [0]), trak);
    const treffer = metadatenBereiche(moov, 0);
    expect(treffer).toHaveLength(1);
    // mvhd 9 + trak-Kopf 8 + mdia-Kopf 8 = 25
    expect(treffer[0]).toEqual({ start: 25, ende: 35 });
  });

  it('nimmt herstellereigene uuid-Boxen mit', () => {
    const moov = zusammen(box('mvhd', [0]), box('uuid', [5, 5, 5]));
    expect(metadatenBereiche(moov, 0)).toHaveLength(1);
  });

  it('fasst mvhd und andere Boxen NICHT an', () => {
    /*
     * Der wichtigste Test dieser Datei. `mvhd` trägt die Zeitskala; `stbl`
     * und `stco` tragen die Positionen der Videodaten. Wer die nullt, macht
     * die Datei unabspielbar. Nur ausdrücklich benannte Metadatenboxen
     * dürfen fallen.
     */
    const moov = zusammen(
      box('mvhd', [1, 2, 3, 4]),
      box(
        'trak',
        zusammen(box('tkhd', [1]), box('mdia', box('minf', box('stbl', box('stco', [0]))))),
      ),
    );
    expect(metadatenBereiche(moov, 0)).toEqual([]);
  });

  it('steigt nicht beliebig tief', () => {
    // Fünf Ebenen: Das udta ganz unten wird bewusst nicht mehr gesucht.
    const tief = box('trak', box('mdia', box('minf', box('minf', box('udta', [1])))));
    expect(metadatenBereiche(tief, 0)).toEqual([]);
  });
});

describe('freiBox', () => {
  it('behält die Länge und heisst free', () => {
    const frei = freiBox(16);
    expect(frei.length).toBe(16);
    expect(new DataView(frei.buffer).getUint32(0)).toBe(16);
    expect(String.fromCharCode(...frei.subarray(4, 8))).toBe('free');
  });

  it('ist hinter dem Kopf vollständig genullt', () => {
    /*
     * Nur umbenennen genügt nicht: Ein Abspieler überspringt eine
     * `free`-Box, aber die Koordinaten stünden weiter in der Datei. Wer sie
     * mit einem Hex-Betrachter öffnet, findet sie. Genullt heisst weg.
     */
    const frei = freiBox(64);
    expect(Array.from(frei.subarray(8)).every((wert) => wert === 0)).toBe(true);
  });
});
