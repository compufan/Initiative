import { describe, expect, it, vi } from 'vitest';

import { flutmaske } from '../stickers/engines/flutung.js';
import type { InhaltsTeil } from './bildweise.js';
import type { GelesenesBild } from './bilderLesen.js';
import { folgeTeile } from './folgeTeile.js';
import { Spur, komponentenFiltern } from './objektFolge.js';
import type { Grau } from './verfolgung.js';

/**
 * Folgt die Maske ihrem Gegenstand? Gemessen, nicht angenommen.
 *
 * Eine rote Scheibe wandert durch ein gemustertes Bild. Für „Antippen" läuft
 * die ECHTE Farbflutung; für das Netz steht ein Modell, das perfekt
 * freistellt (alles, was rot ist). Damit misst jede Zahl hier nur das, was
 * dieses Modul entscheidet: wohin die Punkte gehen, welche frische Maske
 * gilt, was zwischen den Schlüsselbildern steht.
 *
 * Verglichen wird mit der Flutung an der WAHREN Mitte der Scheibe – sie trägt
 * dieselbe weiche Kante, und die Deckung misst nur die Lage.
 *
 * Vor dieser Fassung: mittlere Deckung 0,56 bei einem Punkt je Bild, 0,19
 * bei drei Punkten je Bild, und die Maske blieb nach wenigen Bildern stehen.
 */

vi.mock('../stickers/engines/index.js', async () => {
  const echt = await vi.importActual<typeof import('../stickers/engines/index.js')>(
    '../stickers/engines/index.js',
  );
  return {
    ...echt,
    // Das perfekte Netz: was rot ist, gehört dazu.
    runEngine: async (_key: string, anfrage: { image: ImageData }) => {
      const { data, width, height } = anfrage.image;
      const maske = new Uint8Array(width * height);
      for (let i = 0; i < maske.length; i += 1) {
        if (data[i * 4] > 150 && data[i * 4 + 1] < 110 && data[i * 4 + 2] < 110) maske[i] = 255;
      }
      return maske;
    },
  };
});

const B = 320;
const H = 180;
const RADIUS = 22;

interface Szene {
  /** Wo die Scheibe im BILD steht. */
  mitte: (n: number) => { x: number; y: number } | null;
  /** Wie weit der Hintergrund (die Kamera) verschoben ist. */
  kamera: (n: number) => { x: number; y: number };
  /** Ob die Scheibe ein eigenes Muster trägt. */
  gemustert: boolean;
}

function bild(n: number, szene: Szene): GelesenesBild {
  const data = new Uint8ClampedArray(B * H * 4);
  const k = szene.kamera(n);
  const m = szene.mitte(n);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) {
      const at = (y * B + x) * 4;
      const sx = x - k.x;
      const sy = y - k.y;
      // Ein nicht wiederholendes Grau-Muster: nur so findet die Blocksuche
      // eindeutig, wo ein Stück Hintergrund hinging.
      const g = 128 + 60 * Math.sin(sx / 5.3 + Math.cos(sy / 7.1)) * Math.cos(sy / 4.7 - sx / 13);
      let r = g;
      let gr = g;
      let bl = g;
      if (m && (x - m.x) ** 2 + (y - m.y) ** 2 <= RADIUS * RADIUS) {
        r = szene.gemustert ? 200 + 35 * Math.sin((x - m.x) / 3) * Math.cos((y - m.y) / 4) : 210;
        gr = 40;
        bl = 40;
      }
      data[at] = r;
      data[at + 1] = gr;
      data[at + 2] = bl;
      data[at + 3] = 255;
    }
  }
  return { zeitMs: n * 40, daten: { data, width: B, height: H, colorSpace: 'srgb' } as ImageData };
}

function rot(bild: ImageData): Uint8Array {
  const maske = new Uint8Array(B * H);
  for (let i = 0; i < maske.length; i += 1) {
    if (bild.data[i * 4] > 150 && bild.data[i * 4 + 1] < 110 && bild.data[i * 4 + 2] < 110) {
      maske[i] = 255;
    }
  }
  return maske;
}

function deckung(a: Uint8Array, b: Uint8Array): number {
  let schnitt = 0;
  let vereint = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] >= 128;
    const y = b[i] >= 128;
    if (x && y) schnitt += 1;
    if (x || y) vereint += 1;
  }
  return vereint === 0 ? 1 : schnitt / vereint;
}

function teil(art: 'netz' | 'tipp', punkt: { x: number; y: number }): InhaltsTeil {
  if (art === 'netz') {
    return {
      bereich: 'b1',
      art: 'netz',
      teil: {
        id: 'n1',
        modus: 'dazu',
        umkehren: false,
        art: 'netz',
        netz: 'object',
        breite: B,
        hoehe: H,
        alpha: new Uint8Array(B * H),
        marke: 1,
      },
    };
  }
  return {
    bereich: 'b1',
    art: 'tipp',
    teil: {
      id: 't1',
      modus: 'dazu',
      umkehren: false,
      art: 'tipp',
      mitNetz: false,
      punkte: [punkt],
      toleranz: 40,
      breite: B,
      hoehe: H,
      alpha: new Uint8Array(B * H),
      marke: 1,
    },
  };
}

async function messen(szene: Szene, art: 'netz' | 'tipp', anzahl = 40) {
  const bilder = Array.from({ length: anzahl }, (_, n) => bild(n, szene));
  const start = szene.mitte(0) as { x: number; y: number };
  const eintrag = teil(art, start);
  const { jeBild, verworfen } = await folgeTeile(bilder, {
    teile: [eintrag],
    schluesselAbstand: 4,
  });
  const werte: number[] = [];
  bilder.forEach((b, n) => {
    const m = szene.mitte(n);
    // Das Netz wird an seiner eigenen Wahrheit gemessen (alles Rote), die
    // Flutung an der Flutung von der wahren Mitte aus – beide mit derselben
    // Kante wie das, was sie prüfen.
    // Liegt die Mitte schon draussen, gibt es nichts zu fluten – dann gilt, was
    // von der Scheibe noch zu sehen ist.
    const mitteDrin = m !== null && m.x >= 0 && m.x < B && m.y >= 0 && m.y < H;
    const wahr = !m
      ? new Uint8Array(B * H)
      : art === 'tipp' && mitteDrin
        ? flutmaske(b.daten, [m], 40)
        : rot(b.daten);
    const maske = jeBild[n].get(eintrag.teil.id)?.werte ?? new Uint8Array(B * H);
    werte.push(deckung(maske, wahr));
  });
  const mittel = werte.reduce((a, b) => a + b, 0) / werte.length;
  return { mittel, kleinste: Math.min(...werte), werte, verworfen };
}

const ruhig = () => ({ x: 0, y: 0 });
/** Eine Hand, die wackelt: deterministisch, ±3 Punkte. */
const wackelnd = (n: number) => ({
  x: Math.round(3 * Math.sin(n * 1.7)),
  y: Math.round(2 * Math.cos(n * 2.3)),
});

const FAELLE: [string, Szene][] = [
  [
    'ruhige Kamera, gemusterter Gegenstand, 4 Punkte je Bild',
    { mitte: (n) => ({ x: 40 + 4 * n, y: 90 }), kamera: ruhig, gemustert: true },
  ],
  [
    'ruhige Kamera, einfarbiger Gegenstand, 4 Punkte je Bild',
    { mitte: (n) => ({ x: 40 + 4 * n, y: 90 }), kamera: ruhig, gemustert: false },
  ],
  [
    'wackelnde Kamera, gemusterter Gegenstand, 4 Punkte je Bild',
    {
      mitte: (n) => ({ x: 40 + 4 * n + wackelnd(n).x, y: 90 + wackelnd(n).y }),
      kamera: wackelnd,
      gemustert: true,
    },
  ],
  [
    'schnell: 8 Punkte je Bild, diagonal',
    { mitte: (n) => ({ x: 40 + 6 * n, y: 50 + 2 * n }), kamera: ruhig, gemustert: true },
  ],
  [
    'Schwenk: Kamera zieht mit 3 Punkten je Bild, Gegenstand steht in der Szene',
    {
      mitte: (n) => ({ x: 60 + 3 * n, y: 90 }),
      kamera: (n) => ({ x: 3 * n, y: 0 }),
      gemustert: true,
    },
  ],
];

describe('Masken folgen ihrem Gegenstand', () => {
  for (const [name, szene] of FAELLE) {
    for (const art of ['tipp', 'netz'] as const) {
      it(`${art}: ${name}`, async () => {
        const erg = await messen(szene, art);
        // Die Zahlen stehen in der Meldung, damit ein Rückschritt sichtbar ist.
        /*
         * Gemessen mit dieser Fassung: Mittel 0,99–1,00 in jedem Fall, mit
         * null Ablehnungen. Mit der vorigen (Stückanker, Punkte mit der
         * Kamera): 0,08–0,16 und neun von zehn Schlüsselbildern verworfen –
         * nur der Schwenk ging, weil sich dort Kamera und Gegenstand
         * zusammen bewegen.
         */
        expect(
          erg.mittel,
          `Mittel ${erg.mittel.toFixed(3)}, kleinste ${erg.kleinste.toFixed(3)}`,
        ).toBeGreaterThan(0.95);
        expect(erg.kleinste, `kleinste ${erg.kleinste.toFixed(3)}`).toBeGreaterThan(0.85);
        expect(erg.verworfen).toBe(0);
      }, 30_000);
    }
  }

  it('bleibt bei ruhender Kamera und ruhendem Gegenstand genau stehen', async () => {
    const szene: Szene = { mitte: () => ({ x: 160, y: 90 }), kamera: ruhig, gemustert: true };
    for (const art of ['tipp', 'netz'] as const) {
      const erg = await messen(szene, art, 24);
      expect(erg.kleinste, art).toBeGreaterThan(0.97);
      expect(erg.verworfen, art).toBe(0);
    }
  }, 30_000);

  it('hängt nicht am Bildrand fest, wenn der Gegenstand hinausläuft', async () => {
    // Ab Bild 18 ist die Scheibe ganz draussen.
    const szene: Szene = {
      mitte: (n) => (n < 20 ? { x: 200 + 8 * n, y: 90 } : null),
      kamera: ruhig,
      gemustert: true,
    };
    const erg = await messen(szene, 'netz', 32);
    const text = erg.werte.map((w) => w.toFixed(2)).join(' ');
    // Nach dem Verschwinden: keine Maske mehr, die irgendwo stehen bliebe.
    // Vorher blieb bis Bild 25 ein Rest am Rand kleben.
    expect(Math.min(...erg.werte.slice(18)), text).toBe(1);
    /*
     * Und auf dem Weg hinaus sitzt die Maske auf dem, was noch zu sehen ist.
     * Vorher 0,75, 0,64 und 0,31 in den Bildern 13 bis 15: Die ganze Maske
     * wurde an die angeschnittene angeglichen und schrumpfte mit.
     */
    expect(Math.min(...erg.werte.slice(12, 17)), text).toBeGreaterThan(0.9);
  }, 30_000);

  it('lässt beim Antippen nichts auslaufen, wenn der Gegenstand das Bild verlässt', async () => {
    /*
     * Die Punkte blieben am Rand stehen, auf dem Hintergrund; die Flutung
     * griff von dort nach allem, was ähnlich aussah, und nach drei
     * Ablehnungen galt das: 83 % des Bildes, bis zum Ende. Jetzt wandern
     * Punkte, die das Bild verlassen, in den noch sichtbaren Teil der
     * Vorhersage – oder fallen weg, wenn dort nichts mehr ist.
     *
     * Ab Bild 18 ist die Scheibe ganz draussen: Dann darf nichts stehen
     * bleiben, auch kein Streifen, der der Vorhersage noch gefolgt wäre.
     */
    const szene: Szene = {
      mitte: (n) => (n < 20 ? { x: 200 + 8 * n, y: 90 } : null),
      kamera: ruhig,
      gemustert: true,
    };
    const erg = await messen(szene, 'tipp', 40);
    const text = erg.werte.map((w) => w.toFixed(2)).join(' ');
    expect(Math.min(...erg.werte.slice(18)), text).toBe(1);
    expect(Math.min(...erg.werte.slice(0, 14)), text).toBeGreaterThan(0.9);
  }, 30_000);

  it('bleibt auf dem sichtbaren Rest, solange ein Gegenstand halb hinaus ist', async () => {
    /*
     * Die Mitte, an der angetippt wurde, verlässt das Bild, wenn die Scheibe
     * erst zur Hälfte draussen ist. Vorher fielen die Punkte dann weg und
     * die Maske verschwand bei 20 von 40 Spalten noch im Bild – gemessen mit
     * einem Quadrat: Deckung 0,00 ab da, obwohl die Hälfte zu sehen war.
     *
     * Hier läuft die Scheibe nach und nach hinaus (Mitte bei 150 + 8n; ab
     * Bild 22 liegt sie draussen, ab 24 ist nichts mehr von ihr im Bild).
     */
    const szene: Szene = {
      mitte: (n) => ({ x: 150 + 8 * n, y: 90 }),
      kamera: ruhig,
      gemustert: true,
    };
    const erg = await messen(szene, 'tipp', 36);
    const text = erg.werte.map((w) => w.toFixed(2)).join(' ');
    // Solange mindestens ein Drittel der Scheibe zu sehen ist (bis Bild 22), sitzt die Maske darauf.
    expect(Math.min(...erg.werte.slice(0, 23)), text).toBeGreaterThan(0.5);
    // Und danach bleibt nichts zurück.
    expect(Math.min(...erg.werte.slice(25)), text).toBe(1);
  }, 30_000);

  it('folgt einem Gegenstand, der ins Bild hereinkommt', async () => {
    // Vorher 0,67, 0,63 und 0,63 in den Bildern 5 bis 7.
    const szene: Szene = {
      mitte: (n) => ({ x: -30 + 8 * n, y: 90 }),
      kamera: ruhig,
      gemustert: true,
    };
    const erg = await messen(szene, 'netz', 24);
    const text = erg.werte.map((w) => w.toFixed(2)).join(' ');
    expect(Math.min(...erg.werte.slice(4)), text).toBeGreaterThan(0.9);
  }, 30_000);
});

describe('Die Spur selbst', () => {
  /** Ein ruhendes, gemustertes Graubild – jedes Bild gleich. */
  function ruhend(anzahl: number): Grau[] {
    const werte = new Float32Array(160 * 120);
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 160; x += 1) {
        werte[y * 160 + x] =
          128 + 70 * Math.sin(x / 4.1 + Math.cos(y / 6.7)) * Math.cos(y / 3.9 - x / 11);
      }
    }
    return Array.from({ length: anzahl }, () => ({ breite: 160, hoehe: 120, werte }));
  }
  function block(kante: number): Uint8Array {
    const maske = new Uint8Array(160 * 120);
    const x0 = 80 - (kante >> 1);
    const y0 = 60 - (kante >> 1);
    for (let y = Math.max(0, y0); y < Math.min(120, y0 + kante); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(160, x0 + kante); x += 1) maske[y * 160 + x] = 255;
    }
    return maske;
  }
  const flaeche = (m: Uint8Array) => m.reduce((summe, v) => summe + (v >= 128 ? 1 : 0), 0);

  it('nimmt ein Leck nicht an, nur weil es anhält – und die Rückkehr schon', async () => {
    /*
     * Das Modell liefert dreimal hintereinander ein Vielfaches der Fläche
     * (ein Leck, das nach einem Belichtungssprung bleibt) und dann wieder
     * das Richtige. Vorher galt das Leck nach drei Ablehnungen, und die
     * Rückkehr zur richtigen Maske scheiterte danach an der Prüfung.
     */
    let aufruf = 0;
    const spur = new Spur({
      grau: ruhend(10),
      breite: 160,
      hoehe: 120,
      von: 0,
      bis: 9,
      anker: 0,
      schluessel: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      punkte: null,
      rechnen: async () => {
        aufruf += 1;
        return block(aufruf >= 2 && aufruf <= 6 ? 100 : 30);
      },
    });
    while (spur.naechstes() !== null) await spur.schritt();
    const flaechen = spur.ergebnis().masken.map(flaeche);
    expect(Math.max(...flaechen), flaechen.join(' ')).toBeLessThanOrEqual(900);
    expect(flaechen[9]).toBe(900);
  });

  it('nimmt am Anker die mitgebrachte Maske, statt zu rechnen', async () => {
    let aufrufe = 0;
    const spur = new Spur({
      grau: ruhend(3),
      breite: 160,
      hoehe: 120,
      von: 0,
      bis: 2,
      anker: 0,
      schluessel: [],
      punkte: null,
      ankerMaske: block(20),
      rechnen: async () => {
        aufrufe += 1;
        return block(20);
      },
    });
    while (spur.naechstes() !== null) await spur.schritt();
    // Nur am Ende gerechnet, nicht am Anker.
    expect(aufrufe).toBe(1);
    expect(flaeche(spur.maskeAn(2))).toBe(400);
  });

  it('meldet eine fertige Spur nicht als Grenze für die anderen', async () => {
    const spur = new Spur({
      grau: ruhend(3),
      breite: 160,
      hoehe: 120,
      von: 0,
      bis: 2,
      anker: 0,
      schluessel: [],
      punkte: null,
      rechnen: async () => block(20),
    });
    while (spur.naechstes() !== null) await spur.schritt();
    expect(spur.fertigBis()).toBe(Number.POSITIVE_INFINITY);
  });
});

/* ---------- In Fenstern, und wenn der Gegenstand geht ---------- */

/**
 * Eine Szene für die Spur allein: gemusterter, ruhender Grund, eine
 * gemusterte Scheibe, die wandert, und wahlweise ein zweiter Gegenstand, den
 * ein Freisteller genauso gern nähme (u²-Net liefert „das Auffälligste").
 *
 * Das Ersatzmodell sieht ALLES, was gerade zu sehen ist – die Scheibe und
 * den Fremden. Welche Maske daraus gilt, entscheidet allein die Spur.
 */
describe('Die Spur in Fenstern und beim Verschwinden', () => {
  const W = 320;
  const H = 120;
  const R = 14;
  interface Scheibe {
    x: number;
    y: number;
  }
  interface Film {
    /** Die verfolgte Scheibe – `null`, wo sie nicht zu sehen ist. */
    scheibe: (n: number) => Scheibe | null;
    /** Ein Fremder ab Bild `ab` an fester Stelle – ohne `r` so gross wie die Scheibe. */
    fremd?: { x: number; y: number; ab: number; r?: number };
  }

  function grauBild(n: number, film: Film): Grau {
    const werte = new Float32Array(W * H);
    const s = film.scheibe(n);
    const f = film.fremd && n >= film.fremd.ab ? film.fremd : null;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let g = 128 + 60 * Math.sin(x / 5.3 + Math.cos(y / 7.1)) * Math.cos(y / 4.7 - x / 13);
        if (f && (x - f.x) ** 2 + (y - f.y) ** 2 <= (f.r ?? R) ** 2) {
          g = 40 + 20 * Math.sin((x - f.x) / 2.5) * Math.cos((y - f.y) / 3.1);
        }
        if (s && (x - s.x) ** 2 + (y - s.y) ** 2 <= R * R) {
          g = 220 + 30 * Math.sin((x - s.x) / 3) * Math.cos((y - s.y) / 4);
        }
        werte[y * W + x] = g;
      }
    }
    return { breite: W, hoehe: H, werte };
  }

  function scheibenMaske(mitten: readonly ((Scheibe & { r?: number }) | null)[]): Uint8Array {
    const maske = new Uint8Array(W * H);
    for (const m of mitten) {
      if (!m) continue;
      const r = m.r ?? R;
      for (let y = Math.max(0, Math.floor(m.y - r)); y <= Math.min(H - 1, m.y + r); y += 1) {
        for (let x = Math.max(0, Math.floor(m.x - r)); x <= Math.min(W - 1, m.x + r); x += 1) {
          if ((x - m.x) ** 2 + (y - m.y) ** 2 <= r * r) maske[y * W + x] = 255;
        }
      }
    }
    return maske;
  }

  /** Was das Ersatzmodell an Bild n sieht: alles Auffällige. */
  function modell(film: Film, versatz = 0) {
    return async (bild: number) => {
      const n = bild + versatz;
      const f = film.fremd && n >= film.fremd.ab ? film.fremd : null;
      return scheibenMaske([film.scheibe(n), f]);
    };
  }

  function schluesselBis(bis: number, abstand = 4): number[] {
    const raus: number[] = [];
    for (let k = 0; k <= bis; k += abstand) raus.push(k);
    return raus;
  }

  async function laufen(spur: Spur): Promise<void> {
    while (spur.naechstes() !== null) await spur.schritt();
  }

  const flaecheVon = (m: Uint8Array) => m.reduce((summe, v) => summe + (v >= 128 ? 1 : 0), 0);
  /** Wie viel der Maske auf einer Scheibe liegt, die nicht die verfolgte ist. */
  const aufDemFremden = (m: Uint8Array, film: Film) =>
    film.fremd ? deckungMit(m, scheibenMaske([film.fremd])) : 0;
  function deckungMit(m: Uint8Array, wahr: Uint8Array): number {
    let beide = 0;
    for (let i = 0; i < m.length; i += 1) if (m[i] >= 128 && wahr[i] >= 128) beide += 1;
    return beide;
  }

  it('rechnet in Fenstern mit `fortsetzung` dasselbe wie am Stück', async () => {
    /*
     * Achtzig Bilder, eine Scheibe, die zwei Punkte je Bild wandert – einmal
     * als EINE Spur, einmal in Fenstern zu sechzehn Bildern, jedes mit dem
     * Stand und der rohen Maske, mit denen das vorige aufhörte. Die
     * Schlüsselmasken müssen gleich sein, Byte für Byte, und dazwischen
     * gleich gut.
     */
    const film: Film = { scheibe: (n) => ({ x: 40 + 2 * n, y: 60 }) };
    const grau = Array.from({ length: 80 }, (_, n) => grauBild(n, film));
    const amStueck = new Spur({
      grau,
      breite: W,
      hoehe: H,
      von: 0,
      bis: 79,
      anker: 0,
      schluessel: schluesselBis(79),
      punkte: null,
      rechnen: modell(film),
    });
    await laufen(amStueck);
    const ganz = amStueck.ergebnis();

    const gefenstert: Uint8Array[] = [];
    let rand: { maske: Uint8Array; stand: NonNullable<ReturnType<Spur['randAn']>> } | null = null;
    for (let von = 0; von < 79; von += 16) {
      const bis = Math.min(79, von + 16);
      const spur: Spur = new Spur({
        grau: grau.slice(von, bis + 1),
        breite: W,
        hoehe: H,
        von: 0,
        bis: bis - von,
        anker: 0,
        schluessel: schluesselBis(bis - von),
        punkte: null,
        ...(rand ? { ankerMaske: rand.maske, fortsetzung: rand.stand } : {}),
        rechnen: modell(film, von),
      });
      await laufen(spur);
      const teil = spur.ergebnis().masken;
      // Das Randbild gehört dem vorigen Fenster – hier kommt es nicht noch einmal.
      teil.forEach((maske, i) => {
        if (i > 0 || von === 0) gefenstert[von + i] = maske;
      });
      const stand = spur.randAn(bis - von);
      expect(stand).not.toBeNull();
      rand = { maske: spur.maskeAn(bis - von), stand: stand as NonNullable<typeof stand> };
    }

    expect(gefenstert).toHaveLength(80);
    for (let k = 0; k < 80; k += 1) {
      if (k % 4 === 0 || k === 79) {
        expect(Array.from(gefenstert[k]), `Schlüsselbild ${k}`).toEqual(Array.from(ganz.masken[k]));
      } else {
        expect(deckung(gefenstert[k], ganz.masken[k]), `Bild ${k}`).toBeGreaterThanOrEqual(0.98);
      }
    }
  });

  it('nimmt nach einem Austritt im nächsten Fenster kein Leck über das Dreifache an', async () => {
    /*
     * Ohne `fortsetzung` begänne das zweite Fenster mit der Fläche seines
     * Ankers – und der ist leer, der Gegenstand ist ja gegangen. Mit null
     * als Mass wäre jedes Leck willkommen.
     */
    const film: Film = { scheibe: (n) => (n < 17 ? { x: 200 + 8 * n, y: 60 } : null) };
    const grau = Array.from({ length: 41 }, (_, n) => grauBild(n, film));
    const erstes = new Spur({
      grau: grau.slice(0, 25),
      breite: W,
      hoehe: H,
      von: 0,
      bis: 24,
      anker: 0,
      schluessel: schluesselBis(24),
      punkte: null,
      rechnen: modell(film),
    });
    await laufen(erstes);
    expect(flaecheVon(erstes.maskeAn(24))).toBe(0);
    const stand = erstes.randAn(24);
    // Die Fläche der letzten nicht leeren Maske – hier der Streifen am Rand.
    expect(stand?.flaeche).toBeGreaterThan(0);

    // Ein Leck: ein Viertel des Bildes, das Zehnfache der Scheibe.
    const leck = async () => {
      const maske = new Uint8Array(W * H);
      for (let y = 20; y < 80; y += 1) for (let x = 60; x < 160; x += 1) maske[y * W + x] = 255;
      return maske;
    };
    const zweites = (mitStand: boolean) =>
      new Spur({
        grau: grau.slice(24, 41),
        breite: W,
        hoehe: H,
        von: 0,
        bis: 16,
        anker: 0,
        schluessel: schluesselBis(16),
        punkte: null,
        ankerMaske: erstes.maskeAn(24),
        ...(mitStand && stand ? { fortsetzung: stand } : {}),
        rechnen: leck,
      });
    const mit = zweites(true);
    await laufen(mit);
    expect(Math.max(...mit.ergebnis().masken.map(flaecheVon))).toBe(0);
    // Gegenprobe: Ohne den mitgebrachten Stand gälte das Leck.
    const ohne = zweites(false);
    await laufen(ohne);
    expect(flaecheVon(ohne.maskeAn(16))).toBe(6000);
  });

  it('gibt an Schlüsselbildern den Stand heraus – und nur dort', async () => {
    const film: Film = { scheibe: (n) => (n < 17 ? { x: 200 + 8 * n, y: 60 } : null) };
    const grau = Array.from({ length: 25 }, (_, n) => grauBild(n, film));
    const spur = new Spur({
      grau,
      breite: W,
      hoehe: H,
      von: 0,
      bis: 24,
      anker: 0,
      schluessel: schluesselBis(24),
      punkte: null,
      rechnen: modell(film),
    });
    await laufen(spur);
    const frueh = spur.randAn(8);
    expect(frueh?.tempo?.x).toBeCloseTo(8, 0);
    expect(frueh?.abgelehnt).toBe(0);
    expect(frueh?.abwesendSeit).toBeNull();
    expect(frueh?.letzterKasten).not.toBeNull();
    expect(spur.randAn(9)).toBeNull();
    // Nach dem Austritt: seit wann er fehlt, und wo er zuletzt war.
    const spaet = spur.randAn(24);
    expect(spaet?.abwesendSeit).toBeGreaterThan(0);
    expect(spaet?.letzterKasten?.x1).toBe(W - 1);
  });

  describe('mit `wiederBilder` (Motiv, BiRefNet)', () => {
    const hinaus = (n: number) => (n < 17 ? { x: 200 + 8 * n, y: 60 } : null);

    async function verfolgen(film: Film, anzahl: number, wiederBilder?: number) {
      const grau = Array.from({ length: anzahl }, (_, n) => grauBild(n, film));
      const spur = new Spur({
        grau,
        breite: W,
        hoehe: H,
        von: 0,
        bis: anzahl - 1,
        anker: 0,
        schluessel: schluesselBis(anzahl - 1),
        punkte: null,
        // Der Anker: nur die Scheibe – so, wie der Anwender sie freigestellt hat.
        ankerMaske: scheibenMaske([film.scheibe(0)]),
        ...(wiederBilder !== undefined ? { wiederBilder } : {}),
        rechnen: modell(film),
      });
      await laufen(spur);
      return spur.ergebnis().masken;
    }

    it('bleibt leer, wenn nach dem Austritt ein Fremder im Bild steht', async () => {
      /*
       * Ein kleiner Fremder: Er besteht die alte Prüfung nach einer leeren
       * Maske (höchstens das Dreifache der letzten Fläche – und die war der
       * Streifen am Rand).
       */
      const film: Film = { scheibe: hinaus, fremd: { x: 80, y: 60, ab: 22, r: 8 } };
      const mit = await verfolgen(film, 48, 50);
      const text = mit.map(flaecheVon).join(' ');
      expect(Math.max(...mit.slice(18).map(flaecheVon)), text).toBe(0);
      // Gegenprobe – so war es, und so bleibt es ohne `wiederBilder`: Die Maske sprang auf ihn.
      const ohne = await verfolgen(film, 48);
      expect(aufDemFremden(ohne[47], film)).toBeGreaterThan(150);
    });

    it('nimmt einen Fremden nicht, der schon WÄHREND des Austritts da ist', async () => {
      /*
       * Der Fall, an dem die Wiedereintrittsregel allein scheitert: Der
       * Fremde steht schon da, während die Scheibe noch halb im Bild ist.
       * Die Vorhersage liegt dann halb draussen, und ohne Filter galt das
       * Fremde nach zwei Ablehnungen – oder sofort, sobald die Vorhersage
       * ganz draussen lag.
       */
      const film: Film = { scheibe: hinaus, fremd: { x: 80, y: 60, ab: 8 } };
      const mit = await verfolgen(film, 48, 50);
      expect(Math.max(...mit.map((m) => aufDemFremden(m, film)))).toBe(0);
      expect(Math.max(...mit.slice(18).map(flaecheVon))).toBe(0);
      // Solange die Scheibe da ist, sitzt die Maske auf ihr.
      for (let n = 0; n < 12; n += 1) {
        expect(deckung(mit[n], scheibenMaske([hinaus(n)])), `Bild ${n}`).toBeGreaterThan(0.8);
      }
      /*
       * Gegenprobe ohne `wiederBilder`: Die frische Maske (Rest + Fremder)
       * ist mehr als dreimal so gross wie die Vorhersage und wird für immer
       * abgelehnt – die Vorhersage, ein Streifen am Rand, bleibt dort
       * stehen bis zum Ende. Auch das ist eine Maske, die nicht mit ihrem
       * Gegenstand geht.
       */
      const ohne = await verfolgen(film, 48);
      expect(Math.min(...ohne.slice(18).map(flaecheVon))).toBeGreaterThan(0);
    });

    it('nimmt die Scheibe wieder, wenn sie vom Rand zurückkommt', async () => {
      const film: Film = {
        scheibe: (n) =>
          n < 17 ? { x: 200 + 8 * n, y: 60 } : n >= 30 ? { x: 334 - 6 * (n - 30), y: 60 } : null,
      };
      const mit = await verfolgen(film, 56, 50);
      expect(Math.max(...mit.slice(18, 30).map(flaecheVon))).toBe(0);
      for (let n = 40; n < 56; n += 1) {
        const wahr = scheibenMaske([film.scheibe(n)]);
        expect(deckung(mit[n], wahr), `Bild ${n}`).toBeGreaterThan(0.7);
      }
    });

    const verdeckt = (von: number, bis: number) => (n: number) =>
      n >= von && n < bis ? null : { x: 40 + 2 * n, y: 60 };

    it('findet die Scheibe nach einer Sekunde Verdeckung dort, wo sie zu erwarten war', async () => {
      const film: Film = { scheibe: verdeckt(20, 45) };
      const mit = await verfolgen(film, 72, 50);
      for (let n = 52; n < 72; n += 1) {
        const wahr = scheibenMaske([film.scheibe(n)]);
        expect(deckung(mit[n], wahr), `Bild ${n}`).toBeGreaterThan(0.7);
      }
    });

    it('bleibt nach drei Sekunden Verdeckung leer – dann könnte es ein anderer sein', async () => {
      const film: Film = { scheibe: verdeckt(20, 95) };
      const mit = await verfolgen(film, 121, 50);
      expect(Math.max(...mit.slice(100).map(flaecheVon))).toBe(0);
      // Gegenprobe: Ohne die Regel galt die Scheibe mitten im Bild wieder.
      const ohne = await verfolgen(film, 121);
      expect(flaecheVon(ohne[120])).toBeGreaterThan(400);
    });

    /*
     * Echte Freisteller liefern ausserhalb des Gegenstands selten genau null.
     * Mit einem Dunst über dem Grund war der Kasten der Vorhersage das ganze
     * Bild, jede Komponente traf, und der Filter wirkte nicht mehr: Ab dem
     * Austritt lag die Maske auf dem Fremden (613 von 615 Kernpunkten).
     */
    describe('mit Dunst im Grund, wie ihn Freisteller liefern', () => {
      /** Die Scheibe(n) wie `modell`, aber der Grund ist `grund(i, n)` statt null. */
      function modellMitGrund(film: Film, grund: (i: number, n: number) => number) {
        return async (n: number) => {
          const f = film.fremd && n >= film.fremd.ab ? film.fremd : null;
          const maske = scheibenMaske([film.scheibe(n), f]);
          for (let i = 0; i < maske.length; i += 1) if (maske[i] === 0) maske[i] = grund(i, n);
          return maske;
        };
      }

      async function mitGrund(film: Film, anzahl: number, grund: (i: number, n: number) => number) {
        const grau = Array.from({ length: anzahl }, (_, n) => grauBild(n, film));
        const rechnen = modellMitGrund(film, grund);
        const spur = new Spur({
          grau,
          breite: W,
          hoehe: H,
          von: 0,
          bis: anzahl - 1,
          anker: 0,
          schluessel: schluesselBis(anzahl - 1),
          punkte: null,
          // Der Anker kommt aus dem Editor – mit demselben Dunst.
          ankerMaske: await rechnen(0),
          wiederBilder: 50,
          rechnen,
        });
        await laufen(spur);
        return spur.ergebnis().masken;
      }

      /** Wie `messung.test.ts`: aussen 0 … 12, verrauscht. */
      const rauschen = (i: number, n: number) => ((i * 2654435761 + n * 40503) >>> 0) % 13;
      const faelle: [string, (i: number, n: number) => number][] = [
        ['gleichmässig 3', () => 3],
        ['gleichmässig 8', () => 8],
        ['verrauscht 0 … 12', rauschen],
        ['ein einziger Punkt in der Ecke', (i) => (i === 0 ? 20 : 0)],
      ];
      for (const [name, grund] of faelle) {
        it(`${name}: kein Sprung auf einen Fremden, der während des Austritts da ist`, async () => {
          const film: Film = { scheibe: hinaus, fremd: { x: 80, y: 60, ab: 8 } };
          const mit = await mitGrund(film, 48, grund);
          const auf = mit.map((m) => aufDemFremden(m, film));
          expect(Math.max(...auf), auf.join(' ')).toBe(0);
          expect(Math.max(...mit.slice(18).map(flaecheVon))).toBe(0);
          for (let n = 0; n < 12; n += 1) {
            expect(deckung(mit[n], scheibenMaske([hinaus(n)])), `Bild ${n}`).toBeGreaterThan(0.8);
          }
        });
        it(`${name}: kein Sprung auf einen kleinen Fremden nach dem Austritt`, async () => {
          const film: Film = { scheibe: hinaus, fremd: { x: 80, y: 60, ab: 22, r: 8 } };
          const mit = await mitGrund(film, 48, grund);
          expect(Math.max(...mit.slice(18).map(flaecheVon))).toBe(0);
        });
      }

      it('springt nicht auf ein Zweitobjekt, das das Modell nur halb sah, solange die Scheibe da war', async () => {
        const film: Film = { scheibe: hinaus, fremd: { x: 80, y: 60, ab: 0 } };
        const anzahl = 48;
        const grau = Array.from({ length: anzahl }, (_, n) => grauBild(n, film));
        const halb = (n: number) => {
          const maske = scheibenMaske([film.scheibe(n)]);
          const fremd = scheibenMaske([film.fremd ?? null]);
          const stufe = film.scheibe(n) ? 40 : 255;
          for (let i = 0; i < maske.length; i += 1)
            if (fremd[i]) maske[i] = Math.max(maske[i], stufe);
          return maske;
        };
        const spur = new Spur({
          grau,
          breite: W,
          hoehe: H,
          von: 0,
          bis: anzahl - 1,
          anker: 0,
          schluessel: schluesselBis(anzahl - 1),
          punkte: null,
          ankerMaske: halb(0),
          wiederBilder: 50,
          rechnen: async (n) => halb(n),
        });
        await laufen(spur);
        const masken = spur.ergebnis().masken;
        expect(Math.max(...masken.slice(18).map((m) => aufDemFremden(m, film)))).toBe(0);
      });
    });
  });
});

describe('komponentenFiltern', () => {
  const B = 40;
  const H = 30;
  function feld(bloecke: { x0: number; y0: number; x1: number; y1: number }[]): Uint8Array {
    const m = new Uint8Array(B * H);
    for (const k of bloecke) {
      for (let y = k.y0; y <= k.y1; y += 1)
        for (let x = k.x0; x <= k.x1; x += 1) m[y * B + x] = 255;
    }
    return m;
  }
  const links = { x0: 2, y0: 10, x1: 8, y1: 16 };
  const mitte = { x0: 18, y0: 10, x1: 24, y1: 16 };
  const amRand = { x0: 34, y0: 10, x1: 39, y1: 16 };

  it('behält, was eine Stelle trifft, und gibt sonst nichts zurück', () => {
    const maske = feld([links, mitte]);
    const raus = komponentenFiltern(maske, B, H, [{ x0: 20, y0: 12, x1: 21, y1: 13 }], false);
    expect(Array.from(raus)).toEqual(Array.from(feld([mitte])));
    expect(Math.max(...komponentenFiltern(maske, B, H, [], false))).toBe(0);
  });

  it('gibt die Maske selbst zurück, wenn alles bleibt', () => {
    const maske = feld([mitte]);
    expect(komponentenFiltern(maske, B, H, [mitte], false)).toBe(maske);
  });

  it('wirft Blasses weit weg vom Behaltenen weg – auch wenn jede Komponente trifft', () => {
    // Ein Dunst über das ganze Bild und ein halb gesehener zweiter Gegenstand.
    const maske = feld([mitte]);
    for (let i = 0; i < maske.length; i += 1) if (maske[i] === 0) maske[i] = 3;
    for (let y = links.y0; y <= links.y1; y += 1)
      for (let x = links.x0; x <= links.x1; x += 1) maske[y * B + x] = 90;
    const raus = komponentenFiltern(maske, B, H, [mitte], false);
    expect(raus).not.toBe(maske);
    // Der Kern bleibt, der Dunst nah an ihm auch, alles andere geht.
    expect(raus[13 * B + 20]).toBe(255);
    expect(raus[13 * B + 15]).toBe(3);
    expect(raus[13 * B + 4]).toBe(0);
    expect(raus[0]).toBe(0);
    expect(raus[29 * B + 39]).toBe(0);
  });

  it('behält mit `randErlaubt`, was den Bildrand berührt', () => {
    const maske = feld([mitte, amRand]);
    expect(Array.from(komponentenFiltern(maske, B, H, [], true))).toEqual(
      Array.from(feld([amRand])),
    );
  });

  it('verbindet über Ecken, aber nicht über einen blassen Saum', () => {
    const maske = feld([mitte]);
    // Über Eck angesetzt: gehört dazu.
    maske[17 * B + 25] = 255;
    // Ein blasser Steg zum linken Block: verbindet NICHT, bleibt aber als Saum nahe der Mitte.
    const mitLinks = feld([links, mitte]);
    for (let x = 9; x < 18; x += 1) mitLinks[13 * B + x] = 60;
    const raus = komponentenFiltern(mitLinks, B, H, [{ x0: 20, y0: 12, x1: 20, y1: 12 }], false);
    expect(raus[12 * B + 4]).toBe(0);
    expect(raus[13 * B + 16]).toBe(60);
    expect(komponentenFiltern(maske, B, H, [{ x0: 25, y0: 17, x1: 25, y1: 17 }], false)).toBe(
      maske,
    );
  });
});
