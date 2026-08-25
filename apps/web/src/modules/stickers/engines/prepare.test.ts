import { describe, expect, it } from 'vitest';
import { flaechenMittel, kanteWeichzeichnen, maskeTraegt } from './prepare.js';
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

describe('Verkleinern als Flaechenmittel', () => {
  /** Ein Bild aus einer Funktion bauen – ohne Browser. */
  function bild(breite: number, hoehe: number, farbe: (x: number, y: number) => number[]) {
    const data = new Uint8ClampedArray(breite * hoehe * 4);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const [r, g, b, a] = farbe(x, y);
        const at = (y * breite + x) * 4;
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = a;
      }
    }
    return { width: breite, height: hoehe, data };
  }

  it('mittelt, statt Punkte herauszugreifen', () => {
    // Ein Schachbrett aus 1x1-Feldern: Beim Herausgreifen einzelner Punkte
    // kaeme entweder ganz Schwarz oder ganz Weiss heraus. Richtig ist Grau.
    const gross = bild(64, 64, (x, y) => [
      (x + y) % 2 ? 255 : 0,
      (x + y) % 2 ? 255 : 0,
      (x + y) % 2 ? 255 : 0,
      255,
    ]);
    const klein = flaechenMittel(gross, 8);

    expect(klein.width).toBe(8);
    expect(klein.height).toBe(8);
    for (let i = 0; i < klein.data.length; i += 4) {
      expect(klein.data[i]).toBeGreaterThan(100);
      expect(klein.data[i]).toBeLessThan(155);
    }
  });

  it('verliert eine duenne Linie nicht vollstaendig', () => {
    // Genau der Fall, um den es geht: eine Struktur, die duenner ist als der
    // Abstand zweier Abtastpunkte. Beim Herausgreifen verschwindet sie ganz -
    // hier muss sie als hellerer Streifen ueberleben.
    const gross = bild(320, 320, (x) => (x === 137 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const klein = flaechenMittel(gross, 32);

    const spalte = Math.floor((137 / 320) * 32);
    const wert = klein.data[(16 * 32 + spalte) * 4];
    expect(wert).toBeGreaterThan(0);

    // Und der Rest der Zeile bleibt dunkel - es wird nicht alles aufgehellt.
    const woanders = klein.data[(16 * 32 + 0) * 4];
    expect(woanders).toBe(0);
  });

  it('sieht jeden Quellpunkt genau einmal', () => {
    // Ein Verlauf: Der Mittelwert des verkleinerten Bildes muss dem des
    // Originals entsprechen. Beim Herausgreifen waere er zufaellig daneben.
    const breite = 300;
    const gross = bild(breite, 4, (x) => [Math.round((x / (breite - 1)) * 255), 0, 0, 255]);
    const klein = flaechenMittel(gross, 4);

    const mittel = (b: { data: Uint8ClampedArray }) => {
      let summe = 0;
      let n = 0;
      for (let i = 0; i < b.data.length; i += 4) {
        summe += b.data[i];
        n += 1;
      }
      return summe / n;
    };
    expect(mittel(klein)).toBeCloseTo(mittel(gross), 0);
  });

  it('kommt auch mit Vergroessern zurecht', () => {
    // Kein Anwendungsfall, aber es darf nicht abstuerzen oder leer liefern.
    const klein = bild(2, 2, () => [200, 100, 50, 255]);
    const gross = flaechenMittel(klein, 8);
    expect(gross.width).toBe(8);
    expect(gross.data[0]).toBe(200);
    expect(gross.data[gross.data.length - 2]).toBe(50);
  });
});
