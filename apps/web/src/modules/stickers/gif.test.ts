import { describe, expect, it } from 'vitest';
import { bildlageAus } from './bewegt.js';
import { farbtafel, gifSchreiben, lzwPacken, naechsterPlatz, type Teilbild } from './gif.js';

/**
 * Der GIF-Schreiber.
 *
 * # Wogegen hier geprüft wird
 *
 * Gegen den EIGENEN Leser. `bewegt.ts` läuft die Blockkette eines GIF durch,
 * um Teilbilder zu zählen – es wurde für hereinkommende Dateien geschrieben
 * und weiss nichts von diesem Schreiber. Kommt beim Durchlaufen die richtige
 * Zahl heraus, stimmt der Aufbau: jede Länge, jede Erweiterung, jeder
 * Unterblock. Ein einziges verrutschtes Byte, und der Leser verläuft sich.
 *
 * Das ist mehr wert als ein Vergleich gegen eine hinterlegte Datei: Der sagt
 * „gleich wie beim letzten Mal“, nicht „richtig“.
 *
 * Ob das Bild auch RICHTIG AUSSIEHT, prüft `e2e/sticker.spec.ts` im Browser –
 * dort gibt es einen echten GIF-Leser.
 */

function bild(breite: number, hoehe: number, farbe: (x: number, y: number) => number[]): ImageData {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const [r, g, b, a] = farbe(x, y);
      const at = (y * breite + x) * 4;
      daten[at] = r;
      daten[at + 1] = g;
      daten[at + 2] = b;
      daten[at + 3] = a ?? 255;
    }
  }
  // `ImageData` gibt es in der Node-Umgebung von vitest nicht.
  return { data: daten, width: breite, height: hoehe, colorSpace: 'srgb' } as ImageData;
}

function teil(daten: ImageData, dauerMs = 100): Teilbild {
  return { daten, dauerMs };
}

/**
 * Ein GIF wieder auseinandernehmen – Tafel, Teilbilder, Farben.
 *
 * Das ist mehr als `bildlageAus` kann: Der zählt Teilbilder, dieser Leser
 * packt den LZW-Strom aus und sagt, WELCHE FARBE an einer Stelle steht. Nötig
 * geworden, als der Farbzwischenspeicher aus der Teilbildschleife wanderte –
 * ein Speicher, den sich alle Teilbilder teilen, ist nur dann richtig, wenn er
 * beim zweiten Teilbild dieselben Farben liefert wie beim ersten, und genau
 * das lässt sich ohne Auspacken nicht sehen.
 */
function gifLesen(roh: Uint8Array) {
  let at = 13; // Kopf (6) und Logical Screen Descriptor (7)
  const tafelBits = (roh[10] & 0x07) + 1;
  const tafel: number[][] = [];
  if (roh[10] & 0x80) {
    for (let i = 0; i < 1 << tafelBits; i += 1, at += 3) {
      tafel.push([roh[at], roh[at + 1], roh[at + 2]]);
    }
  }

  /** Die Unterblockkette ab `at` einsammeln; `at` steht danach dahinter. */
  const bloecke = () => {
    const raus: number[] = [];
    while (roh[at] !== 0) {
      const laenge = roh[at];
      at += 1;
      for (let i = 0; i < laenge; i += 1) raus.push(roh[at + i]);
      at += laenge;
    }
    at += 1;
    return raus;
  };

  const teilbilder: { breite: number; hoehe: number; indizes: number[] }[] = [];
  while (at < roh.length && roh[at] !== 0x3b) {
    if (roh[at] === 0x21) {
      at += 2; // Kennung und Bezeichner
      bloecke();
      continue;
    }
    if (roh[at] !== 0x2c) throw new Error(`Unbekannter Block 0x${roh[at].toString(16)} bei ${at}`);
    at += 1;
    const breite = roh[at + 4] | (roh[at + 5] << 8);
    const hoehe = roh[at + 6] | (roh[at + 7] << 8);
    at += 9;
    const mindestBreite = roh[at];
    at += 1;
    teilbilder.push({ breite, hoehe, indizes: lzwAuspacken(bloecke(), mindestBreite) });
  }
  return { tafel, teilbilder };
}

/** Der Gegenspieler zu `lzwPacken`: variable Codebreite, kleinstes Bit zuerst. */
function lzwAuspacken(bytes: number[], mindestBreite: number): number[] {
  const loeschen = 1 << mindestBreite;
  const ende = loeschen + 1;
  let woerter: number[][] = [];
  let breite = mindestBreite + 1;
  const raus: number[] = [];
  let vorher: number[] | null = null;
  let speicher = 0;
  let bits = 0;

  const zuruecksetzen = () => {
    woerter = [];
    for (let i = 0; i < loeschen; i += 1) woerter.push([i]);
    woerter.push([], []); // Plätze für Lösch- und Endecode
    breite = mindestBreite + 1;
    vorher = null;
  };
  zuruecksetzen();

  for (const byte of bytes) {
    speicher |= byte << bits;
    bits += 8;
    while (bits >= breite) {
      const code = speicher & ((1 << breite) - 1);
      speicher >>>= breite;
      bits -= breite;
      if (code === ende) return raus;
      if (code === loeschen) {
        zuruecksetzen();
        continue;
      }
      // Der Sonderfall des Formats: ein Code, der erst durch sich selbst
      // entsteht. Er kommt vor, wenn dasselbe Zeichen sich sofort wiederholt.
      const wort: number[] =
        code < woerter.length ? woerter[code] : [...(vorher ?? []), (vorher ?? [])[0]];
      raus.push(...wort);
      if (vorher) {
        woerter.push([...vorher, wort[0]]);
        if (woerter.length === 1 << breite && breite < 12) breite += 1;
      }
      vorher = wort;
    }
  }
  return raus;
}

describe('gifSchreiben', () => {
  it('schreibt eine Datei, die der eigene Leser als bewegt erkennt', () => {
    const rot = bild(8, 8, () => [220, 30, 30]);
    const blau = bild(8, 8, () => [30, 30, 220]);
    const gruen = bild(8, 8, () => [30, 200, 30]);
    const roh = gifSchreiben([teil(rot), teil(blau), teil(gruen)]);

    const lage = bildlageAus(roh);
    expect(lage.bewegt, 'die Datei gilt nicht als bewegt').toBe(true);
    if (!lage.bewegt) return;
    expect(lage.format).toBe('gif');
    /*
     * Die Zahl ist der eigentliche Prüfstein: `bewegt.ts` läuft dafür die
     * ganze Blockkette durch – Kopf, Tafel, jede Erweiterung, jeder
     * Unterblock. Stimmt irgendwo eine Länge nicht, verläuft es sich und
     * zählt etwas anderes als drei.
     */
    expect(lage.bilder, 'die Teilbilder sind nicht sauber aneinandergereiht').toBe(3);
  });

  it('läuft endlos – sonst bewegt sich ein Sticker genau einmal', () => {
    const roh = gifSchreiben([
      teil(bild(4, 4, () => [10, 20, 30])),
      teil(bild(4, 4, () => [200, 200, 200])),
    ]);
    const text = Array.from(roh.slice(0, 200), (b) => String.fromCharCode(b)).join('');
    /*
     * Der Schleifenvermerk ist eine Erweiterung von Netscape aus dem Jahr
     * 1995, die nie in der Spezifikation stand. Ohne sie läuft jedes GIF
     * genau einmal ab und bleibt dann stehen – und ein Sticker, der sich
     * einmal bewegt und dann liegenbleibt, wirkt wie ein Fehler.
     */
    expect(text, 'der Schleifenvermerk fehlt').toContain('NETSCAPE2.0');
    const at = text.indexOf('NETSCAPE2.0') + 11;
    expect([roh[at], roh[at + 1]]).toEqual([3, 1]);
    expect([roh[at + 2], roh[at + 3]], 'die Wiederholungen stehen nicht auf endlos').toEqual([
      0, 0,
    ]);
  });

  it('gleich grosse Teilbilder sind Pflicht, und das sagt es auch', () => {
    expect(() =>
      gifSchreiben([teil(bild(4, 4, () => [0, 0, 0])), teil(bild(5, 4, () => [0, 0, 0]))]),
    ).toThrow(/gleich gross/);
    expect(() => gifSchreiben([])).toThrow(/ohne Teilbilder/);
  });

  it('die Standzeit fällt nie auf null', () => {
    /*
     * Null oder eins in Hundertstelsekunden rechnen etliche Leser auf zehn
     * hoch – die Bewegung wird dann LANGSAMER statt schneller, und zwar je
     * nach Browser verschieden. Zwei ist die kleinste Zahl, die überall
     * dasselbe bedeutet.
     */
    const roh = gifSchreiben([
      teil(
        bild(4, 4, () => [0, 0, 0]),
        5,
      ),
      teil(
        bild(4, 4, () => [1, 1, 1]),
        5,
      ),
    ]);
    // Die Graphic Control Extension: 0x21 0xF9 0x04 <flags> <lo> <hi> …
    let gefunden = 0;
    for (let i = 0; i < roh.length - 6; i += 1) {
      if (roh[i] === 0x21 && roh[i + 1] === 0xf9 && roh[i + 2] === 4) {
        const dauer = roh[i + 4] | (roh[i + 5] << 8);
        expect(dauer, 'eine Standzeit unter zwei Hundertsteln').toBeGreaterThanOrEqual(2);
        gefunden += 1;
      }
    }
    expect(gefunden).toBe(2);
  });

  it('gibt jedem Teilbild seine eigenen Farben zurück', () => {
    /*
     * Die Prüfung, die der gemeinsame Farbzwischenspeicher braucht.
     *
     * Er wird über ALLE Teilbilder hinweg gefüllt – das ist der Unterschied
     * zwischen 9754 ms und 2866 ms bei fünfzig Teilbildern. Richtig ist das
     * nur, weil die Tafel für alle dieselbe ist. Wäre an dem Schluss etwas
     * falsch, bekäme das zweite Teilbild die Farben des ersten, und die Datei
     * wäre trotzdem tadellos aufgebaut – `bildlageAus` zählte weiter drei.
     * Sichtbar wird es erst hier, wo die Farben wieder ausgepackt werden.
     */
    const farben = [
      [220, 30, 30],
      [30, 30, 220],
      [30, 200, 30],
      [230, 210, 40],
    ];
    const roh = gifSchreiben(farben.map((f) => teil(bild(6, 6, () => f))));
    const { tafel, teilbilder } = gifLesen(roh);
    expect(teilbilder).toHaveLength(4);

    teilbilder.forEach((gelesen, nummer) => {
      expect(gelesen.indizes, `Teilbild ${nummer} ist unvollständig`).toHaveLength(36);
      for (const platz of gelesen.indizes) {
        const [r, g, b] = tafel[platz];
        const [sr, sg, sb] = farben[nummer];
        /*
         * Acht Stufen Abstand sind erlaubt, keine mehr: `farbtafel` zählt auf
         * fünf Bit je Kanal gerundet, die Tafel trifft die Farbe also nie ganz
         * genau. Eine VERWECHSELTE Farbe läge um ein Vielfaches daneben.
         */
        expect(Math.abs(r - sr), `Teilbild ${nummer}, Rot`).toBeLessThanOrEqual(8);
        expect(Math.abs(g - sg), `Teilbild ${nummer}, Grün`).toBeLessThanOrEqual(8);
        expect(Math.abs(b - sb), `Teilbild ${nummer}, Blau`).toBeLessThanOrEqual(8);
      }
    });
  });

  it('gibt einer wiederkehrenden Farbe wieder denselben Platz', () => {
    // Dasselbe Bild am Anfang und am Ende: Was der Zwischenspeicher beim
    // ersten Mal gelernt hat, muss beim letzten Mal noch stimmen.
    const rot = bild(5, 5, () => [200, 40, 40]);
    const blau = bild(5, 5, () => [40, 40, 200]);
    const { teilbilder } = gifLesen(gifSchreiben([teil(rot), teil(blau), teil(rot)]));
    expect(teilbilder[0].indizes).toEqual(teilbilder[2].indizes);
    expect(teilbilder[0].indizes).not.toEqual(teilbilder[1].indizes);
  });

  it('durchsichtige Punkte bekommen den reservierten Platz', () => {
    const halb = bild(4, 4, (x) => [200, 50, 50, x < 2 ? 255 : 0]);
    const roh = gifSchreiben([teil(halb), teil(halb)]);
    /*
     * GIF hat keinen Alphakanal, sondern einen TAFELPLATZ, der als
     * durchsichtig gilt. Steht das Kennbit nicht, ist ein freigestellter
     * Sticker ein Rechteck mit schwarzem Grund.
     */
    let mitKennbit = 0;
    for (let i = 0; i < roh.length - 6; i += 1) {
      if (roh[i] === 0x21 && roh[i + 1] === 0xf9 && roh[i + 2] === 4) {
        expect(roh[i + 3] & 0x01, 'das Kennbit für Durchsichtigkeit fehlt').toBe(1);
        // Und die Entsorgungsart 2: Ohne sie bleibt jedes Teilbild stehen und
        // scheint durch das nächste hindurch.
        expect((roh[i + 3] >> 2) & 0x07, 'die Entsorgungsart ist nicht 2').toBe(2);
        mitKennbit += 1;
      }
    }
    expect(mitKennbit).toBe(2);
  });
});

describe('farbtafel', () => {
  it('gibt seltenen, aber weit entfernten Farben einen eigenen Platz', () => {
    /*
     * Der Grund für den Median-Schnitt statt „die häufigsten Farben“.
     *
     * Hier ist das Bild zu 99 Prozent grau und hat einen kleinen roten Fleck.
     * Wer zählt, gibt alle Plätze den Grauabstufungen; wer teilt, behält für
     * das Rot einen übrig – und genau darum geht es bei einem Sticker, der
     * fast nur Fläche ist.
     */
    const daten = bild(100, 100, (x, y) =>
      x < 8 && y < 8 ? [230, 20, 20] : [128 + ((x + y) % 8), 128, 128],
    );
    const tafel = farbtafel([teil(daten)], 16);
    const rotPlatz = naechsterPlatz(tafel, 230, 20, 20);
    const rot = tafel[rotPlatz];
    expect(
      ((rot >> 16) & 0xff) - (rot & 0xff),
      `der rote Fleck hat keinen eigenen Platz bekommen: ${tafel.map((f) => f.toString(16))}`,
    ).toBeGreaterThan(100);
  });

  it('zählt durchsichtige Punkte nicht mit', () => {
    // Sonst zöge ein freigestellter Sticker seine Tafel mit der Farbe voll,
    // die unter der Durchsichtigkeit liegt – meist Schwarz.
    const daten = bild(20, 20, (x) => (x < 19 ? [0, 0, 0, 0] : [200, 100, 50, 255]));
    const tafel = farbtafel([teil(daten)], 4);
    expect(tafel.length).toBeGreaterThan(0);
    const platz = naechsterPlatz(tafel, 200, 100, 50);
    expect((tafel[platz] >> 16) & 0xff).toBeGreaterThan(150);
  });

  it('eine gemeinsame Tafel über alle Teilbilder', () => {
    /*
     * Eine Tafel je Teilbild wären bei zwanzig Teilbildern zwanzig mal 768
     * Byte – und sie flackerten gegeneinander: Dieselbe Farbe bekäme in jedem
     * Teilbild einen anderen Platz und damit einen leicht anderen Ton.
     */
    const rot = bild(16, 16, () => [220, 30, 30]);
    const blau = bild(16, 16, () => [30, 30, 220]);
    const tafel = farbtafel([teil(rot), teil(blau)], 8);
    const rotPlatz = tafel[naechsterPlatz(tafel, 220, 30, 30)];
    const blauPlatz = tafel[naechsterPlatz(tafel, 30, 30, 220)];
    expect((rotPlatz >> 16) & 0xff).toBeGreaterThan(150);
    expect(blauPlatz & 0xff).toBeGreaterThan(150);
  });
});

describe('naechsterPlatz', () => {
  it('gewichtet nach dem, was das Auge sieht', () => {
    /*
     * Der Fall, in dem gewichtet und ungewichtet AUSEINANDERGEHEN – alles
     * andere prüfte nur, dass irgendein Nachbar gefunden wird.
     *
     * Gesucht ist Schwarz. Auf der Tafel stehen ein Platz, der um 10 im Grün
     * danebenliegt, und einer, der um 20 im Blau danebenliegt. Ungewichtet
     * gewinnt das Grün (100 gegen 400); mit den Gewichten des Auges gewinnt
     * das Blau (6·100 = 600 gegen 400), weil ein Fehler im Grün sechsmal so
     * stark auffällt.
     */
    const tafel = [0x000a00, 0x000014];
    expect(
      naechsterPlatz(tafel, 0, 0, 0),
      'ein Fehler im Grün wurde so billig gerechnet wie einer im Blau',
    ).toBe(1);
  });

  it('trifft eine Farbe, die genau dasteht', () => {
    const tafel = [0x112233, 0xaabbcc, 0xff0000];
    expect(naechsterPlatz(tafel, 0xaa, 0xbb, 0xcc)).toBe(1);
    expect(naechsterPlatz(tafel, 0xff, 0, 0)).toBe(2);
  });
});

describe('lzwPacken', () => {
  it('fängt mit dem Löschcode an und hört mit dem Endecode auf', () => {
    /*
     * Beides ist Pflicht und beides sieht man dem Ergebnis nicht an: Fehlt
     * der Löschcode, liest der Empfänger mit einem Wörterbuch, das nicht
     * seines ist; fehlt der Endecode, liest er über das Bild hinaus.
     */
    const gepackt = lzwPacken(new Uint8Array([0, 0, 0, 0]), 2);
    // Der erste Unterblock: <Länge> <Bytes…>
    expect(gepackt[0]).toBeGreaterThan(0);
    expect(gepackt[gepackt.length - 1], 'die Blockkette ist nicht abgeschlossen').toBe(0);

    // Von der niedrigsten Bitstelle aufwärts gelesen: erst 0b100 (Löschen).
    const bits = gepackt[1] | (gepackt[2] << 8) | (gepackt[3] << 16);
    expect(bits & 0b111, 'der Löschcode fehlt am Anfang').toBe(4);
  });

  it('packt Wiederholungen wirklich zusammen', () => {
    // Der ganze Zweck: Tausend gleiche Punkte dürfen nicht tausend Bytes
    // kosten. Ohne Wörterbuch käme hier nichts unter 375 Bytes heraus.
    const gepackt = lzwPacken(new Uint8Array(1000).fill(3), 4);
    expect(gepackt.length, `1000 gleiche Punkte wurden zu ${gepackt.length} Bytes`).toBeLessThan(
      60,
    );
  });

  it('kommt auch mit gar nichts zurecht', () => {
    const gepackt = lzwPacken(new Uint8Array(0), 2);
    expect(gepackt.length).toBeGreaterThan(0);
    expect(gepackt[gepackt.length - 1]).toBe(0);
  });

  it('zerlegt in Unterblöcke von höchstens 255 Byte', () => {
    /*
     * Das verlangt das Format. Ein Block über 255 lässt sich in einem
     * Längenbyte gar nicht ausdrücken – der Leser nähme die unteren acht Bit
     * und verlöre den Rest.
     */
    const zufall = new Uint8Array(20000);
    let saat = 7;
    for (let i = 0; i < zufall.length; i += 1) {
      saat = (saat * 1103515245 + 12345) & 0x7fffffff;
      zufall[i] = (saat >> 16) & 0xff;
    }
    const gepackt = lzwPacken(zufall, 8);
    let at = 0;
    let bloecke = 0;
    while (at < gepackt.length) {
      const laenge = gepackt[at];
      if (laenge === 0) break;
      expect(laenge).toBeLessThanOrEqual(255);
      at += laenge + 1;
      bloecke += 1;
    }
    expect(
      bloecke,
      'es kam nur ein Block heraus – dann greift die Zerlegung nicht',
    ).toBeGreaterThan(1);
    expect(at, 'die Blockkette endet nicht auf der Null').toBe(gepackt.length - 1);
  });
});
