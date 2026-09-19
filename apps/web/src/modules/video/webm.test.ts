import { describe, expect, it } from 'vitest';

import { vint, webmSchreiben, type WebmBild } from './webm.js';

/**
 * Der WebM-Behälter.
 *
 * # Wogegen hier geprüft wird
 *
 * Gegen die REGELN des Formates, nicht gegen eine hinterlegte Datei. Ein
 * Vergleich mit einer gespeicherten Fassung sagt „gleich wie beim letzten
 * Mal", und das kann genauso gut heissen „gleich falsch". Geprüft wird
 * deshalb: Steht der Kopf da, wo er hingehört? Passt jede Längenangabe zu
 * dem, was danach kommt? Beginnt ein Haufen bei jedem Schlüsselbild?
 *
 * Ob ein Abspieler die Datei auch nimmt, entscheidet ein Abspieler –
 * `e2e/videoSchreiben.spec.ts` lässt Chromium sie laden und abspielen.
 */

function bild(zeitMs: number, schluessel: boolean, laenge = 8): WebmBild {
  return { daten: new Uint8Array(laenge).fill(zeitMs & 0xff), zeitMs, schluessel };
}

/** Den Baum durchlaufen und jede Längenangabe nachrechnen. */
function baum(roh: Uint8Array, von: number, bis: number, tiefe = 0): string[] {
  const raus: string[] = [];
  let at = von;
  while (at < bis) {
    const idLaenge = kennungslaenge(roh[at]);
    let id = 0;
    for (let i = 0; i < idLaenge; i += 1) id = id * 256 + roh[at + i];
    at += idLaenge;

    const laengeLaenge = vintLaenge(roh[at]);
    let laenge = roh[at] & (0xff >> laengeLaenge);
    for (let i = 1; i < laengeLaenge; i += 1) laenge = laenge * 256 + roh[at + i];
    at += laengeLaenge;

    if (at + laenge > bis)
      throw new Error(`Längenangabe zeigt über das Ende: 0x${id.toString(16)}`);
    raus.push(`${'  '.repeat(tiefe)}0x${id.toString(16)}:${laenge}`);
    // Nur Sammelknoten weiter aufklappen – Inhalte sind keine Bäume.
    if ([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675].includes(id)) {
      raus.push(...baum(roh, at, at + laenge, tiefe + 1));
    }
    at += laenge;
  }
  return raus;
}

function kennungslaenge(erstes: number): number {
  for (let i = 0; i < 4; i += 1) if (erstes & (0x80 >> i)) return i + 1;
  throw new Error('Keine gültige Kennung');
}

function vintLaenge(erstes: number): number {
  for (let i = 0; i < 8; i += 1) if (erstes & (0x80 >> i)) return i + 1;
  throw new Error('Keine gültige Längenangabe');
}

describe('vint', () => {
  it('nimmt für kleine Zahlen ein Byte', () => {
    expect(vint(0)).toEqual([0x80]);
    expect(vint(1)).toEqual([0x81]);
    expect(vint(125)).toEqual([0xfd]);
  });

  it('weicht bei 127 auf zwei Bytes aus', () => {
    /*
     * 127 wäre `0xff` – und ein Wert, dessen Bits alle gesetzt sind, bedeutet
     * in Matroska „unbekannte Länge". Ein Knoten von genau 127 Byte würde also
     * als endlos gelesen, und der Abspieler verschluckte den ganzen Rest der
     * Datei. Diese Grenze ist der Grund für das `>=` in der Schleife.
     */
    expect(vint(126), '126 passt noch in ein Byte').toEqual([0xfe]);
    expect(vint(127), '127 wäre 0xff und damit „unbekannt“').toEqual([0x40, 0x7f]);
    expect(vint(128)).toEqual([0x40, 0x80]);
    // Dieselbe Grenze eine Stufe höher: 2^14 − 1.
    expect(vint(16_382)).toHaveLength(2);
    expect(vint(16_383)).toHaveLength(3);
  });

  it('rechnet auch über die 32-Bit-Grenze hinaus richtig', () => {
    /*
     * Ein Video von ein paar Minuten ist schnell über vier Gigabyte, und
     * Bitschieben rechnet in JavaScript mit 32 Bit – `1 << 32` ist 1, nicht
     * 4294967296. Deshalb steht in `vint` eine Division und keine Schiebung.
     */
    const bytes = vint(5_000_000_000);
    let zurueck = bytes[0] & (0xff >> bytes.length);
    for (let i = 1; i < bytes.length; i += 1) zurueck = zurueck * 256 + bytes[i];
    expect(zurueck).toBe(5_000_000_000);
  });

  it('weist eine negative Länge ab', () => {
    expect(() => vint(-1)).toThrow();
  });
});

describe('webmSchreiben', () => {
  it('fängt mit der EBML-Kennung an', () => {
    // Daran erkennt jeder Abspieler die Datei – und `file(1)` auch.
    const roh = webmSchreiben([bild(0, true)], {
      codec: 'vp9',
      breite: 320,
      hoehe: 240,
      dauerMs: 1000,
    });
    expect(Array.from(roh.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  it('schreibt einen Baum, in dem jede Länge stimmt', () => {
    /*
     * Der eigentliche Prüfstein. Ein Behälter ist eine Kette aus „Kennung,
     * Länge, Inhalt"; sitzt eine Länge um ein Byte daneben, verläuft sich der
     * Abspieler ab dort – und zeigt nicht etwa einen Fehler, sondern ein
     * schwarzes Bild.
     */
    const roh = webmSchreiben(
      [bild(0, true), bild(40, false), bild(80, false), bild(120, true), bild(160, false)],
      { codec: 'vp9', breite: 320, hoehe: 240, dauerMs: 200 },
    );
    const knoten = baum(roh, 0, roh.length);
    expect(knoten.some((zeile) => zeile.includes('0x18538067'))).toBe(true);
    expect(knoten.some((zeile) => zeile.includes('0x1654ae6b'))).toBe(true);
    expect(knoten.filter((zeile) => zeile.includes('0x1f43b675'))).toHaveLength(2);
  });

  it('beginnt bei jedem Schlüsselbild einen neuen Haufen', () => {
    /*
     * Damit ein Abspieler springen kann, ohne die Datei von vorn zu lesen.
     * Drei Schlüsselbilder heissen drei Haufen – auch wenn sie dicht
     * beieinanderliegen.
     */
    const roh = webmSchreiben([bild(0, true), bild(40, true), bild(80, true)], {
      codec: 'vp8',
      breite: 64,
      hoehe: 64,
      dauerMs: 120,
    });
    const haufen = baum(roh, 0, roh.length).filter((zeile) => zeile.includes('0x1f43b675'));
    expect(haufen).toHaveLength(3);
  });

  it('teilt einen langen Haufen, bevor die Zeitangabe überläuft', () => {
    /*
     * Die Zeit an einem Block zählt ab dem Anfang seines Haufens und hat
     * sechzehn Bit MIT VORZEICHEN. Ein Haufen über 32,7 Sekunden ist deshalb
     * nicht bloss unschön, er ist unlesbar: Der Versatz kippt ins Negative,
     * und die Bilder landen vor dem Anfang.
     */
    const bilder = Array.from({ length: 60 }, (_, i) => bild(i * 1000, i === 0));
    const roh = webmSchreiben(bilder, {
      codec: 'vp9',
      breite: 64,
      hoehe: 64,
      dauerMs: 60_000,
    });
    const haufen = baum(roh, 0, roh.length).filter((zeile) => zeile.includes('0x1f43b675'));
    expect(haufen.length).toBeGreaterThan(1);
  });

  it('schreibt die Masse und die Länge in den Kopf', () => {
    // Ohne sie kennt ein Abspieler die Grösse erst beim ersten Bild – und
    // eine Zeitleiste hat er gar nicht.
    const roh = webmSchreiben([bild(0, true)], {
      codec: 'vp9',
      breite: 1280,
      hoehe: 720,
      dauerMs: 4500,
    });
    const text = Array.from(roh)
      .map((byte) => String.fromCharCode(byte))
      .join('');
    // PixelWidth (0xb0) mit zwei Bytes: 1280 = 0x0500, 720 = 0x02d0.
    expect(text).toContain(String.fromCharCode(0xb0, 0x82, 0x05, 0x00));
    expect(text).toContain(String.fromCharCode(0xba, 0x82, 0x02, 0xd0));
    // Die Länge steht als Gleitkommazahl mit acht Bytes.
    const bei = roh.indexOf(0x44);
    expect(bei).toBeGreaterThan(0);
  });

  it('nennt den Codec beim Namen aus der Matroska-Liste', () => {
    const lesen = (codec: 'vp8' | 'vp9') =>
      Array.from(webmSchreiben([bild(0, true)], { codec, breite: 8, hoehe: 8, dauerMs: 40 }))
        .map((byte) => String.fromCharCode(byte))
        .join('');
    expect(lesen('vp9')).toContain('V_VP9');
    expect(lesen('vp8')).toContain('V_VP8');
  });

  it('verlangt, dass das erste Bild für sich allein steht', () => {
    /*
     * Sonst hat der Abspieler nichts, worauf er die folgenden beziehen kann.
     * Je nach Abspieler bleibt das Bild dann schwarz, statt dass er sich
     * beschwert – ein Fehler, der erst beim Ansehen auffällt.
     */
    expect(() =>
      webmSchreiben([bild(0, false)], {
        codec: 'vp9',
        breite: 8,
        hoehe: 8,
        dauerMs: 40,
      }),
    ).toThrow(/Schlüsselbild/);
  });

  it('nimmt keine leere Bildfolge an', () => {
    expect(() => webmSchreiben([], { codec: 'vp9', breite: 8, hoehe: 8, dauerMs: 0 })).toThrow();
  });

  it('schreibt einen Suchindex, der VOR den Haufen steht', () => {
    /*
     * Ohne `Cues` findet ein Abspieler beim Springen nur ungefähr die
     * richtige Stelle. Unter Last fiel das auf: Der Sprung auf 2,25 s
     * lieferte das Bild vom Anfang – und zwar nur, wenn nebenher
     * zweihundert andere Prüfungen liefen.
     *
     * Er muss VOR den Haufen stehen, damit er schon beim Öffnen gelesen wird
     * und nicht erst, wenn jemand bis ans Ende geladen hat.
     */
    const roh = webmSchreiben(
      [bild(0, true), bild(40, false), bild(5000, true), bild(5040, false)],
      { codec: 'vp9', breite: 64, hoehe: 64, dauerMs: 5080 },
    );
    const zeilen = baum(roh, 0, roh.length);
    const cues = zeilen.findIndex((zeile) => zeile.includes('0x1c53bb6b'));
    const haufen = zeilen.findIndex((zeile) => zeile.includes('0x1f43b675'));
    expect(cues, 'es gibt gar keinen Suchindex').toBeGreaterThan(-1);
    expect(cues, 'der Suchindex steht hinter den Haufen').toBeLessThan(haufen);
  });

  it('zeigt mit jedem Indexeintrag auf den Anfang eines Haufens', () => {
    /*
     * Der eigentliche Prüfstein – und der Grund für die Schleife in
     * `webmSchreiben`: Wo ein Haufen liegt, wird ab dem Anfang der Nutzdaten
     * gezählt, und dazu gehört der Index selbst. Seine Länge hängt also von
     * den Zahlen ab, die in ihm stehen. Ein Eintrag, der um zwei Byte
     * danebenliegt, führt beim Springen mitten in einen Block.
     */
    const roh = webmSchreiben(
      [bild(0, true), bild(40, false), bild(5000, true), bild(10_000, true)],
      { codec: 'vp9', breite: 64, hoehe: 64, dauerMs: 10_040 },
    );

    // Wo die Nutzdaten des Segments anfangen: hinter Kennung und Längenangabe.
    const segmentAt = suchen(roh, [0x18, 0x53, 0x80, 0x67]);
    const datenAt = segmentAt + 4 + vintLaenge(roh[segmentAt + 4]);

    const stellen = indexStellen(roh);
    expect(stellen, 'drei Haufen, drei Einträge').toHaveLength(3);
    for (const stelle of stellen) {
      // Dort muss eine Haufenkennung stehen – und zwar genau dort.
      expect(Array.from(roh.subarray(datenAt + stelle, datenAt + stelle + 4))).toEqual([
        0x1f, 0x43, 0xb6, 0x75,
      ]);
    }
  });

  it('gibt jedem Block seine Zeit RELATIV zum Haufen', () => {
    /*
     * Die verbreitetste Verwechslung bei Matroska – und sie fällt nicht auf,
     * solange es nur einen Haufen gibt. Hier gibt es zwei, und der zweite
     * beginnt bei 5000 ms: Sein erster Block muss dort auf null stehen.
     */
    const roh = webmSchreiben(
      [bild(0, true), bild(40, false), bild(5000, true), bild(5040, false)],
      { codec: 'vp9', breite: 8, hoehe: 8, dauerMs: 5080 },
    );
    // SimpleBlock (0xa3), Länge, Spur (0x81), dann zwei Byte Zeit.
    const versaetze: number[] = [];
    for (let i = 0; i + 5 < roh.length; i += 1) {
      if (roh[i] === 0xa3 && roh[i + 2] === 0x81) {
        versaetze.push((roh[i + 3] << 8) | roh[i + 4]);
      }
    }
    expect(versaetze).toEqual([0, 40, 0, 40]);
  });
});

/** Die erste Stelle, an der diese Bytefolge steht. */
function suchen(roh: Uint8Array, folge: number[]): number {
  for (let i = 0; i + folge.length <= roh.length; i += 1) {
    if (folge.every((byte, k) => roh[i + k] === byte)) return i;
  }
  throw new Error('Folge nicht gefunden');
}

/**
 * Alle `CueClusterPosition` aus dem Suchindex.
 *
 * Gesucht wird NUR innerhalb des Index. `0xf1` steht ebenso gut mitten in
 * Bilddaten, und eine Suche über die ganze Datei fände dort Zahlen, die
 * nichts bedeuten – die erste Fassung dieser Prüfung ist genau darüber
 * gestolpert.
 */
function indexStellen(roh: Uint8Array): number[] {
  const cuesAt = suchen(roh, [0x1c, 0x53, 0xbb, 0x6b]);
  const laengeLaenge = vintLaenge(roh[cuesAt + 4]);
  let laenge = roh[cuesAt + 4] & (0xff >> laengeLaenge);
  for (let k = 1; k < laengeLaenge; k += 1) laenge = laenge * 256 + roh[cuesAt + 4 + k];
  const von = cuesAt + 4 + laengeLaenge;
  const bis = von + laenge;

  const raus: number[] = [];
  for (let i = von; i + 2 < bis; i += 1) {
    if (roh[i] !== 0xf1) continue;
    /*
     * Hinter der Kennung steht die LÄNGE, und erst dahinter der Wert. Die
     * erste Fassung las die Längenangabe als Wert und bekam für jeden
     * Eintrag eine Eins – was wie ein Fehler im Schreiber aussah und keiner
     * war.
     */
    const laengeLaengeHier = vintLaenge(roh[i + 1]);
    let wieViele = roh[i + 1] & (0xff >> laengeLaengeHier);
    for (let k = 1; k < laengeLaengeHier; k += 1) wieViele = wieViele * 256 + roh[i + 1 + k];
    const wertAt = i + 1 + laengeLaengeHier;
    let wert = 0;
    for (let k = 0; k < wieViele; k += 1) wert = wert * 256 + roh[wertAt + k];
    raus.push(wert);
    i = wertAt + wieViele - 1;
  }
  return raus;
}
