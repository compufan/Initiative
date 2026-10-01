import {
  BEREICH_NEUTRAL,
  neuesDoc,
  type Bereichston,
  type Maskenteil,
} from '../../src/modules/bild/doc.js';
import { flaeche2d } from '../../src/modules/bild/farbraum.js';
import { maskeUmrastern } from '../../src/modules/bild/maske.js';
import { szeneBauen, type Szene as RenderSzene } from '../../src/modules/bild/maskenSpeicher.js';
import { NEUTRAL } from '../../src/modules/bild/ton.js';
import { bildRechnen, gpuAbschalten, letzterWeg } from '../../src/modules/bild/tonGpu.js';
import type { StufenGuete } from '../../src/modules/bild/unscharf.js';
import { rleDekodieren, rleKodieren } from '../../src/modules/video/rle.js';

/**
 * Das Messgerüst für Weichzeichnen und Bokeh – es läuft IM Browser.
 *
 * Geladen wird die Datei von der Seite aus über den Entwicklungsserver
 * (`import('/e2e/hilfen/unscharfMessen.ts')`), wie `buehne.ts`: So kommen die
 * Module der App aus derselben Quelle wie in der App, und gerechnet wird mit
 * dem ECHTEN Renderer, nicht mit einer Nachbildung.
 *
 * # Szenen
 *
 * Alle mit Seitenverhältnis 4 : 3; die Geometrie skaliert mit `Breite / 1200`,
 * damit dieselbe Szene bei 600 und 1200 Punkten dasselbe zeigt.
 *
 * - **A**: ein rotes, kariert texturiertes Motiv (Kopf, Hals, Rumpf, Arm und
 *   eine 9 Punkte dünne Stange) auf grün gestreiftem Grund.
 * - **B**: dunkler Grund mit Lichtpunkten (Radius 2,6) einzeln und als Kette
 *   hinter dem Kopf, dunkles Motiv davor.
 * - **C**: drei Reihen Lichter für Masken, die von links nach rechts steigen.
 *
 * # Masken
 *
 * `netz` hat einen Saum von ±8 Punkten, Dunst ausserhalb (0 … 12) und
 * Zuversichtsrauschen innen (235 … 255), dann den Kasten `kanteWeichzeichnen`
 * mit Radius 1 – so sieht eine Netzmaske aus. `netzbreit` hat ±27 Punkte (wie
 * „U²-Net“), `video` zwei gegeneinander versetzte Netzmasken, überblendet und
 * durch die Lauflängen. Alle gehen als Netzteil durch `szeneBauen` – wie in
 * der App, samt Reinheit und Kernfeld.
 *
 * # Masse (Abstände in Bildpunkten bei 1200, zur 0,5-Isolinie der Maske)
 *
 * - **A** ausserhalb: Anteil der Bildpunkte mit Maske ≤ 15, die sich ändern;
 *   Reichweite = grösster Abstand, in dem mehr als 1 % um mehr als 2 Stufen
 *   abweichen.
 * - **B** Fremdfarbe innen: Anteil der Farbe des Gegenstücks (aus der
 *   Chromazität entmischt) je Abstand zur Kante.
 * - **C** Kantenbreite: 10–90-%-Breite des über 51 Randpunkte des Kopfes
 *   gemittelten Profils quer zur Kante.
 * - **D** Randschärfe: Kontrast bei ±4 Punkten, grösste Steigung, Lage der
 *   50-%-Kreuzung.
 * - **E** Lichter: Spitze, Inneres, Rand, Aussen, Streuung der Scheibe.
 */

export type Wert = number;

export interface Licht {
  x: number;
  y: number;
  r: number;
  farbe: [number, number, number];
  iso: boolean;
}

export interface Szene {
  art: 'A' | 'B' | 'C';
  W: number;
  H: number;
  orig: Uint8ClampedArray;
  nurGrund: Uint8ClampedArray;
  nurMotiv: Uint8ClampedArray;
  drin: Uint8Array;
  cov: Uint8Array;
  sd: Float32Array;
  punkte: Licht[];
  /** Rotanteil des reinen Grundes und des reinen Motivs – für die Entmischung. */
  rBg: number;
  rMo: number;
}

type Rgb = [number, number, number];

/* ---------- Hilfen ---------- */

const klemm = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function glatt(a: number, b: number, x: number): number {
  const t = klemm((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ein Streuwert 0 … 1 aus drei ganzen Zahlen – deterministisch, ohne Zufall. */
function streu(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Quadrierte euklidische Abstandstransformation nach Felzenszwalb, dann die Wurzel. */
function abstand(merkmal: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) d[i] = merkmal[i] ? 0 : INF;
  const n = Math.max(W, H);
  const f = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  const eine = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q += 1) {
      let s: number;
      for (;;) {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k] && k > 0) k -= 1;
        else break;
      }
      if (s <= z[k]) {
        v[0] = q;
        z[0] = -INF;
        z[1] = INF;
      } else {
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
    }
    k = 0;
    for (let q = 0; q < len; q += 1) {
      while (z[k + 1] < q) k += 1;
      const p = v[k];
      f[q] = (q - p) * (q - p) + f[p];
    }
  };
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) f[y] = d[y * W + x];
    eine(H);
    for (let y = 0; y < H; y += 1) d[y * W + x] = f[y];
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) f[x] = d[y * W + x];
    eine(W);
    for (let x = 0; x < W; x += 1) d[y * W + x] = Math.sqrt(f[x]);
  }
  return d;
}

/** Abstand zum Rand mit Vorzeichen: aussen positiv, innen negativ. */
function vorzeichenAbstand(drin: Uint8Array, W: number, H: number): Float32Array {
  const raus = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) raus[i] = drin[i] ? 0 : 1;
  const zumMotiv = abstand(drin, W, H);
  const zumGrund = abstand(raus, W, H);
  const s = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) s[i] = drin[i] ? -(zumGrund[i] - 0.5) : zumMotiv[i] - 0.5;
  return s;
}

/* ---------- Szene ---------- */

/** Die Silhouette als Funktion: Kopf, Hals, Rumpf, Arm, 9 Punkte dünne Stange. */
function silhouette(W: number): (x: number, y: number) => boolean {
  const u = W / 1200;
  const cx = 600 * u;
  return (x, y) => {
    if ((x - cx) ** 2 + (y - 290 * u) ** 2 < (115 * u) ** 2) return true;
    if (x > cx - 32 * u && x < cx + 32 * u && y > 380 * u && y < 450 * u) return true;
    const ex = (x - cx) / (230 * u);
    const ey = (y - 650 * u) / (280 * u);
    if (ex * ex + ey * ey < 1) return true;
    const ax = 420 * u;
    const ay = 520 * u;
    const bx = 250 * u;
    const by = 300 * u;
    const dx = bx - ax;
    const dy = by - ay;
    const t = klemm(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 < (30 * u) ** 2) return true;
    return x >= 1000 * u && x <= 1009 * u && y >= 110 * u && y <= 650 * u;
  };
}

const motivFarbe = (x: number, y: number): Rgb => {
  const k = (Math.floor(x / 14) + Math.floor(y / 14)) & 1;
  const n = (streu(x, y, 1) - 0.5) * 16;
  return k ? [205 + n, 45 + n * 0.3, 40 + n * 0.3] : [160 + n, 25 + n * 0.3, 25 + n * 0.3];
};
const grundFarbe = (x: number, y: number): Rgb => {
  const k = Math.floor((x + y) / 12) & 1;
  const n = (streu(x, y, 2) - 0.5) * 16;
  return k ? [45 + n * 0.3, 165 + n, 60 + n * 0.3] : [25 + n * 0.3, 115 + n, 45 + n * 0.3];
};
const dunkelFarbe = (x: number, y: number): Rgb => {
  const n = (streu(x, y, 3) - 0.5) * 6;
  return [12 + n, 12 + n, 18 + n];
};
const motivDunkel = (x: number, y: number): Rgb => {
  const k = (Math.floor(x / 14) + Math.floor(y / 14)) & 1;
  const n = (streu(x, y, 4) - 0.5) * 10;
  return k ? [78 + n, 66 + n, 60 + n] : [52 + n, 44 + n, 40 + n];
};

/** Die Chromazität (Rotanteil) eines Bildpunkts – Mass für „Motiv oder Grund“. */
function chroma(d: ArrayLike<number>, i: number): number {
  return d[i * 4] / (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2] + 1e-3);
}

function rotAnteil(d: ArrayLike<number>, W: number, H: number): number {
  let s = 0;
  for (let i = 0; i < W * H; i += 1) s += chroma(d, i);
  return s / (W * H);
}

const zettel = new Map<string, Szene>();

/** Baut (und merkt) eine Szene der Breite `W`. */
export function szeneHolen(art: 'A' | 'B' | 'C', W: number): Szene {
  const H = Math.round((W * 3) / 4);
  const schluessel = `${art}${W}`;
  const alt = zettel.get(schluessel);
  if (alt) return alt;

  const inside = art === 'C' ? () => false : silhouette(W);
  const n = W * H;
  const orig = new Uint8ClampedArray(n * 4);
  const nurGrund = new Uint8ClampedArray(n * 4);
  const nurMotiv = new Uint8ClampedArray(n * 4);
  const drin = new Uint8Array(n);
  const cov = new Uint8Array(n);
  const u = W / 1200;
  const grund = art === 'A' ? grundFarbe : dunkelFarbe;
  const motiv = art === 'A' ? motivFarbe : motivDunkel;

  const punkte: Licht[] = [];
  const r = 2.6 * u;
  if (art === 'B') {
    // Isoliert und weit auseinander (Messung), und eine Kette hinter dem Kopf.
    (
      [
        [110, 150],
        [330, 90],
        [900, 120],
        [1110, 330],
        [130, 560],
        [120, 790],
        [1100, 780],
        [930, 600],
      ] as const
    ).forEach(([x, y], i) =>
      punkte.push({
        x: x * u,
        y: y * u,
        r,
        farbe: i % 2 ? [255, 222, 170] : [255, 255, 255],
        iso: true,
      }),
    );
    for (let i = 0; i < 7; i += 1) {
      const y = (180 + 40 * Math.sin((i / 6) * Math.PI)) * u;
      punkte.push({ x: (350 + i * 75) * u, y, r, farbe: [255, 240, 200], iso: false });
    }
  }
  if (art === 'C') {
    const reihen: [number, Rgb][] = [
      [450, [255, 255, 255]],
      [200, [255, 230, 170]],
      [700, [200, 230, 255]],
    ];
    for (const [y, farbe] of reihen) {
      for (let i = 0; i < 9; i += 1) {
        punkte.push({ x: (90 + i * 127) * u, y: y * u, r, farbe, iso: true });
      }
    }
  }
  const lichtAn = (x: number, y: number) => {
    for (const p of punkte) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= p.r + 0.7) return { p, a: klemm(p.r + 0.5 - d, 0, 1) };
    }
    return null;
  };

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      let c = 0;
      for (let sy = 0; sy < 3; sy += 1)
        for (let sx = 0; sx < 3; sx += 1)
          if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) c += 1;
      c /= 9;
      cov[i] = Math.round(c * 255);
      drin[i] = inside(x + 0.5, y + 0.5) ? 1 : 0;
      const g = grund(x, y);
      const m = motiv(x, y);
      const l = lichtAn(x, y);
      const gl: Rgb = l
        ? [
            g[0] + (l.p.farbe[0] - g[0]) * l.a,
            g[1] + (l.p.farbe[1] - g[1]) * l.a,
            g[2] + (l.p.farbe[2] - g[2]) * l.a,
          ]
        : g;
      for (let k = 0; k < 3; k += 1) {
        orig[i * 4 + k] = gl[k] * (1 - c) + m[k] * c;
        nurGrund[i * 4 + k] = g[k];
        nurMotiv[i * 4 + k] = m[k];
      }
      orig[i * 4 + 3] = 255;
      nurGrund[i * 4 + 3] = 255;
      nurMotiv[i * 4 + 3] = 255;
    }
  }
  const sd = art === 'C' ? new Float32Array(n).fill(1e6) : vorzeichenAbstand(drin, W, H);
  const sz: Szene = {
    art,
    W,
    H,
    orig,
    nurGrund,
    nurMotiv,
    drin,
    cov,
    sd,
    punkte,
    rBg: rotAnteil(nurGrund, W, H),
    rMo: rotAnteil(nurMotiv, W, H),
  };
  zettel.set(schluessel, sz);
  return sz;
}

/* ---------- Masken ---------- */

/** Der Kasten von `kanteWeichzeichnen` (Stickers): Radius `r`, getrennt, Randpunkte geklemmt. */
function kanteWeich(alpha: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const f = r * 2 + 1;
  const wg = new Uint8Array(alpha.length);
  for (let y = 0; y < H; y += 1) {
    const z = y * W;
    let s = 0;
    for (let x = -r; x <= r; x += 1) s += alpha[z + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x += 1) {
      wg[z + x] = s / f;
      s -= alpha[z + Math.max(0, x - r)];
      s += alpha[z + Math.min(W - 1, x + r + 1)];
    }
  }
  const e = new Uint8Array(alpha.length);
  for (let x = 0; x < W; x += 1) {
    let s = 0;
    for (let y = -r; y <= r; y += 1) s += wg[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y += 1) {
      e[y * W + x] = s / f;
      s -= wg[Math.max(0, y - r) * W + x];
      s += wg[Math.min(H - 1, y + r + 1) * W + x];
    }
  }
  return e;
}

function motivAlpha(sz: Szene, art: 'hart' | 'weich' | 'netz', saum: number): Uint8Array {
  const { W, H, sd } = sz;
  const a = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const s = sd[i];
      if (art === 'hart') {
        a[i] = s < 0 ? 255 : 0;
      } else if (art === 'weich') {
        a[i] = Math.round(255 * (1 - glatt(-saum, saum, s)));
      } else {
        // Freistellnetz: weicher Saum, Dunst aussen 0 … 12, Zuversichtsrauschen
        // innen 235 … 255 – grossflächig verteilt, wie ein Modell es liefert.
        const w = 1 - glatt(-saum, saum, s);
        const gx = Math.floor(x / 3);
        const gy = Math.floor(y / 3);
        a[i] = Math.round(w * (235 + 20 * streu(gx, gy, 71)) + (1 - w) * (12 * streu(gx, gy, 72)));
      }
    }
  }
  return art === 'netz' ? kanteWeich(a, W, H, 1) : a;
}

function abtasten(m: Uint8Array, px: number, py: number, W: number, H: number): number {
  if (px < 0 || py < 0 || px > W - 1 || py > H - 1) return 0;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const ax = px - x0;
  const ay = py - y0;
  const o = m[y0 * W + x0] * (1 - ax) + m[y0 * W + x1] * ax;
  const un = m[y1 * W + x0] * (1 - ax) + m[y1 * W + x1] * ax;
  return o * (1 - ay) + un * ay;
}

/**
 * Eine verfolgte Videomaske: zwei Schlüsselmasken (um einen halben Bildpunkt
 * gegeneinander versetzt, die zweite leicht gewachsen), bei t = 0,5
 * überblendet und durch die Lauflängen gequantelt – wie in `objektFolge` und
 * `rle.ts`.
 */
function videoAlpha(netz: Uint8Array, W: number, H: number): Uint8Array {
  const aus = new Uint8Array(W * H);
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const va = abtasten(netz, x - 1.3, y + 0.7, W, H);
      const s = 1.004;
      const vb = abtasten(netz, cx + (x - 0.4 - cx) / s, cy + (y + 0.2 - cy) / s, W, H);
      aus[y * W + x] = Math.round(0.5 * va + 0.5 * vb);
    }
  }
  return rleDekodieren(rleKodieren(aus), W * H);
}

export type MaskenArt = 'hart' | 'weich20' | 'netz' | 'netzbreit' | 'video' | 'hverlauf';

export function maskeAlpha(sz: Szene, art: MaskenArt): Uint8Array {
  const { W, H } = sz;
  const u = W / 1200;
  switch (art) {
    case 'hart':
      return motivAlpha(sz, 'hart', 0);
    case 'weich20':
      return motivAlpha(sz, 'weich', 20 * u);
    case 'netz':
      return motivAlpha(sz, 'netz', 8 * u);
    case 'netzbreit':
      return motivAlpha(sz, 'netz', 27 * u);
    case 'video':
      return videoAlpha(motivAlpha(sz, 'netz', 8 * u), W, H);
    case 'hverlauf': {
      // Von links (0) nach rechts (255): wie eine Tiefenkarte, die nach hinten wachsende Unschärfe meint.
      const a = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) a[y * W + x] = Math.round((x / (W - 1)) * 255);
      return a;
    }
  }
}

let marke = 100000;

/** Ein Netzteil aus Alpha in Vorlagengrösse (= Bildgrösse), so wie es die App hält. */
export function netzTeil(alpha: Uint8Array, W: number, H: number, umkehren: boolean): Maskenteil {
  marke += 1;
  return {
    id: `n${marke}`,
    modus: 'dazu',
    umkehren,
    art: 'netz',
    netz: 'object',
    breite: W,
    hoehe: H,
    alpha,
    marke,
  };
}

/* ---------- Rendern ---------- */

export function leinwandAus(daten: Uint8ClampedArray, W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  // Im Arbeitsraum der Leinwand anlegen, sonst rechnet der Browser beim Einsetzen um.
  const ctx = flaeche2d(c, { willReadFrequently: true });
  if (!ctx) throw new Error('keine Leinwand');
  const id = ctx.createImageData(W, H);
  id.data.set(daten);
  ctx.putImageData(id, 0, 0);
  return c;
}

export function lesen(flaeche: CanvasImageSource, W: number, H: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = flaeche2d(c, { willReadFrequently: true });
  if (!ctx) throw new Error('keine Leinwand');
  ctx.drawImage(flaeche, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

export type Weg = 'gpu' | 'cpu';

/**
 * Rechnet eine Szene durch den echten Renderer – flüchtig, damit der
 * Merkzettel nicht das Bild des anderen Weges zurückgibt.
 */
export function rendern(
  orig: Uint8ClampedArray,
  W: number,
  H: number,
  szene: RenderSzene,
  weg: Weg,
  guete: StufenGuete = 'hoch',
  global = NEUTRAL,
): { daten: Uint8ClampedArray; weg: string; ms: number } {
  const quelle = leinwandAus(orig, W, H);
  gpuAbschalten(weg === 'cpu');
  const t0 = performance.now();
  const flaeche = bildRechnen(quelle, W, H, global, szene, { fluechtig: true, guete });
  const ms = performance.now() - t0;
  const gerechnet = letzterWeg;
  const daten = lesen(flaeche, W, H);
  gpuAbschalten(false);
  return { daten: new Uint8ClampedArray(daten), weg: gerechnet, ms };
}

/** Die Szene so, wie die App sie baut: ein Bereich mit einem Netzteil. */
export function bereichSzene(
  W: number,
  H: number,
  teile: Maskenteil[],
  anpassung: Partial<Bereichston>,
): RenderSzene {
  marke += 1;
  const doc = {
    ...neuesDoc(W, H),
    bereiche: [
      {
        id: `m${marke}`,
        name: 'Messung',
        aktiv: true,
        teile,
        anpassung: { ...BEREICH_NEUTRAL, ...anpassung },
      },
    ],
  };
  return szeneBauen(doc, W, H);
}

/* ---------- Masse ---------- */

const GRUPPEN = [0, 2, 4, 8, 16, 32, 64, 1e9];
function gruppe(x: number): number {
  for (let g = 0; g < GRUPPEN.length - 1; g += 1)
    if (x >= GRUPPEN[g] && x < GRUPPEN[g + 1]) return g;
  return GRUPPEN.length - 2;
}

export interface MassAB {
  /** Bildpunkte mit Maske ≤ 15, die sich veränderten – Soll 0. */
  geaendert15: number;
  anzahl15: number;
  /** Bildpunkte mit Maske 0, die sich veränderten – Soll 0. */
  geaendert0: number;
  /** Grösster Abstand (1200er Punkte) ausserhalb, in dem mehr als 1 % um mehr als 2 Stufen abweichen. */
  reichweite: number;
  /** Mittlere Abweichung (Stufen) ab 8 Punkten Abstand ausserhalb. */
  fern: number;
  /** Anteil Fremdfarbe innen bei 0–2 / 2–4 / ≥ 4 Punkten Abstand zur Kante. */
  fremd: [number, number, number];
}

/**
 * Die Masse A und B an einem Ergebnis.
 *
 * `maskImg` ist die Maske in Bildgrösse (der Bereich ist, wo sie hoch ist);
 * Abstände zur 0,5-Isolinie, auf 1200 Punkte umgerechnet. `fremd` sagt, aus
 * welchem Gegenstück Farbe hereinkommen könnte: 'motiv' wenn der Bereich der
 * Grund ist und umgekehrt.
 */
export function messenAB(
  sz: Szene,
  res: Uint8ClampedArray,
  maskImg: Uint8Array,
  fremd: 'motiv' | 'grund',
): MassAB {
  const { W, H, orig } = sz;
  const u = W / 1200;
  const n = W * H;
  const drinM = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) drinM[i] = maskImg[i] >= 128 ? 1 : 0;
  const sdM = vorzeichenAbstand(drinM, W, H);
  const G = GRUPPEN.length - 1;
  const aussen = {
    n: new Array<number>(G).fill(0),
    ueber2: new Array<number>(G).fill(0),
    dsum: new Array<number>(G).fill(0),
  };
  const innen = { n: new Array<number>(3).fill(0), fremd: new Array<number>(3).fill(0) };
  let a15 = 0;
  let g15 = 0;
  let g0 = 0;
  for (let i = 0; i < n; i += 1) {
    let dmax = 0;
    for (let k = 0; k < 3; k += 1)
      dmax = Math.max(dmax, Math.abs(res[i * 4 + k] - orig[i * 4 + k]));
    if (maskImg[i] === 0 && dmax > 0) g0 += 1;
    if (maskImg[i] <= 15) {
      a15 += 1;
      if (dmax > 0) g15 += 1;
    }
    const s = sdM[i] / u;
    if (s > 0) {
      const g = gruppe(s);
      aussen.n[g] += 1;
      aussen.dsum[g] += dmax;
      if (dmax > 2) aussen.ueber2[g] += 1;
    } else {
      const t = -s;
      const g = t < 2 ? 0 : t < 4 ? 1 : 2;
      // Anteil der Gegenfarbe aus der Chromazität: 0 = Grund, 1 = Motiv.
      const a = klemm((chroma(res, i) - sz.rBg) / (sz.rMo - sz.rBg), -0.5, 1.5);
      innen.n[g] += 1;
      innen.fremd[g] += fremd === 'motiv' ? a : 1 - a;
    }
  }
  let reichweite = 0;
  for (let g = 0; g < G; g += 1) {
    if (aussen.n[g] > 0 && aussen.ueber2[g] / aussen.n[g] > 0.01) {
      reichweite = GRUPPEN[g + 1] === 1e9 ? GRUPPEN[g] : GRUPPEN[g + 1];
    }
  }
  let fernSumme = 0;
  let fernAnzahl = 0;
  for (let g = 3; g < G; g += 1) {
    fernSumme += aussen.dsum[g];
    fernAnzahl += aussen.n[g];
  }
  return {
    geaendert15: g15,
    anzahl15: a15,
    geaendert0: g0,
    reichweite,
    fern: fernAnzahl ? fernSumme / fernAnzahl : 0,
    fremd: [0, 1, 2].map((g) => (innen.n[g] ? innen.fremd[g] / innen.n[g] : 0)) as [
      number,
      number,
      number,
    ],
  };
}

function bilinear(
  d: ArrayLike<number>,
  W: number,
  H: number,
  x: number,
  y: number,
  f: (d: ArrayLike<number>, i: number) => number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const ax = x - x0;
  const ay = y - y0;
  const v = (xx: number, yy: number) => f(d, klemm(yy, 0, H - 1) * W + klemm(xx, 0, W - 1));
  return (
    (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) +
    (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay
  );
}

function breite1090(profil: number[], ts: number[], vom: number, zum: number): number {
  if (Math.abs(zum - vom) < 1e-6) return Number.NaN;
  const norm = profil.map((p) => (p - vom) / (zum - vom));
  const finde = (stufe: number) => {
    for (let i = 0; i + 1 < norm.length; i += 1) {
      if ((norm[i] - stufe) * (norm[i + 1] - stufe) <= 0 && norm[i] !== norm[i + 1]) {
        return ts[i] + ((stufe - norm[i]) / (norm[i + 1] - norm[i])) * (ts[i + 1] - ts[i]);
      }
    }
    return Number.NaN;
  };
  return Math.abs(finde(0.9) - finde(0.1));
}

function lage50(profil: number[], ts: number[], vom: number, zum: number): number {
  if (Math.abs(zum - vom) < 1e-6) return Number.NaN;
  const norm = profil.map((p) => (p - vom) / (zum - vom));
  for (let i = 0; i + 1 < norm.length; i += 1) {
    if ((norm[i] - 0.5) * (norm[i + 1] - 0.5) <= 0 && norm[i] !== norm[i + 1]) {
      return ts[i] + ((0.5 - norm[i]) / (norm[i + 1] - norm[i])) * (ts[i + 1] - ts[i]);
    }
  }
  return Number.NaN;
}

export interface Kante {
  /** 10–90-%-Breite in 1200er Punkten. */
  breite: number;
  /** Kontrast bei ±4 Punkten (Original 1). */
  kontrast: number;
  /** Lage der 50-%-Kreuzung (1200er Punkte, + nach aussen). */
  versatz: number;
  /** Grösste Steigung je Punkt, auf das Original bezogen wird im Test. */
  steilheit: number;
}

/**
 * Das Profil quer zur Kopfkante, über 51 Randpunkte gemittelt, als Anteil
 * Motiv (aus der Chromazität). `ausschnitt` wählt das Bild: ein Ergebnis, das
 * Original, oder die Maske selbst.
 */
export function kante(sz: Szene, bild: Uint8ClampedArray | Uint8Array, alsMaske: boolean): Kante {
  const { W, H } = sz;
  const u = W / 1200;
  const cx = 600 * u;
  const cy = 290 * u;
  const r = 115 * u;
  const T = Math.round(40 * u);
  const ts: number[] = [];
  for (let t = -T; t <= T; t += 0.5) ts.push(t);
  const punkte: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let w = -75; w <= 75; w += 3) {
    const a = (w * Math.PI) / 180;
    punkte.push({
      x: cx + Math.sin(a) * r,
      y: cy - Math.cos(a) * r,
      nx: Math.sin(a),
      ny: -Math.cos(a),
    });
  }
  const f = alsMaske
    ? (d: ArrayLike<number>, i: number) => d[i] / 255
    : (d: ArrayLike<number>, i: number) =>
        klemm((chroma(d, i) - sz.rBg) / (sz.rMo - sz.rBg), -0.5, 1.5);
  const profil = ts.map((t) => {
    let s = 0;
    for (const q of punkte) s += bilinear(bild, W, H, q.x + q.nx * t, q.y + q.ny * t, f);
    return s / punkte.length;
  });
  // Abstände in 1200er Punkten ausdrücken.
  const tsU = ts.map((t) => t / u);
  const mitte = (a: number, b: number) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < tsU.length; i += 1) {
      if (tsU[i] >= a && tsU[i] <= b) {
        s += profil[i];
        n += 1;
      }
    }
    return s / n;
  };
  const innen = mitte(-30, -12);
  const aussen = mitte(12, 30);
  let steil = 0;
  for (let i = 1; i < tsU.length; i += 1)
    steil = Math.max(steil, Math.abs(profil[i] - profil[i - 1]) / (tsU[i] - tsU[i - 1]));
  return {
    breite: breite1090(profil, tsU, innen, aussen),
    kontrast: mitte(-5, -3) - mitte(3, 5),
    versatz: lage50(profil, tsU, innen, aussen),
    steilheit: steil,
  };
}

export interface Lichter {
  spitze: number;
  innen: number;
  /** Rand zu Innen: Eine Scheibe hat eine Kante, eine Glocke nicht. */
  randZuInnen: number;
  /** Aussen zu Innen: je kleiner, desto schärfer die Kante. */
  aussenZuInnen: number;
  /** Streuung im Inneren, auf das Innere bezogen. */
  streuung: number;
}

/**
 * Die isolierten Lichtpunkte: radiales Mittel um jedes in Schritten von
 * 0,05 R bis 1,7 R und die Streuung am Ring.
 */
export function lichterMessen(sz: Szene, res: Uint8ClampedArray, R: number): Lichter {
  const { W, H } = sz;
  const iso = sz.punkte.filter((p) => p.iso);
  const schritt = 0.05;
  const n = Math.round(1.7 / schritt);
  const werte: number[][] = Array.from({ length: n }, () => []);
  let spitze = 0;
  for (const p of iso) {
    for (
      let y = Math.max(0, Math.floor(p.y - R * 1.8));
      y <= Math.min(H - 1, Math.ceil(p.y + R * 1.8));
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(p.x - R * 1.8));
        x <= Math.min(W - 1, Math.ceil(p.x + R * 1.8));
        x += 1
      ) {
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) / R;
        const b = Math.floor(d / schritt);
        if (b >= n) continue;
        const i = y * W + x;
        const v = (res[i * 4] + res[i * 4 + 1] + res[i * 4 + 2]) / 3;
        werte[b].push(v);
        if (d < 1 && v > spitze) spitze = v;
      }
    }
  }
  const radial = werte.map((w) => (w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0));
  const ringStreu = werte.map((w, i) => {
    if (w.length < 4) return 0;
    const m = radial[i];
    return Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / w.length);
  });
  const mittel = (feld: number[], a: number, b: number) => {
    let s = 0;
    let c = 0;
    for (let i = 0; i < n; i += 1) {
      const d = (i + 0.5) * schritt;
      if (d >= a && d <= b) {
        s += feld[i];
        c += 1;
      }
    }
    return c ? s / c : 0;
  };
  const innen = mittel(radial, 0.15, 0.75);
  return {
    spitze,
    innen,
    randZuInnen: innen > 0 ? mittel(radial, 0.85, 0.97) / innen : 0,
    aussenZuInnen: innen > 0 ? mittel(radial, 1.15, 1.45) / innen : 0,
    streuung: innen > 0 ? mittel(ringStreu, 0.15, 0.75) / innen : 0,
  };
}

/* ---------- ein ganzer Fall ---------- */

export interface FallEingabe {
  art: 'A' | 'B' | 'C';
  W: number;
  maske: MaskenArt;
  /** Wer unscharf wird: der Grund (Maske umgekehrt, Porträtmodus) oder das Motiv. */
  ziel: 'motiv' | 'grund';
  par: Partial<Bereichston>;
  wege?: Weg[];
  guete?: StufenGuete;
  /** Die Ergebnisbilder mitgeben – gross, nur zum Ansehen. */
  bilder?: boolean;
}

export interface FallAusgabe {
  W: number;
  H: number;
  /** Je Weg: die Masse. */
  weg: Record<
    string,
    { gerechnet: string; ms: number; ab: MassAB; kante: Kante; lichter: Lichter | null }
  >;
  original: Kante;
  maskeKante: Kante;
  /** Grafikeinheit gegen Prozessor: grösster Unterschied, Mittel. */
  gleich: { max: number; mittel: number } | null;
  /** Die Ergebnisse zum Ansehen (Länge W · H · 4), je Weg – nur auf Wunsch. */
  bilder?: Record<string, Uint8ClampedArray>;
}

/**
 * Rechnet einen Fall durch den echten Renderer auf den gewünschten Wegen und
 * misst ihn. `par.bokeh` und `par.unschaerfe` sind die Regler.
 */
export function fall(e: FallEingabe): FallAusgabe {
  const sz = szeneHolen(e.art, e.W);
  const { W, H } = sz;
  const alpha = maskeAlpha(sz, e.maske);
  const teil = netzTeil(alpha, W, H, e.ziel === 'grund');
  const szene = bereichSzene(W, H, [teil], e.par);
  const b0 = szene.bereiche[0];
  const maskImg = maskeUmrastern(
    b0.maske.feld,
    b0.maske.raster.breite,
    b0.maske.raster.hoehe,
    W,
    H,
  );
  const gegen: 'motiv' | 'grund' = e.ziel === 'motiv' ? 'grund' : 'motiv';
  const aus: FallAusgabe = {
    W,
    H,
    weg: {},
    original: kante(sz, sz.orig, false),
    maskeKante: kante(sz, maskImg, true),
    gleich: null,
  };
  const R = Math.min(96, (e.par.bokeh ?? 0) * 0.02 * Math.max(W, H));
  const bilder: Record<string, Uint8ClampedArray> = {};
  for (const weg of e.wege ?? ['gpu', 'cpu']) {
    const r = rendern(sz.orig, W, H, szene, weg, e.guete ?? 'hoch');
    bilder[weg] = r.daten;
    aus.weg[weg] = {
      gerechnet: r.weg,
      ms: r.ms,
      ab: messenAB(sz, r.daten, maskImg, gegen),
      kante: kante(sz, r.daten, false),
      // Die Scheibe ist ein Sechseck; im Mittel liegt sein Rand bei 0,87 R.
      lichter: e.art === 'B' ? lichterMessen(sz, r.daten, R * 0.87 || 1) : null,
    };
  }
  if (e.bilder) aus.bilder = bilder;
  const g = bilder.gpu;
  const c = bilder.cpu;
  if (g && c) {
    let max = 0;
    let summe = 0;
    for (let i = 0; i < W * H; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        const d = Math.abs(g[i * 4 + k] - c[i * 4 + k]);
        if (d > max) max = d;
        summe += d;
      }
    }
    aus.gleich = { max, mittel: summe / (W * H * 3) };
  }
  return aus;
}
