import { describe, expect, it } from 'vitest';
import {
  briefkasten,
  flaechenMittel,
  kanteWeichzeichnen,
  maskeSkalieren,
  maskeTraegt,
  type Bildpunkte,
} from './prepare.js';
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

describe('maskeSkalieren', () => {
  it('gibt ein Gitter unveraendert zurueck, wenn nichts zu skalieren ist', () => {
    const werte = new Float32Array([0, 0.5, 1, 0.25]);
    const alpha = maskeSkalieren(werte, 2, 2, 2);
    expect(Array.from(alpha)).toEqual([0, 128, 255, 64]);
  });

  it('legt einen Verlauf zwischen die Stuetzstellen, statt zu springen', () => {
    // Links 0, rechts 1. Bei Blockkopie waere die linke Haelfte 0 und die
    // rechte 255 – eine Stufe. Bilinear muss es dazwischen Werte geben.
    const werte = new Float32Array([0, 1, 0, 1]);
    const alpha = maskeSkalieren(werte, 2, 8, 1);
    const zeile = Array.from(alpha);
    expect(zeile[0]).toBe(0);
    expect(zeile[7]).toBe(255);
    // Streng monoton steigend – kein Sprung, keine Delle.
    for (let i = 1; i < zeile.length; i += 1) {
      expect(zeile[i]).toBeGreaterThanOrEqual(zeile[i - 1]);
    }
    // Und in der Mitte wirklich Zwischenwerte, nicht nur 0 und 255.
    expect(zeile.filter((w) => w > 10 && w < 245).length).toBeGreaterThan(2);
  });

  it('verschiebt die Maske nicht gegen das Bild', () => {
    // Ein symmetrisches Gitter muss symmetrisch bleiben. Rechnet man auf
    // Punktkanten statt Punktmitten, wandert alles um einen halben Punkt.
    const kante = 4;
    const werte = new Float32Array(kante * kante);
    for (let y = 0; y < kante; y += 1) {
      for (let x = 0; x < kante; x += 1) {
        werte[y * kante + x] = x === 1 || x === 2 ? 1 : 0;
      }
    }
    const breite = 16;
    const alpha = maskeSkalieren(werte, kante, breite, 1);
    for (let x = 0; x < breite / 2; x += 1) {
      expect(alpha[x]).toBe(alpha[breite - 1 - x]);
    }
  });

  it('haelt sich an die Raender, ohne daneben zu greifen', () => {
    const werte = new Float32Array([1, 1, 1, 1]);
    const alpha = maskeSkalieren(werte, 2, 5, 5);
    expect(Array.from(alpha).every((w) => w === 255)).toBe(true);
  });

  it('bleibt in 0…255, auch bei Werten ausserhalb von 0…1', () => {
    const werte = new Float32Array([-0.4, 1.7, -2, 3]);
    const alpha = maskeSkalieren(werte, 2, 6, 6);
    expect(Array.from(alpha).every((w) => w >= 0 && w <= 255)).toBe(true);
  });
});

describe('briefkasten – die Einbettung fuer SAM', () => {
  function bild(w: number, h: number, farbe = 200): Bildpunkte {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = farbe;
      data[i * 4 + 1] = farbe;
      data[i * 4 + 2] = farbe;
      data[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data };
  }

  it('bringt die LAENGERE Kante auf die Kantenlaenge, nicht beide', () => {
    // Ein Querformat: die Breite fuellt aus, die Hoehe bleibt darunter.
    const { breite, hoehe } = briefkasten(bild(900, 600), 512);
    expect(breite).toBe(512);
    expect(hoehe).toBe(341);
  });

  it('verzerrt das Seitenverhaeltnis nicht', () => {
    const { breite, hoehe } = briefkasten(bild(600, 900), 512);
    expect(hoehe).toBe(512);
    expect(breite / hoehe).toBeCloseTo(600 / 900, 2);
  });

  it('legt das Bild oben links und laesst den Rest auf null', () => {
    const kante = 64;
    const { tensor, breite, hoehe } = briefkasten(bild(120, 60, 200), kante);
    const flaeche = kante * kante;
    // Innerhalb des belegten Bereichs steht die Farbe …
    expect(tensor[0]).toBeCloseTo(200, 0);
    expect(tensor[(hoehe - 1) * kante + (breite - 1)]).toBeCloseTo(200, 0);
    // … und ausserhalb wirklich null, in allen drei Kanaelen.
    for (let k = 0; k < 3; k += 1) {
      expect(tensor[k * flaeche + hoehe * kante]).toBe(0);
      expect(tensor[k * flaeche + flaeche - 1]).toBe(0);
    }
  });

  it('liefert Werte in 0…255 – die Normalisierung steckt im Modell', () => {
    const { tensor } = briefkasten(bild(80, 40, 255), 32);
    expect(Math.max(...tensor)).toBeLessThanOrEqual(255);
    expect(Math.min(...tensor)).toBeGreaterThanOrEqual(0);
  });
});
