import { describe, expect, it, vi } from 'vitest';

import { flutmaske } from '../stickers/engines/flutung.js';
import type { InhaltsTeil } from './bildweise.js';
import type { GelesenesBild } from './bilderLesen.js';
import { folgeTeile } from './folgeTeile.js';
import { Spur } from './objektFolge.js';
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
    const wahr = !m
      ? new Uint8Array(B * H)
      : art === 'tipp'
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
     * Ablehnungen galt das: 83 % des Bildes, bis zum Ende. Jetzt fallen
     * Punkte, die das Bild verlassen, weg.
     */
    const szene: Szene = {
      mitte: (n) => (n < 20 ? { x: 200 + 8 * n, y: 90 } : null),
      kamera: ruhig,
      gemustert: true,
    };
    const erg = await messen(szene, 'tipp', 40);
    const text = erg.werte.map((w) => w.toFixed(2)).join(' ');
    expect(Math.min(...erg.werte.slice(15)), text).toBe(1);
    expect(Math.min(...erg.werte.slice(0, 14)), text).toBeGreaterThan(0.9);
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
