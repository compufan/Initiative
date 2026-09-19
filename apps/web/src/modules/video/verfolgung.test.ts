import { describe, expect, it } from 'vitest';

import { BLOCK, bewegung, graustufen, maskeSchieben, zeitlichGlaetten } from './verfolgung.js';

/**
 * Die Bewegungsschätzung.
 *
 * Geprüft wird gegen SELBST GESCHOBENE Bilder: Ein Muster wird um einen
 * bekannten Betrag versetzt, und die Schätzung muss genau diesen Betrag
 * finden. Das ist die einzige Art von Prüfung, die hier etwas wert ist – an
 * einem echten Video liesse sich nur sagen „sieht plausibel aus".
 */

/** Ein Bild mit Struktur, verschoben um (vx, vy). Ausserhalb: Grau. */
function muster(kante: number, vx = 0, vy = 0): ImageData {
  const daten = new Uint8ClampedArray(kante * kante * 4);
  for (let y = 0; y < kante; y += 1) {
    for (let x = 0; x < kante; x += 1) {
      const qx = x - vx;
      const qy = y - vy;
      const at = (y * kante + x) * 4;
      daten[at + 3] = 255;
      if (qx < 0 || qy < 0 || qx >= kante || qy >= kante) {
        daten[at] = 128;
        daten[at + 1] = 128;
        daten[at + 2] = 128;
        continue;
      }
      /*
       * Zwei Sinus mit unrunden Perioden: Das ergibt ein Muster, das sich
       * innerhalb des Suchbereichs nicht wiederholt. Ein Schachbrett täte es
       * NICHT – dort passt jeder Versatz um ein Vielfaches der Feldbreite
       * genauso gut, und die Schätzung hätte die Wahl zwischen mehreren
       * gleich guten Antworten.
       */
      const wert = 128 + 90 * Math.sin(qx / 3.7) * Math.cos(qy / 5.3);
      daten[at] = wert;
      daten[at + 1] = wert;
      daten[at + 2] = wert;
    }
  }
  return { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
}

describe('graustufen', () => {
  it('gewichtet nach dem, was das Auge sieht', () => {
    /*
     * Ungewichtet bekämen kräftiges Rot und kräftiges Grün denselben Grauwert
     * – und ein Pullover vor einer Hecke wäre für den Blockvergleich
     * unsichtbar.
     */
    const bild = (r: number, g: number, b: number): ImageData =>
      ({
        data: new Uint8ClampedArray([r, g, b, 255]),
        width: 1,
        height: 1,
        colorSpace: 'srgb',
      }) as ImageData;
    const rot = graustufen(bild(255, 0, 0)).werte[0];
    const gruen = graustufen(bild(0, 255, 0)).werte[0];
    const blau = graustufen(bild(0, 0, 255)).werte[0];
    expect(gruen).toBeGreaterThan(rot);
    expect(rot).toBeGreaterThan(blau);
  });

  it('verkleinert auf die vorgegebene Kante', () => {
    const klein = graustufen(muster(256), 128);
    expect(klein.breite).toBe(128);
    expect(klein.hoehe).toBe(128);
  });

  it('lässt ein kleines Bild in Ruhe', () => {
    // Hochrechnen brächte keine Struktur dazu, kostete aber das Vierfache im
    // Blockvergleich.
    const klein = graustufen(muster(64), 128);
    expect(klein.breite).toBe(64);
  });

  it('mittelt, statt Punkte wegzuwerfen', () => {
    /*
     * Ein Bild aus abwechselnd Schwarz und Weiss muss beim Halbieren zu Grau
     * werden. Wer nur jeden zweiten Punkt nimmt, bekommt je nach Startpunkt
     * ganz Schwarz oder ganz Weiss – und die Bewegungsschätzung sähe eine
     * Bewegung, wo keine ist.
     */
    const kante = 16;
    const daten = new Uint8ClampedArray(kante * kante * 4);
    for (let i = 0; i < kante * kante; i += 1) {
      const hell = (i % 2 === 0 ? 255 : 0) as number;
      daten[i * 4] = hell;
      daten[i * 4 + 1] = hell;
      daten[i * 4 + 2] = hell;
      daten[i * 4 + 3] = 255;
    }
    const bild = { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
    for (const wert of graustufen(bild, 8).werte) expect(wert).toBeCloseTo(127.5, 0);
  });
});

describe('bewegung', () => {
  it('findet einen bekannten Versatz', () => {
    /*
     * Der Kern der Sache. Verschoben wird um (5, −3); gefunden werden muss der
     * Weg ZURÜCK, also (−5, 3) – die Vektoren zeigen vom neuen Bild ins alte.
     */
    const alt = graustufen(muster(128));
    const neu = graustufen(muster(128, 5, -3));
    const feld = bewegung(alt, neu, 128);

    // Am Rand ragt der gesuchte Block aus dem Bild; geprüft wird die Mitte.
    const mitte = Math.floor(feld.zeilen / 2) * feld.spalten + Math.floor(feld.spalten / 2);
    expect(feld.dx[mitte]).toBe(-5);
    expect(feld.dy[mitte]).toBe(3);
  });

  it('bleibt bei Stillstand bei null', () => {
    const gleich = graustufen(muster(128));
    const feld = bewegung(gleich, graustufen(muster(128)), 128);
    for (let i = 0; i < feld.dx.length; i += 1) {
      expect(feld.dx[i], `Block ${i}`).toBe(0);
      expect(feld.dy[i], `Block ${i}`).toBe(0);
    }
  });

  it('erfindet in einer glatten Fläche keine Bewegung', () => {
    /*
     * Der Grund für den Aufschlag je Punkt Bewegung. Auf einer einfarbigen
     * Fläche ist die Abweichung für JEDEN Versatz null; ohne Aufschlag gewänne
     * der zuerst geprüfte – und die Maske zappelte in einer Gegend, in der
     * sich nachweislich nichts bewegt.
     */
    const kante = 64;
    const daten = new Uint8ClampedArray(kante * kante * 4).fill(200);
    const flach = { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
    const feld = bewegung(graustufen(flach), graustufen(flach), kante);
    for (let i = 0; i < feld.dx.length; i += 1) {
      expect(feld.dx[i] === 0 && feld.dy[i] === 0, `Block ${i}`).toBe(true);
    }
  });

  it('verweigert Bilder verschiedener Grösse', () => {
    // Sonst läse der Vergleich an falschen Stellen und lieferte Unsinn, der
    // sich als Zappeln zeigt – nicht als Fehler.
    expect(() => bewegung(graustufen(muster(128)), graustufen(muster(64)), 128)).toThrow();
  });

  it('rechnet den Massstab zum Vollbild mit', () => {
    // Die Vektoren zählen in Graupunkten; wer sie ohne diesen Faktor auf die
    // Maske anwendet, schiebt um ein Vielfaches zu wenig.
    const feld = bewegung(graustufen(muster(512), 128), graustufen(muster(512), 128), 512);
    expect(feld.faktor).toBe(4);
  });
});

describe('maskeSchieben', () => {
  /** Eine Maske mit einem weissen Rechteck. */
  function maske(breite: number, hoehe: number, x0: number, y0: number, w: number, h: number) {
    const raus = new Uint8Array(breite * hoehe);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) raus[y * breite + x] = 255;
    }
    return raus;
  }

  /** Der Schwerpunkt der gesetzten Punkte – so wird die Verschiebung messbar. */
  function schwerpunkt(alpha: Uint8Array, breite: number) {
    let sx = 0;
    let sy = 0;
    let summe = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      const wert = alpha[i];
      if (wert === 0) continue;
      sx += (i % breite) * wert;
      sy += Math.floor(i / breite) * wert;
      summe += wert;
    }
    return { x: sx / summe, y: sy / summe, summe };
  }

  it('schiebt die Maske dorthin, wo sich das Motiv hinbewegt hat', () => {
    /*
     * Das Bild wandert um (5, −3), die Maske muss mitwandern. Der Schwerpunkt
     * ist das ehrliche Mass: Er bewegt sich genau dann mit, wenn die ganze
     * Fläche mitgeht, nicht nur ein Rand.
     */
    const kante = 128;
    const alt = graustufen(muster(kante));
    const neu = graustufen(muster(kante, 5, -3));
    const feld = bewegung(alt, neu, kante);

    const vorher = maske(kante, kante, 40, 40, 48, 48);
    const nachher = maskeSchieben(vorher, kante, kante, feld);
    const a = schwerpunkt(vorher, kante);
    const b = schwerpunkt(nachher, kante);
    expect(b.x - a.x).toBeCloseTo(5, 0);
    expect(b.y - a.y).toBeCloseTo(-3, 0);
  });

  it('lässt die Maske bei Stillstand, wo sie ist', () => {
    const kante = 64;
    const stand = graustufen(muster(kante));
    const feld = bewegung(stand, stand, kante);
    const vorher = maske(kante, kante, 20, 20, 24, 24);
    expect(Array.from(maskeSchieben(vorher, kante, kante, feld))).toEqual(Array.from(vorher));
  });

  it('zieht am Bildrand keinen Streifen hinter sich her', () => {
    /*
     * Was von ausserhalb käme, war nie freigestellt. Den Randwert
     * fortzuschreiben wäre bequemer und ergäbe bei einem Schwenk einen
     * Streifen, der über das halbe Bild wächst.
     */
    const kante = 64;
    const feld = {
      spalten: 1,
      zeilen: 1,
      dx: Float32Array.from([-8]),
      dy: Float32Array.from([0]),
      faktor: 1,
      grauBreite: kante,
      grauHoehe: kante,
    };
    const voll = new Uint8Array(kante * kante).fill(255);
    const geschoben = maskeSchieben(voll, kante, kante, feld);
    /*
     * Der Vektor zeigt zurück: −8 heisst „was hier steht, stand vorher acht
     * Punkte weiter links". Der Inhalt ist also nach RECHTS gewandert, und am
     * linken Rand kam nichts nach.
     */
    for (let y = 0; y < kante; y += 1) {
      expect(geschoben[y * kante], `Zeile ${y} links`).toBe(0);
      expect(geschoben[y * kante + (kante - 1)], `Zeile ${y} rechts`).toBe(255);
    }
  });

  it('mischt die Nachbarn, statt den nächsten zu nehmen', () => {
    /*
     * Bei einem halben Punkt Versatz muss aus 0 und 255 etwas dazwischen
     * werden. Der nächste Nachbar machte aus jedem weichen Rand nach drei
     * Bildern eine Treppe.
     */
    const kante = 32;
    const feld = {
      spalten: 1,
      zeilen: 1,
      dx: Float32Array.from([0.5]),
      dy: Float32Array.from([0]),
      faktor: 1,
      grauBreite: kante,
      grauHoehe: kante,
    };
    const kante_ = new Uint8Array(kante * kante);
    for (let y = 0; y < kante; y += 1) {
      for (let x = 16; x < kante; x += 1) kante_[y * kante + x] = 255;
    }
    const geschoben = maskeSchieben(kante_, kante, kante, feld);
    const zwischenwerte = Array.from(geschoben).filter((wert) => wert > 0 && wert < 255);
    expect(zwischenwerte.length).toBeGreaterThan(0);
  });

  it('bleibt ein Block gross, auch wenn das Bild kein Vielfaches davon ist', () => {
    // 100 ist kein Vielfaches von 16. Ohne Aufrunden bliebe rechts ein
    // Streifen ohne Vektor, und die Maske risse dort ab.
    const feld = bewegung(graustufen(muster(100)), graustufen(muster(100)), 100);
    expect(feld.spalten).toBe(Math.ceil(100 / BLOCK));
  });
});

describe('zeitlichGlaetten', () => {
  it('nimmt einen einzelnen Ausreisser heraus', () => {
    /*
     * Genau der Fall, um den es geht: Das Netz trifft in einem Bild von
     * dreien daneben. Ungeglättet blitzt dort ein Loch auf.
     */
    const voll = () => new Uint8Array([255, 255]);
    const loch = new Uint8Array([0, 0]);
    const geglaettet = zeitlichGlaetten([voll(), loch, voll()]);
    expect(geglaettet[1][0]).toBeGreaterThan(100);
    expect(geglaettet[1][0]).toBeLessThan(255);
  });

  it('lässt eine ruhige Folge unverändert', () => {
    // Sonst kostete das Glätten bei einer Einstellung ohne Bewegung Schärfe,
    // ohne irgendetwas zu gewinnen.
    const folge = [new Uint8Array([200, 10]), new Uint8Array([200, 10]), new Uint8Array([200, 10])];
    for (const maske of zeitlichGlaetten(folge)) expect(Array.from(maske)).toEqual([200, 10]);
  });

  it('kommt mit dem ersten und dem letzten Bild zurecht', () => {
    // Am Rand gibt es nur einen Nachbarn. Wer dort über ein halb leeres
    // Fenster mittelt, macht den ersten Rand blasser als alle anderen.
    const folge = [new Uint8Array([255]), new Uint8Array([255]), new Uint8Array([255])];
    const geglaettet = zeitlichGlaetten(folge);
    expect(geglaettet[0][0]).toBe(255);
    expect(geglaettet[2][0]).toBe(255);
  });

  it('gibt bei Fenster eins Kopien zurück und nicht dieselben Felder', () => {
    // Sonst schriebe ein späterer Schritt in die Masken, die der Aufrufer
    // noch hält.
    const urbild = new Uint8Array([7]);
    const raus = zeitlichGlaetten([urbild], 1);
    expect(raus[0]).not.toBe(urbild);
    expect(raus[0][0]).toBe(7);
  });

  it('kommt mit gar nichts zurecht', () => {
    expect(zeitlichGlaetten([])).toEqual([]);
  });
});
