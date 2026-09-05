import { describe, expect, it } from 'vitest';

import { boxenLesen, freiBox, metadatenBereiche, videoBereinigen } from './videoMetadaten.js';

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

/**
 * Eine MP4-Datei von Hand - klein, vollstaendig und mit echten Koordinaten.
 *
 * Kein fremdes Video im Repo, kein Download beim Pruefen: Der Container ist
 * ein Boxbaum, und den kann man hinschreiben. `faststart` legt `moov` VOR
 * `mdat` - genau die Anordnung, bei der ein Herausschneiden alles kaputt
 * macht, weil `stco` auf absolute Dateipositionen zeigt.
 */
function mp4Bauen(faststart: boolean): { datei: Blob; mdatAb: number; stcoWert: number } {
  const gps = new TextEncoder().encode('+52.5200+013.4050/');
  const xyz = box('\u00a9xyz', new Uint8Array([0, gps.length, 0x15, 0xc7, ...gps]));
  const udta = box('udta', xyz);
  const meta = box('meta', box('ilst', new TextEncoder().encode('com.apple.quicktime.location')));

  // mvhd, Version 0: hinter dem Kopf ein Versionsbyte, drei Flag-Bytes,
  // dann Erstellungs- und Aenderungszeit als je vier Byte.
  const mvhdInhalt = new Uint8Array(100);
  new DataView(mvhdInhalt.buffer).setUint32(4, 3871491607);
  new DataView(mvhdInhalt.buffer).setUint32(8, 3871491607);
  const mvhd = box('mvhd', mvhdInhalt);

  const nutzdaten = new TextEncoder().encode('SAMPLE-AAAA-0001-BBBB-0002-CCCC-0003');
  const stcoPlatz = box('stco', new Uint8Array(12));
  const moovOhne = box('moov', zusammen(mvhd, udta, meta, stcoPlatz));
  // Die Laenge ausrechnen statt sie zu raten: 'isom   ' sind sieben Zeichen,
  // die Box also 15 Byte lang. Meine erste Fassung nahm 16 an und las danach
  // ein Byte zu weit - 'AMPLE-AAAA-0001-' statt 'SAMPLE-AAAA-0001'.
  const ftypVorab = box('ftyp', new TextEncoder().encode('isom   '));
  const mdatAb = faststart ? ftypVorab.length + moovOhne.length : ftypVorab.length;
  const stcoWert = mdatAb + 8;
  const stcoInhalt = new Uint8Array(12);
  const sicht = new DataView(stcoInhalt.buffer);
  sicht.setUint32(4, 1);
  sicht.setUint32(8, stcoWert);
  const moov = box('moov', zusammen(mvhd, udta, meta, box('stco', stcoInhalt)));
  const ftyp = ftypVorab;
  const mdat = box('mdat', nutzdaten);

  const datei = faststart ? zusammen(ftyp, moov, mdat) : zusammen(ftyp, mdat, moov);
  return { datei: new Blob([new Uint8Array(datei)], { type: 'video/mp4' }), mdatAb, stcoWert };
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('videoBereinigen', () => {
  for (const faststart of [false, true]) {
    const lage = faststart ? 'moov vorn (faststart)' : 'moov hinten (Kamera)';

    it(`entfernt die Koordinaten - ${lage}`, async () => {
      const { datei } = mp4Bauen(faststart);
      const vorher = await bytes(datei);
      expect(new TextDecoder('latin1').decode(vorher)).toContain('+52.5200+013.4050');

      const { datei: sauber, befund } = await videoBereinigen(datei);
      expect(befund.geaendert, befund.grund).toBe(true);
      expect(befund.boxen).toBe(2);

      const nachher = await bytes(sauber);
      const text = new TextDecoder('latin1').decode(nachher);
      expect(text, 'die Koordinaten stehen noch in der Datei').not.toContain('+52.5200');
      expect(text).not.toContain('com.apple.quicktime.location');
    });

    it(`verschiebt nichts - ${lage}`, async () => {
      /*
       * Der wichtigste Test der Datei.
       *
       * `stco` nennt eine ABSOLUTE Dateiposition. Wer eine Box entfernt,
       * statt sie zu ueberschreiben, verschiebt alles dahinter - und bei
       * faststart liegt mdat dahinter. Die Datei spielt dann nicht mehr oder
       * zeigt Muell, und zwar ohne jede Fehlermeldung.
       */
      const { datei, mdatAb, stcoWert } = mp4Bauen(faststart);
      const { datei: sauber } = await videoBereinigen(datei);
      expect(sauber.size, 'die Datei muss gleich lang bleiben').toBe(datei.size);

      const nachher = await bytes(sauber);
      const anDerStelle = new TextDecoder('latin1').decode(
        nachher.subarray(stcoWert, stcoWert + 16),
      );
      expect(anDerStelle).toBe('SAMPLE-AAAA-0001');
      expect(new TextDecoder('latin1').decode(nachher.subarray(mdatAb + 4, mdatAb + 8))).toBe(
        'mdat',
      );
    });

    it(`macht aus den Metadatenboxen gueltige free-Boxen - ${lage}`, async () => {
      const { datei } = mp4Bauen(faststart);
      const { datei: sauber } = await videoBereinigen(datei);
      const nachher = await bytes(sauber);
      const oben = boxenLesen(nachher).map((b) => b.typ);
      expect(oben).toContain('ftyp');
      expect(oben).toContain('moov');
      expect(oben).toContain('mdat');
      const moov = boxenLesen(nachher).find((b) => b.typ === 'moov')!;
      const drin = boxenLesen(nachher.subarray(moov.inhalt, moov.ende)).map((b) => b.typ);
      expect(drin).toEqual(['mvhd', 'free', 'free', 'stco']);
    });
  }

  it('nullt die Aufnahmezeit', async () => {
    /*
     * Bei einer Aufnahme im Browser ist das der einzige Rest: Dort entsteht
     * weder udta noch meta, aber mvhd traegt die Wanduhr auf die Sekunde
     * genau. Nachgemessen an einem Chromium-Mitschnitt: 3871491607 Sekunden
     * seit 1904, also 2026-09-05T22:20:07Z.
     */
    const { datei } = mp4Bauen(false);
    const { datei: sauber, befund } = await videoBereinigen(datei);
    expect(befund.zeiten).toBeGreaterThanOrEqual(1);
    const nachher = await bytes(sauber);
    const moov = boxenLesen(nachher).find((b) => b.typ === 'moov')!;
    const mvhd = boxenLesen(nachher.subarray(moov.inhalt, moov.ende), moov.inhalt).find(
      (b) => b.typ === 'mvhd',
    )!;
    const sicht = new DataView(nachher.buffer, nachher.byteOffset, nachher.byteLength);
    expect(sicht.getUint32(mvhd.inhalt + 4), 'Erstellungszeit').toBe(0);
    expect(sicht.getUint32(mvhd.inhalt + 8), 'Aenderungszeit').toBe(0);
  });

  it('laesst unbekannte Formate in Ruhe', async () => {
    /*
     * Ein Video, das nicht mehr abspielt, ist schlimmer als eines mit
     * Zusatzdaten: Das eine bemerkt der Anwender, das andere nicht.
     */
    const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])], {
      type: 'video/webm',
    });
    const { datei, befund } = await videoBereinigen(webm);
    expect(befund.geaendert).toBe(false);
    expect(datei).toBe(webm);
  });

  it('laesst eine Datei ohne Metadaten unveraendert', async () => {
    const ohne = new Blob([
      new Uint8Array(zusammen(box('ftyp', [1, 2, 3, 4]), box('moov', box('mdat', [9])))),
    ]);
    const { befund } = await videoBereinigen(ohne);
    expect(befund.geaendert).toBe(false);
    expect(befund.grund).toBe('nichts zu entfernen');
  });
});
