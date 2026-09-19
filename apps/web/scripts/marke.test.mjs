import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { AUFTRAEGE, QUELLE, pngLesen, pngSchreiben, symbol, verkleinern } from './marke.mjs';

/**
 * Die Prüfungen für den Bausatz der App-Symbole.
 *
 * # Warum hier überhaupt geprüft wird
 *
 * Weil dieses Skript zwei Dinge tut, die still schiefgehen. Ein PNG-Decoder,
 * der einen der fünf Zeilenfilter falsch rechnet, liefert kein Fehlerbild,
 * sondern ein Bild, das aussieht wie durch Wasser betrachtet – und das fällt
 * erst auf einem Startbildschirm auf, Wochen später. Und ein Verkleinerer, der
 * das Alpha nicht vormultipliziert, zieht einen grauen Saum um jede Kante, der
 * bei jedem Schritt breiter wird.
 *
 * # Warum die Prüfbilder hier ENTSTEHEN und nicht danebenliegen
 *
 * Weil das Logo austauschbar bleiben soll. Eine Prüfsumme über
 * `public/marke/logo.png` wäre die schärfste Prüfung und zugleich die, die
 * beim ersten Austausch rot wird – also das Gegenteil dessen, was diese Datei
 * ermöglichen soll. Die Bilder hier werden deshalb im Test selbst gebaut; vom
 * echten Logo wird nur verlangt, dass es überhaupt ein Logo ist.
 */

/** Ein PNG von Hand, mit einem WÄHLBAREN Zeilenfilter. */
function pngMitFilter(breite, hoehe, punkte, filter) {
  const kopfDaten = Buffer.alloc(13);
  kopfDaten.writeUInt32BE(breite, 0);
  kopfDaten.writeUInt32BE(hoehe, 4);
  kopfDaten[8] = 8;
  kopfDaten[9] = 6; // RGBA

  const schritt = breite * 4;
  const roh = Buffer.alloc((schritt + 1) * hoehe);
  const davor = new Uint8Array(schritt);

  for (let y = 0; y < hoehe; y += 1) {
    const an = y * (schritt + 1);
    roh[an] = filter;
    for (let i = 0; i < schritt; i += 1) {
      const wert = punkte[y * schritt + i];
      const a = i >= 4 ? punkte[y * schritt + i - 4] : 0;
      const b = davor[i];
      const c = i >= 4 ? davor[i - 4] : 0;
      let code;
      switch (filter) {
        case 0:
          code = wert;
          break;
        case 1:
          code = wert - a;
          break;
        case 2:
          code = wert - b;
          break;
        case 3:
          code = wert - ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          code = wert - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Filter ${filter} gibt es nicht.`);
      }
      roh[an + 1 + i] = code & 0xff;
    }
    for (let i = 0; i < schritt; i += 1) davor[i] = punkte[y * schritt + i];
  }

  const crcTabelle = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (bytes) => {
    let c = -1;
    for (const byte of bytes) c = crcTabelle[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const block = (art, daten) => {
    const aus = Buffer.alloc(daten.length + 12);
    aus.writeUInt32BE(daten.length, 0);
    aus.write(art, 4, 'latin1');
    daten.copy(aus, 8);
    aus.writeUInt32BE(crc(aus.subarray(4, 8 + daten.length)), 8 + daten.length);
    return aus;
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    block('IHDR', kopfDaten),
    block('IDAT', deflateSync(roh)),
    block('IEND', Buffer.alloc(0)),
  ]);
}

/** Ein Prüfbild mit Verläufen in allen vier Kanälen – jeder Filter greift daran. */
function pruefbild(breite, hoehe) {
  const punkte = new Uint8Array(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const an = (y * breite + x) * 4;
      punkte[an] = (x * 7 + y * 3) & 0xff;
      punkte[an + 1] = (x * 3 + y * 11) & 0xff;
      punkte[an + 2] = (x * 13 + y * 5) & 0xff;
      punkte[an + 3] = (x + y) % 5 === 0 ? 0 : 255;
    }
  }
  return punkte;
}

describe('PNG lesen', () => {
  it('liest alle fünf Zeilenfilter richtig', () => {
    /*
     * Die eigentliche Falle steckt in „links": Das heisst einen ganzen PUNKT
     * weiter, nicht ein Byte. Bei RGBA sind das vier Bytes. Wer eines nimmt,
     * bekommt ein Bild, das noch aussieht wie ein Bild – nur verschmiert. Ein
     * Prüfbild mit Verläufen in allen vier Kanälen zeigt das sofort; eine
     * einfarbige Fläche zeigte es nie.
     */
    const breite = 17;
    const hoehe = 11;
    const erwartet = pruefbild(breite, hoehe);
    for (const filter of [0, 1, 2, 3, 4]) {
      const gelesen = pngLesen(pngMitFilter(breite, hoehe, erwartet, filter));
      expect(gelesen.breite, `Filter ${filter}`).toBe(breite);
      expect(gelesen.hoehe, `Filter ${filter}`).toBe(hoehe);
      expect(Array.from(gelesen.punkte), `Filter ${filter}`).toEqual(Array.from(erwartet));
    }
  });

  it('kommt mit einem IDAT zurecht, das über mehrere Blöcke verteilt ist', () => {
    /*
     * Ein echtes PNG teilt seine Daten oft in Blöcke von 64 KB – so auch das
     * Logo, bevor es zugeschnitten wurde. Ein Decoder, der nur den ERSTEN
     * IDAT-Block entpackt, liefert das obere Fünftel des Bildes und darunter
     * Schwarz, ohne Fehlermeldung.
     */
    const roh = readFileSync(QUELLE);
    let bloecke = 0;
    for (let at = 8; at + 8 <= roh.length;) {
      const laenge = roh.readUInt32BE(at);
      if (roh.toString('latin1', at + 4, at + 8) === 'IDAT') bloecke += 1;
      at += 12 + laenge;
    }
    const logo = pngLesen(roh);
    expect(logo.punkte.length).toBe(logo.breite * logo.hoehe * 4);
    // Die Aussage gilt unabhängig davon, wie viele Blöcke es gerade sind.
    expect(bloecke).toBeGreaterThan(0);
  });

  it('lehnt ab, was es nicht lesen kann – mit einem Satz statt mit einem Zerrbild', () => {
    expect(() => pngLesen(Buffer.from('kein PNG'))).toThrow(/kein PNG/i);
    const kaputt = pngMitFilter(4, 4, pruefbild(4, 4), 0);
    kaputt[24] = 16; // Bittiefe im IHDR auf 16 drehen
    expect(() => pngLesen(kaputt)).toThrow(/acht Bit/i);
  });
});

describe('PNG schreiben', () => {
  it('schreibt, was sich wieder lesen lässt', () => {
    const punkte = pruefbild(9, 9);
    expect(Array.from(pngLesen(pngSchreiben(punkte, 9)).punkte)).toEqual(Array.from(punkte));
  });

  it('lässt den Alphakanal weg, wenn er nicht gewollt ist', () => {
    // iOS will ein Symbol OHNE Alphakanal. Kommt trotzdem einer, weist der
    // App Store die Einreichung zurück – und zwar erst dort.
    const gelesen = pngLesen(pngSchreiben(pruefbild(6, 6), 6, { alpha: false }));
    for (let i = 3; i < gelesen.punkte.length; i += 4) expect(gelesen.punkte[i]).toBe(255);
  });
});

describe('Verkleinern', () => {
  it('mittelt über die Fläche', () => {
    // Vier Punkte zu einem: der Mittelwert, nicht der erste.
    const punkte = new Uint8Array([
      ...[0, 0, 0, 255],
      ...[100, 100, 100, 255],
      ...[200, 200, 200, 255],
      ...[0, 0, 0, 255],
    ]);
    const klein = verkleinern(punkte, 2, 2, 1);
    expect(klein[0]).toBe(75);
    expect(klein[3]).toBe(255);
  });

  it('zieht keinen dunklen Saum aus durchsichtigen Punkten', () => {
    /*
     * Die Falle, für die es diese Prüfung gibt. Ein durchsichtiger Punkt hat
     * FARBWERTE, und die bedeuten nichts. Wer sie gleich gewichtet mitmittelt,
     * zieht den Mittelwert dorthin – bei einem Logo auf schwarzem Grund also
     * einen grauen Saum um jede Kante, der bei jedem Schritt breiter wird.
     *
     * Hier: ein weisser deckender Punkt neben drei schwarzen DURCHSICHTIGEN.
     * Richtig gerechnet bleibt die Farbe weiss und nur das Alpha sinkt auf ein
     * Viertel. Falsch gerechnet käme ein Viertelgrau heraus.
     */
    const punkte = new Uint8Array([
      ...[255, 255, 255, 255],
      ...[0, 0, 0, 0],
      ...[0, 0, 0, 0],
      ...[0, 0, 0, 0],
    ]);
    const klein = verkleinern(punkte, 2, 2, 1);
    expect(klein[0]).toBe(255);
    expect(klein[1]).toBe(255);
    expect(klein[2]).toBe(255);
    expect(klein[3]).toBe(64);
  });

  it('lässt vollständig leere Flächen leer', () => {
    const klein = verkleinern(new Uint8Array(4 * 4 * 4), 4, 4, 2);
    expect(Array.from(klein).every((wert) => wert === 0)).toBe(true);
  });
});

describe('Der Satz an Symbolen', () => {
  const logo = pngLesen(readFileSync(QUELLE));

  it('hat eine Quelle, die freigestellt ist und etwas zeigt', () => {
    /*
     * Was vom echten Logo verlangt wird – und nur das, damit es austauschbar
     * bleibt: Es muss durchsichtige Ecken haben (sonst ist die schwarze
     * Scheibe wieder da, und genau die war zu dunkel) und deckende Stellen
     * (sonst ist es leer).
     */
    expect(logo.breite).toBeGreaterThan(64);
    expect(logo.hoehe).toBeGreaterThan(64);
    const ecke = (x, y) => logo.punkte[(y * logo.breite + x) * 4 + 3];
    expect(ecke(0, 0)).toBe(0);
    expect(ecke(logo.breite - 1, 0)).toBe(0);
    expect(ecke(0, logo.hoehe - 1)).toBe(0);
    expect(ecke(logo.breite - 1, logo.hoehe - 1)).toBe(0);
    let deckend = 0;
    for (let i = 3; i < logo.punkte.length; i += 4) if (logo.punkte[i] > 200) deckend += 1;
    expect(deckend).toBeGreaterThan(logo.breite * logo.hoehe * 0.05);
  });

  it('füllt die Kachel bis an den Rand – sonst steht das Symbol in einem Kasten', () => {
    // Die gewöhnliche Kachel ist die SICHTBARE Kante des Symbols. Wäre sie
    // kleiner als die Fläche, hätte das Symbol auf dem Startbildschirm einen
    // durchsichtigen Saum, den keine Plattform wegrundet.
    const punkte = symbol(logo, { kante: 64 });
    expect(punkte[(32 * 64 + 32) * 4 + 3]).toBe(255); // Mitte
    expect(punkte[(32 * 64 + 1) * 4 + 3]).toBe(255); // linker Rand, auf halber Höhe
    expect(punkte[(1 * 64 + 1) * 4 + 3]).toBe(0); // Ecke, von der Rundung genommen
  });

  it('macht eine randlose Fläche, wo die Plattform selbst maskiert', () => {
    // Maskierbar und iOS: Dort schneidet die Plattform. Eine eigene Rundung
    // darunter ergäbe einen doppelten Rand.
    const punkte = symbol(logo, { kante: 64, kachel: false });
    expect(punkte[(1 * 64 + 1) * 4 + 3]).toBe(255);
  });

  it('hält das maskierbare Symbol im sicheren Kreis', () => {
    /*
     * Android darf bei einer maskierbaren Kachel alles ausserhalb des inneren
     * Kreises (80 % der Kante) abschneiden. Geprüft wird deshalb nicht die
     * Ecke, sondern der RAND DES KREISES: Was dort noch deckend ist, kann
     * weggeschnitten werden.
     */
    const kante = 128;
    /*
     * Geprüft wird das LOGO allein, nicht die Kachel darunter – die darf und
     * soll bis in die Ecken gehen. `nurUmriss` liefert genau das: den
     * Alphakanal des Logos, ohne Untergrund.
     *
     * Ein erster Versuch hat stattdessen geraten, welche Punkte zur Kachel
     * gehören („ungefähr grau"), und zählte die Kachel selbst mit. Er schlug
     * fehl, obwohl nichts falsch war.
     */
    const punkte = symbol(logo, { kante, nurUmriss: true, anteil: 0.62 });
    const mitte = kante / 2;
    const sicher = kante * 0.4;
    let draussen = 0;
    for (let y = 0; y < kante; y += 1) {
      for (let x = 0; x < kante; x += 1) {
        if (Math.hypot(x + 0.5 - mitte, y + 0.5 - mitte) <= sicher) continue;
        if (punkte[(y * kante + x) * 4 + 3] > 8) draussen += 1;
      }
    }
    expect(draussen).toBe(0);
  });

  it('macht aus dem Umriss eine weisse Silhouette ohne Untergrund', () => {
    // Die Android-Statusleiste färbt das Bild selbst ein und wertet nur den
    // Alphakanal aus. Ein Untergrund darunter wäre ein weisses Quadrat.
    const kante = 64;
    const punkte = symbol(logo, { kante, nurUmriss: true, anteil: 0.94 });
    expect(punkte[0 * 4 + 3]).toBe(0);
    let gesetzt = 0;
    for (let i = 0; i < kante * kante; i += 1) {
      if (punkte[i * 4 + 3] > 0) {
        gesetzt += 1;
        expect(punkte[i * 4]).toBe(255);
        expect(punkte[i * 4 + 1]).toBe(255);
        expect(punkte[i * 4 + 2]).toBe(255);
      }
    }
    expect(gesetzt).toBeGreaterThan(0);
  });

  it('schreibt das Symbol für iOS ohne Alphakanal', () => {
    // Steht in der Auftragsliste, damit niemand es beim Umbauen verliert.
    const ios = AUFTRAEGE.find((auftrag) => auftrag.datei === 'apple-touch-icon.png');
    expect(ios?.alpha).toBe(false);
    expect(ios?.kachel).toBe(false);
  });
});
