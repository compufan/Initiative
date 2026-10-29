import { describe, expect, it } from 'vitest';
import {
  ARBEITSSPEICHER_MAX,
  BOKEH_MAX,
  GUETEN,
  abtastungenJeBildpunkt,
  arbeitsFaktor,
  bokehRadiusPx,
  filmGuete,
  kernGewicht,
  linienAnzahl,
  lichtGewicht,
  reglerWert,
  staerke,
  stufenAnzahl,
  unscharfAufBytes,
  unscharfEbenen,
  weichSigmaPx,
  type StufenGuete,
  type UnscharfQuelle,
} from './unscharf.js';
import type { Reinheit } from './maskenSpeicher.js';

/** Ein Bild aus einer Funktion, drei Kanäle gleich oder je Kanal. */
function bild(
  breite: number,
  hoehe: number,
  farbe: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const [r, g, b] = farbe(x, y);
      const at = (y * breite + x) * 4;
      daten[at] = r;
      daten[at + 1] = g;
      daten[at + 2] = b;
      daten[at + 3] = 255;
    }
  }
  return daten;
}

function maskeAus(breite: number, hoehe: number, wert: (x: number, y: number) => number) {
  const m = new Uint8Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1)
    for (let x = 0; x < breite; x += 1) m[y * breite + x] = Math.round(wert(x, y));
  return m;
}

function quelle(
  maske: Uint8Array,
  bokehPx: number,
  weichPx: number,
  reinheit: Reinheit = 1,
  kern: Uint8Array | null = null,
): UnscharfQuelle {
  return { ebene: { platz: 0, bokehPx, weichPx, reinheit }, maske, kern };
}

const lies = (d: Uint8ClampedArray, breite: number, x: number, y: number, k = 0) =>
  d[(y * breite + x) * 4 + k];

describe('Reglerwerte', () => {
  it('lässt nur Zahlen von 0 bis 1 durch', () => {
    expect(reglerWert(0.4)).toBe(0.4);
    expect(reglerWert(0)).toBe(0);
    expect(reglerWert(1)).toBe(1);
    expect(reglerWert(7)).toBe(1);
    expect(reglerWert(-2)).toBe(0);
    // Nicht endlich heisst: aus. Auch unendlich – ein Unendlich als „ganz“ zu
    // lesen hiesse, einer kaputten Datei den grössten Radius zu geben.
    expect(reglerWert(Number.NaN)).toBe(0);
    expect(reglerWert(Number.POSITIVE_INFINITY)).toBe(0);
    expect(reglerWert(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(reglerWert('viel')).toBe(0);
    expect(reglerWert(undefined)).toBe(0);
  });

  it('bemisst den Radius an der Bildkante, damit Vorschau und Ausgabe gleich aussehen', () => {
    expect(bokehRadiusPx(1, 1200)).toBeCloseTo(24, 9);
    expect(bokehRadiusPx(1, 2560)).toBeCloseTo(51.2, 9);
    expect(bokehRadiusPx(0.5, 2560) / 2560).toBeCloseTo(bokehRadiusPx(0.5, 1200) / 1200, 9);
    expect(weichSigmaPx(1, 1200)).toBeCloseTo(14.4, 9);
  });

  it('deckelt den Radius der Ausgabe und lässt Zwergradien weg', () => {
    expect(bokehRadiusPx(1, 100000)).toBe(BOKEH_MAX);
    // Unter einem dreiviertel Bildpunkt wäre die Scheibe schmaler als ein Punkt.
    expect(bokehRadiusPx(0.02, 1200)).toBe(0);
    expect(weichSigmaPx(0.02, 1200)).toBe(0);
    expect(bokehRadiusPx(Number.NaN, 1200)).toBe(0);
    expect(bokehRadiusPx(-1, 1200)).toBe(0);
    expect(weichSigmaPx(Number.POSITIVE_INFINITY, 1200)).toBe(0);
  });
});

describe('Stärke und Kern', () => {
  it('lässt den Staub einer Netzmaske weg', () => {
    // Das Dunstniveau der Netze: bis 12 von 255.
    for (let v = 0; v <= 15; v += 1) {
      expect(staerke(v / 255, v / 255, 0), `Maske ${v}`).toBe(0);
    }
  });

  it('strafft den Saum einer Silhouette zur Mitte hin', () => {
    // Ohne Straffung wäre die Stärke gleich der Maske (bis auf die Ränder).
    expect(staerke(0.2, 0.2, 0)).toBe(0);
    expect(staerke(0.5, 0.5, 0)).toBeLessThan(0.3);
    expect(staerke(0.64, 0.64, 0)).toBeGreaterThan(0.45);
    expect(staerke(0.64, 0.64, 0)).toBeLessThan(0.55);
    expect(staerke(0.9, 0.9, 0)).toBeGreaterThan(0.9);
    expect(staerke(0.97, 0.97, 0)).toBe(1);
    // Monoton: Eine Kante hat keine Delle.
    let vorher = -1;
    for (let v = 0; v <= 255; v += 1) {
      const s = staerke(v / 255, v / 255, 0);
      expect(s).toBeGreaterThanOrEqual(vorher);
      vorher = s;
    }
  });

  it('wirkt bei glatten Masken ohne Straffung und mit Kern für alles', () => {
    expect(staerke(0.5, 0.5, 1)).toBeCloseTo(0.5, 9);
    expect(staerke(0.1, 0.1, 1)).toBeGreaterThan(0);
    expect(kernGewicht(0.1, 1)).toBe(1);
  });

  it('zählt im Saum nicht als Quelle, im Kern voll', () => {
    expect(kernGewicht(0.3, 0)).toBe(0);
    expect(kernGewicht(0.5, 0)).toBe(0);
    expect(kernGewicht(0.7, 0)).toBeGreaterThan(0);
    expect(kernGewicht(0.7, 0)).toBeLessThan(1);
    expect(kernGewicht(0.95, 0)).toBe(1);
  });

  it('nimmt bei gemischter Maske den Kernwert, nicht die Maske', () => {
    // Tiefe `dazu`, Netz `weg`: die Maske ist hoch, der Kern null (im Motiv).
    expect(staerke(0.9, 0, 2)).toBe(0);
    expect(staerke(0.9, 1, 2)).toBeGreaterThan(0.9);
  });

  it('verstärkt helle Stellen, dunkle nicht', () => {
    expect(lichtGewicht(0.2)).toBe(1);
    expect(lichtGewicht(0.6)).toBe(1);
    expect(lichtGewicht(1)).toBeCloseTo(101, 9);
    expect(lichtGewicht(0.8)).toBeGreaterThan(1);
    expect(lichtGewicht(0.8)).toBeLessThan(101);
  });
});

describe('Arbeitsmassstab und Güte', () => {
  it('wählt den Massstab so, dass der Radius in die Grenze passt', () => {
    expect(arbeitsFaktor(24, 12, 1200, 900)).toBe(2);
    expect(arbeitsFaktor(24, 8, 1200, 900)).toBe(4);
    expect(arbeitsFaktor(24, 4, 1200, 900)).toBe(8);
    expect(arbeitsFaktor(3, 12, 600, 450)).toBe(1);
    // Nie über 8, auch wenn die Grenze nicht zu halten ist.
    expect(arbeitsFaktor(96, 1, 1200, 900)).toBe(8);
  });

  it('verdoppelt den Massstab, wenn die Arbeitsfelder nicht in den Speicher passen', () => {
    const f1 = arbeitsFaktor(3, 12, 600, 450);
    expect(f1).toBe(1);
    // 1200 × 900 bei f = 1 wären 43 MB und damit schon zu viel.
    expect(arbeitsFaktor(3, 12, 1200, 900)).toBe(2);
    // 6000 × 4000 bei f = 1 sind 24 Mio. Arbeitspunkte à 40 Byte.
    const gross = arbeitsFaktor(3, 12, 6000, 4000);
    expect(gross).toBeGreaterThan(1);
    expect(Math.ceil(6000 / gross) * Math.ceil(4000 / gross) * 40).toBeLessThanOrEqual(
      ARBEITSSPEICHER_MAX,
    );
    for (const f of [f1, gross]) expect(Math.log2(f)).toBe(Math.round(Math.log2(f)));
  });

  it('gibt Glatt mehr Stufen als der Silhouette, und niedriger weniger', () => {
    for (const g of ['hoch', 'mittel', 'niedrig'] as StufenGuete[]) {
      expect(stufenAnzahl(0, g)).toBe(GUETEN[g].stufenSilhouette);
      expect(stufenAnzahl(1, g)).toBe(GUETEN[g].stufenGlatt);
      expect(stufenAnzahl(2, g)).toBe(GUETEN[g].stufenGlatt);
      expect(GUETEN[g].stufenGlatt).toBeGreaterThan(GUETEN[g].stufenSilhouette);
    }
    expect(stufenAnzahl(1, 'hoch')).toBeGreaterThan(stufenAnzahl(1, 'niedrig'));
  });

  it('lässt die Filmvorschau eine Güte tiefer rechnen, wenn viele Bereiche unscharf sind', () => {
    // Volle Grösse bekommt „mittel“, die kleinere Stufe „niedrig“ …
    expect(filmGuete(0, 1)).toBe('mittel');
    expect(filmGuete(1, 1)).toBe('niedrig');
    expect(filmGuete(2, 1)).toBe('niedrig');
    // … und mehr als zwei Bereiche mit Unschärfe kosten die volle Grösse die Güte.
    expect(filmGuete(0, 2)).toBe('mittel');
    expect(filmGuete(0, 3)).toBe('niedrig');
    expect(filmGuete(0, 4)).toBe('niedrig');
  });

  it('tastet jede Strecke mindestens einmal und höchstens 63-mal ab', () => {
    expect(linienAnzahl(0.1, 0.5)).toBe(1);
    expect(linienAnzahl(8, 1)).toBe(8);
    expect(linienAnzahl(8, 0.5)).toBe(4);
    expect(linienAnzahl(500, 1)).toBe(63);
  });

  it('hält die Abtastungen je Bildpunkt im Budget (Silhouette, Radius 24 bei 1200 Punkten)', () => {
    /*
     * Das ist der Massstab für „läuft auf dem Telefon“: Die Kosten sind
     * abtastungsgebunden. Heute waren es rund 96 Abtastungen und 48 Mal
     * sin/cos/sqrt/pow je Bildpunkt.
     */
    const hoch = abtastungenJeBildpunkt('bokeh', 24, 'hoch', 0);
    const mittel = abtastungenJeBildpunkt('bokeh', 24, 'mittel', 0);
    const niedrig = abtastungenJeBildpunkt('bokeh', 24, 'niedrig', 0);
    expect(hoch).toBeLessThanOrEqual(45);
    expect(mittel).toBeLessThanOrEqual(20);
    expect(niedrig).toBeLessThanOrEqual(12);
    expect(mittel).toBeLessThan(hoch);
    expect(niedrig).toBeLessThanOrEqual(mittel);
    // Weichzeichnen ist billiger als jede Scheibe.
    expect(abtastungenJeBildpunkt('weich', 14.4, 'mittel', 1)).toBeLessThan(mittel);
  });
});

describe('unscharfEbenen', () => {
  const maske = { kern: undefined };
  const ton = (unschaerfe: number, bokeh: number) => ({ unschaerfe, bokeh });

  it('lässt Bereiche ohne Wirkung weg und behält den Platz im Atlas', () => {
    const e = unscharfEbenen(
      [
        { anpassung: ton(0, 0), maske },
        { anpassung: ton(0, 0.5), maske },
        { anpassung: ton(0.5, 0), maske },
      ],
      1200,
      900,
    );
    expect(e.map((x) => x.platz)).toEqual([1, 2]);
    expect(e[0].bokehPx).toBeCloseTo(12, 9);
    expect(e[0].weichPx).toBe(0);
    expect(e[1].weichPx).toBeCloseTo(7.2, 9);
    expect(e[1].bokehPx).toBe(0);
  });

  it('sieht bei Unsinn gar nichts', () => {
    const e = unscharfEbenen(
      [
        { anpassung: ton(Number.NaN, Number.POSITIVE_INFINITY), maske },
        { anpassung: ton(-1, -1), maske },
      ],
      1200,
      900,
    );
    expect(e).toEqual([]);
  });

  it('liest eine gemischte Maske ohne Kernfeld als Silhouette', () => {
    const e = unscharfEbenen([{ anpassung: ton(0, 1), reinheit: 2, maske }], 100, 100);
    expect(e[0].reinheit).toBe(0);
    const k = unscharfEbenen(
      [{ anpassung: ton(0, 1), reinheit: 2, maske: { kern: new Uint8Array(1) } }],
      100,
      100,
    );
    expect(k[0].reinheit).toBe(2);
    // Ohne Angabe: glatt.
    expect(unscharfEbenen([{ anpassung: ton(0, 1), maske }], 100, 100)[0].reinheit).toBe(1);
  });
});

describe('Bokeh auf dem Prozessor', () => {
  const B = 160;
  const H = 120;

  /** Ein heller Punkt (3 × 3) auf dunklem Grund. */
  const licht = () =>
    bild(B, H, (x, y) =>
      Math.abs(x - 80) <= 1 && Math.abs(y - 60) <= 1 ? [255, 255, 255] : [10, 10, 10],
    );

  it('macht aus einem Lichtpunkt eine Scheibe mit Kante', () => {
    // Ein einzelner Punkt, damit die Fläche ohne Zuschlag für die Grösse der
    // Quelle gelten kann.
    const daten = bild(B, H, (x, y) => (x === 80 && y === 60 ? [255, 255, 255] : [10, 10, 10]));
    const R = 12;
    unscharfAufBytes(daten, B, H, [quelle(new Uint8Array(B * H).fill(255), R, 0)], 'hoch');
    const innen: number[] = [];
    let ueberHalb = 0;
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < B; x += 1) {
        const v = lies(daten, B, x, y);
        const d = Math.hypot(x - 80, y - 60);
        if (d <= R * 0.7) innen.push(v);
        if (v > 60) ueberHalb += 1;
      }
    // Flach: Die Mitte ragt nicht heraus – eine Scheibe, keine Glocke.
    const mittel = innen.reduce((a, b) => a + b, 0) / innen.length;
    const abweichung = Math.sqrt(innen.reduce((a, b) => a + (b - mittel) ** 2, 0) / innen.length);
    expect(mittel).toBeGreaterThan(100);
    expect(abweichung / mittel).toBeLessThan(0.12);
    // Die Fläche ist die eines Sechsecks mit Umkreisradius R: 2,598 R².
    const soll = 2.598 * R * R;
    expect(ueberHalb).toBeGreaterThan(soll * 0.9);
    expect(ueberHalb).toBeLessThan(soll * 1.1);
  });

  it('wirft keinen quadratischen Fleck und keinen runden, sondern ein Sechseck', () => {
    const daten = licht();
    const R = 12;
    unscharfAufBytes(daten, B, H, [quelle(new Uint8Array(B * H).fill(255), R, 0)], 'hoch');
    /** Wie weit reicht der Fleck in einer Richtung? */
    const reichweite = (winkel: number) => {
      let r = 0;
      for (let s = 0.5; s < 30; s += 0.5) {
        const x = Math.round(80 + Math.cos(winkel) * s);
        const y = Math.round(60 + Math.sin(winkel) * s);
        if (lies(daten, B, x, y) > 80) r = s;
      }
      return r;
    };
    // Spitzen oben und unten (Umkreis R), flache Seiten links und rechts
    // (Inkreis R·√3/2) – ein Quadrat hätte in der Ecke R·√2.
    const spitze = reichweite(Math.PI / 2);
    const flach = reichweite(0);
    expect(spitze).toBeGreaterThan(R * 0.9);
    expect(spitze).toBeLessThan(R * 1.15);
    expect(flach).toBeGreaterThan(R * 0.8);
    expect(flach).toBeLessThan(R * 0.95);
  });

  it('lässt ein gleichmässiges Feld an allen Rändern gleichmässig', () => {
    const daten = bild(B, H, () => [128, 128, 128]);
    // Radius grösser als das halbe Bild – der Rand wird geklemmt, nicht gefüllt.
    unscharfAufBytes(daten, B, H, [quelle(new Uint8Array(B * H).fill(255), 60, 0)], 'hoch');
    for (let i = 0; i < B * H; i += 1) {
      expect(Math.abs(daten[i * 4] - 128), `Punkt ${i}`).toBeLessThanOrEqual(1);
    }
  });

  it('verändert nichts, wo die Maske null ist – Byte für Byte', () => {
    const daten = licht();
    const vorher = new Uint8ClampedArray(daten);
    const maske = maskeAus(B, H, (x) => (x >= 100 ? 255 : 0));
    unscharfAufBytes(daten, B, H, [quelle(maske, 12, 0)], 'hoch');
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < 100 - 2; x += 1)
        for (let k = 0; k < 4; k += 1) {
          expect(daten[(y * B + x) * 4 + k], `(${x}, ${y}, ${k})`).toBe(
            vorher[(y * B + x) * 4 + k],
          );
        }
  });

  it('lässt Staub in der Maske ausserhalb des Bereichs unberührt', () => {
    /*
     * Der grösste Einzelposten des Befunds: eine Netzmaske trägt ausserhalb
     * Dunst von 0 bis 12. Vorher änderten sich 92 % dieser Bildpunkte.
     */
    const daten = bild(B, H, (x, y) => (((x >> 2) + (y >> 2)) & 1 ? [200, 60, 60] : [60, 160, 70]));
    const vorher = new Uint8ClampedArray(daten);
    const maske = maskeAus(B, H, (x, y) => {
      if (x >= 90) return 255;
      return ((x * 7 + y * 13) % 13) as number; // Dunst 0 … 12
    });
    unscharfAufBytes(daten, B, H, [quelle(maske, 10, 0, 0)], 'hoch');
    let veraendert = 0;
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < 80; x += 1)
        for (let k = 0; k < 3; k += 1)
          if (daten[(y * B + x) * 4 + k] !== vorher[(y * B + x) * 4 + k]) veraendert += 1;
    expect(veraendert).toBe(0);
  });

  it('holt keine Farbe aus dem Saum und von draussen herein', () => {
    /*
     * Links ein rotes Motiv, rechts grüner Grund. Die Maske gehört dem Grund
     * (rechts), ihr Saum ist 8 Punkte breit, und im Saum liegt die Mischfarbe.
     * Mit Kern sammelt der Grund nur Grün ein; ohne ihn (Reinheit 1) blutet
     * Rot und Gelb herein.
     */
    const rot: [number, number, number] = [200, 30, 30];
    const gruen: [number, number, number] = [30, 170, 40];
    const grenze = 70;
    const saum = 8;
    const t = (x: number) => Math.min(1, Math.max(0, (x - (grenze - saum)) / (2 * saum)));
    const szene = () =>
      bild(B, H, (x, y) => {
        const a = t(x);
        const raster = ((x >> 2) + (y >> 2)) & 1 ? 1 : 0.85;
        return [0, 1, 2].map((k) => (rot[k] * (1 - a) + gruen[k] * a) * raster) as [
          number,
          number,
          number,
        ];
      });
    const maske = maskeAus(B, H, (x) => 255 * t(x));
    const mitKern = szene();
    unscharfAufBytes(mitKern, B, H, [quelle(maske, 0, 10, 0)], 'hoch');
    const ohneKern = szene();
    unscharfAufBytes(ohneKern, B, H, [quelle(maske, 0, 10, 1)], 'hoch');

    /** Der Rotanteil im Grün: Rot über Grün, gemittelt in einem Band im Bereich. */
    const rotAnteil = (d: Uint8ClampedArray, x0: number, x1: number) => {
      let s = 0;
      let n = 0;
      for (let y = 20; y < H - 20; y += 1)
        for (let x = x0; x < x1; x += 1) {
          s += lies(d, B, x, y, 0) / Math.max(1, lies(d, B, x, y, 1));
          n += 1;
        }
      return s / n;
    };
    const mit = rotAnteil(mitKern, 82, 90);
    const ohne = rotAnteil(ohneKern, 82, 90);
    const soll = rotAnteil(szene(), 100, 108);
    // Mit Kern bleibt der Grund Grund (wie tief im Bereich), ohne Kern wird er rötlich.
    expect(mit).toBeLessThan(soll + 0.08);
    expect(ohne).toBeGreaterThan(mit + 0.15);
  });

  it('verändert die Silhouette nicht – die Kante bleibt, wo sie war', () => {
    // Das Motiv (links) bleibt scharf, der Grund (rechts) wird unscharf: An der
    // Isolinie der Maske liegt die Kante nach wie vor.
    const rot: [number, number, number] = [210, 30, 30];
    const gruen: [number, number, number] = [30, 180, 40];
    const daten = bild(B, H, (x, y) => {
      const raster = ((x >> 3) + (y >> 3)) & 1 ? 1 : 0.8;
      const c = x < 80 ? rot : gruen;
      return [c[0] * raster, c[1] * raster, c[2] * raster];
    });
    const maske = maskeAus(B, H, (x) => (x < 80 ? 0 : 255));
    unscharfAufBytes(daten, B, H, [quelle(maske, 14, 0, 0)], 'hoch');
    // Links der Kante: Rot, rechts: Grün – auch direkt daneben.
    expect(lies(daten, B, 78, 60, 0)).toBeGreaterThan(150);
    expect(lies(daten, B, 82, 60, 1)).toBeGreaterThan(110);
    expect(lies(daten, B, 82, 60, 0)).toBeLessThan(80);
  });

  it('lässt den Radius mit der Maske wachsen und nicht die Durchsichtigkeit', () => {
    // Drei Lichter unter einem waagerechten Verlauf: Je weiter rechts, desto
    // grösser die Scheibe.
    const lichter = [30, 80, 130];
    const daten = bild(B, H, (x, y) =>
      lichter.some((l) => Math.abs(x - l) <= 1 && Math.abs(y - 60) <= 1)
        ? [255, 255, 255]
        : [10, 10, 10],
    );
    const maske = maskeAus(B, H, (x) => (255 * x) / (B - 1));
    unscharfAufBytes(daten, B, H, [quelle(maske, 14, 0, 1)], 'hoch');
    const flaeche = (mx: number) => {
      let n = 0;
      for (let y = 0; y < H; y += 1)
        for (let x = mx - 25; x <= mx + 25; x += 1)
          if (x >= 0 && x < B && lies(daten, B, x, y) > 60) n += 1;
      return n;
    };
    const [a, b, c] = lichter.map(flaeche);
    expect(b).toBeGreaterThan(a * 1.3);
    expect(c).toBeGreaterThan(b * 1.15);
  });

  it('streut in einem Verlauf weder Halbscheiben noch Doppelscheiben', () => {
    // Ein Licht mitten im Verlauf: Die Fläche ist EINE zusammenhängende Scheibe.
    const daten = bild(B, H, (x, y) =>
      Math.abs(x - 80) <= 1 && Math.abs(y - 60) <= 1 ? [255, 255, 255] : [10, 10, 10],
    );
    const maske = maskeAus(B, H, (x) => (255 * x) / (B - 1));
    unscharfAufBytes(daten, B, H, [quelle(maske, 14, 0, 1)], 'hoch');
    // Entlang der Mittellinie gibt es genau einen Bereich über der Schwelle.
    let uebergaenge = 0;
    let vorher = false;
    for (let x = 0; x < B; x += 1) {
      const hell = lies(daten, B, x, 60) > 60;
      if (hell && !vorher) uebergaenge += 1;
      vorher = hell;
    }
    expect(uebergaenge).toBe(1);
  });
});

describe('Weichzeichnen auf dem Prozessor', () => {
  const B = 160;
  const H = 120;

  it('macht eine harte Kante weich, ohne über die Maske hinauszugehen', () => {
    const daten = bild(B, H, (x) => (x < 100 ? [40, 40, 40] : [220, 220, 220]));
    const vorher = new Uint8ClampedArray(daten);
    // Die Maske deckt die rechte Hälfte (ab 60), die Kante liegt bei 100.
    const maske = maskeAus(B, H, (x) => (x >= 60 ? 255 : 0));
    unscharfAufBytes(daten, B, H, [quelle(maske, 0, 6, 1)], 'hoch');
    // Links der Maske: bytegleich.
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < 58; x += 1)
        expect(lies(daten, B, x, y), `(${x}, ${y})`).toBe(lies(vorher, B, x, y));
    // Innerhalb: die Kante ist weich geworden.
    expect(lies(daten, B, 98, 60)).toBeGreaterThan(60);
    expect(lies(daten, B, 102, 60)).toBeLessThan(200);
  });

  it('hält alles ausser der Maske auch bei breitem Gauss bytegleich', () => {
    const daten = bild(B, H, (x, y) => [(x * 5) & 255, (y * 9) & 255, (x * y) & 255]);
    const vorher = new Uint8ClampedArray(daten);
    const maske = maskeAus(B, H, (x, y) => (Math.hypot(x - 100, y - 60) < 30 ? 255 : 0));
    unscharfAufBytes(daten, B, H, [quelle(maske, 0, 14, 1)], 'hoch');
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < B; x += 1) {
        if (Math.hypot(x - 100, y - 60) < 31) continue;
        for (let k = 0; k < 4; k += 1)
          expect(daten[(y * B + x) * 4 + k], `(${x}, ${y})`).toBe(vorher[(y * B + x) * 4 + k]);
      }
  });

  it('wirkt weicher als jeder Gauss-Einzelschritt, wenn auch Bokeh dazukommt', () => {
    const lichtbild = () =>
      bild(B, H, (x, y) =>
        Math.abs(x - 80) <= 1 && Math.abs(y - 60) <= 1 ? [255, 255, 255] : [10, 10, 10],
      );
    const voll = new Uint8Array(B * H).fill(255);
    const nurBokeh = lichtbild();
    unscharfAufBytes(nurBokeh, B, H, [quelle(voll, 12, 0)], 'hoch');
    const beide = lichtbild();
    unscharfAufBytes(beide, B, H, [quelle(voll, 12, 4)], 'hoch');
    // Die Scheibe hat mit der Mattscheibe davor einen weicheren Rand: Der Sprung
    // von Rand zu draussen ist kleiner.
    const rand = (d: Uint8ClampedArray) =>
      Math.abs(lies(d, B, 80 + 10, 60) - lies(d, B, 80 + 16, 60));
    expect(rand(beide)).toBeLessThan(rand(nurBokeh));
    // Und beide unterscheiden sich vom Original.
    expect(lies(beide, B, 80, 60)).toBeLessThan(255);
  });

  it('rechnet mehrere Bereiche nacheinander, jeden auf dem Ergebnis des vorigen', () => {
    const lichtbild = () =>
      bild(B, H, (x, y) =>
        Math.abs(x - 80) <= 1 && Math.abs(y - 60) <= 1 ? [255, 255, 255] : [10, 10, 10],
      );
    const voll = new Uint8Array(B * H).fill(255);
    const eins = lichtbild();
    unscharfAufBytes(eins, B, H, [quelle(voll, 10, 0)], 'hoch');
    const zwei = lichtbild();
    unscharfAufBytes(
      zwei,
      B,
      H,
      [
        { ...quelle(voll, 10, 0), ebene: { platz: 0, bokehPx: 10, weichPx: 0, reinheit: 1 } },
        { ...quelle(voll, 0, 5), ebene: { platz: 1, bokehPx: 0, weichPx: 5, reinheit: 1 } },
      ],
      'hoch',
    );
    // Der zweite Bereich verwischt das, was der erste gezeichnet hat.
    expect(lies(zwei, B, 80 + 11, 60)).toBeGreaterThan(lies(eins, B, 80 + 11, 60));
  });
});

describe('Sonderfälle', () => {
  it('rührt ohne Quellen, ohne Radius und bei Nullgrösse nichts an', () => {
    const daten = bild(8, 6, (x, y) => [x * 20, y * 30, 7]);
    const vorher = new Uint8ClampedArray(daten);
    expect(unscharfAufBytes(daten, 8, 6, [], 'mittel').every((v) => v === 0)).toBe(true);
    const maske = new Uint8Array(48).fill(255);
    unscharfAufBytes(daten, 8, 6, [quelle(maske, 0, 0)], 'mittel');
    expect(Array.from(daten)).toEqual(Array.from(vorher));
    unscharfAufBytes(daten, 0, 0, [quelle(maske, 5, 0)], 'mittel');
    expect(Array.from(daten)).toEqual(Array.from(vorher));
  });

  it('rechnet winzige Bilder ohne NaN und mit Radius grösser als das Bild', () => {
    for (const [b, h] of [
      [1, 1],
      [3, 2],
      [7, 5],
    ] as const) {
      for (const art of ['bokeh', 'weich'] as const) {
        const daten = bild(b, h, (x, y) => [40 + x * 30, 90, 200 - y * 20]);
        const maske = new Uint8Array(b * h).fill(255);
        unscharfAufBytes(
          daten,
          b,
          h,
          [quelle(maske, art === 'bokeh' ? 20 : 0, art === 'weich' ? 20 : 0)],
          'hoch',
        );
        for (let i = 0; i < b * h; i += 1) {
          for (let k = 0; k < 3; k += 1) {
            expect(Number.isFinite(daten[i * 4 + k]), `${b}×${h} ${art}`).toBe(true);
          }
          expect(daten[i * 4 + 3]).toBe(255);
        }
      }
    }
  });

  it('lässt Alpha in Ruhe', () => {
    const daten = bild(32, 32, (x) => [x * 8, 100, 50]);
    for (let i = 0; i < 32 * 32; i += 1) daten[i * 4 + 3] = 77;
    unscharfAufBytes(daten, 32, 32, [quelle(new Uint8Array(1024).fill(255), 6, 3)], 'hoch');
    for (let i = 0; i < 32 * 32; i += 1) expect(daten[i * 4 + 3]).toBe(77);
  });

  it('meldet den Einfluss dort, wo gerechnet wurde, und sonst null', () => {
    const daten = bild(80, 40, (x, y) =>
      ((x >> 2) + (y >> 2)) & 1 ? [220, 40, 40] : [30, 160, 60],
    );
    const maske = maskeAus(80, 40, (x) => (x >= 50 ? 255 : 0));
    const einfluss = unscharfAufBytes(daten, 80, 40, [quelle(maske, 0, 5, 0)], 'mittel');
    expect(einfluss[40 * 0 + 10]).toBe(0);
    expect(einfluss[20 * 80 + 70]).toBeGreaterThan(200);
  });

  it('rechnet auf allen drei Güten dasselbe Bild – nur weicher am Rand der Scheibe', () => {
    const lichtbild = () =>
      bild(160, 120, (x, y) =>
        Math.abs(x - 80) <= 1 && Math.abs(y - 60) <= 1 ? [255, 255, 255] : [10, 10, 10],
      );
    const voll = new Uint8Array(160 * 120).fill(255);
    const werte: Record<string, number> = {};
    for (const g of ['hoch', 'mittel', 'niedrig'] as StufenGuete[]) {
      const d = lichtbild();
      unscharfAufBytes(d, 160, 120, [quelle(voll, 16, 0)], g);
      let summe = 0;
      for (let i = 0; i < 160 * 120; i += 1) summe += d[i * 4];
      werte[g] = summe;
    }
    // Die Lichtmasse bleibt: Alle drei Güten verteilen dasselbe Licht.
    expect(werte.mittel / werte.hoch).toBeGreaterThan(0.9);
    expect(werte.mittel / werte.hoch).toBeLessThan(1.1);
    expect(werte.niedrig / werte.hoch).toBeGreaterThan(0.85);
    expect(werte.niedrig / werte.hoch).toBeLessThan(1.15);
  });
});
