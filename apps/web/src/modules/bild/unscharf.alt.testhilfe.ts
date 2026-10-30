/**
 * Die Prozessorfassung von `unscharfAufBytes`, wie sie bis Oktober 2026 lief
 * – nur für den Vergleich alt/neu in `unscharf.test.ts`.
 *
 * WARUM eine Kopie: Die neue Fassung rechnet in Streifen, ohne Gleitkomma-
 * felder in Bildgrösse. Sie soll Byte für Byte dasselbe Bild liefern; das
 * prüft man am besten gegen den alten Text selbst, nicht gegen Beispielwerte.
 * Wird nirgends sonst eingebunden.
 */

import {
  DECKUNG_BIS,
  DECKUNG_VON,
  ECKE_0,
  ECKE_1,
  ECKE_2,
  EINBLENDUNG_BIS,
  GAUSS_GRENZE,
  GAUSS_MAX,
  GUETEN,
  arbeitsFaktor,
  glatt,
  kernGewicht,
  lichtGewicht,
  linienAnzahl,
  rampe,
  reinWert,
  staerke,
  stufenAnzahl,
  type StufenGuete,
  type UnscharfQuelle,
} from './unscharf.js';
import { zuLinear, zuSrgb } from './ton.js';

/** sRGB-Byte → lineares Licht, als Tabelle. */
const ZU_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) t[i] = zuLinear(i / 255);
  return t;
})();

/** Ein Feld aus vier Gleitkommazahlen je Punkt, bilinear lesbar. */
function bilinear(
  feld: Float32Array,
  wb: number,
  wh: number,
  px: number,
  py: number,
  aus: Float32Array,
): void {
  // Texelmitten bei +0,5, am Rand geklemmt – wie die Grafikeinheit mit
  // CLAMP_TO_EDGE und LINEAR.
  const x = px - 0.5;
  const y = py - 0.5;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 >= wb ? wb - 1 : x0;
  x1 = x1 < 0 ? 0 : x1 >= wb ? wb - 1 : x1;
  y0 = y0 < 0 ? 0 : y0 >= wh ? wh - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= wh ? wh - 1 : y1;
  const a = (y0 * wb + x0) * 4;
  const b = (y0 * wb + x1) * 4;
  const c = (y1 * wb + x0) * 4;
  const d = (y1 * wb + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  aus[0] = feld[a] * w00 + feld[b] * w10 + feld[c] * w01 + feld[d] * w11;
  aus[1] = feld[a + 1] * w00 + feld[b + 1] * w10 + feld[c + 1] * w01 + feld[d + 1] * w11;
  aus[2] = feld[a + 2] * w00 + feld[b + 2] * w10 + feld[c + 2] * w01 + feld[d + 2] * w11;
  aus[3] = feld[a + 3] * w00 + feld[b + 3] * w10 + feld[c + 3] * w01 + feld[d + 3] * w11;
}

/**
 * Eine Strecke: das Mittel über `n` Stellen von jedem Arbeitspunkt bis dort,
 * wohin `(ex, ey)` zeigt (in Arbeitspunkten).
 *
 * Die Stellen liegen bei `(j + ½) / n` der Strecke – dieselbe Mittelpunkt-
 * konvention wie im Schattierer, damit beide Wege dieselben Punkte lesen.
 */
function strecke(
  quelle: Float32Array,
  wb: number,
  wh: number,
  ex: number,
  ey: number,
  n: number,
  ziel: Float32Array,
): void {
  const t = new Float32Array(4);
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < wb; x += 1) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let j = 0; j < n; j += 1) {
        const u = (j + 0.5) / n;
        bilinear(quelle, wb, wh, x + 0.5 + ex * u, y + 0.5 + ey * u, t);
        s0 += t[0];
        s1 += t[1];
        s2 += t[2];
        s3 += t[3];
      }
      const o = (y * wb + x) * 4;
      ziel[o] = s0 / n;
      ziel[o + 1] = s1 / n;
      ziel[o + 2] = s2 / n;
      ziel[o + 3] = s3 / n;
    }
  }
}

/**
 * Die drei Rauten zum Sechseck, auf den Akkumulator der Stufen addiert.
 *
 * `H = (L_e1(T0) + L_e2(T0) + L_e2(T1)) / 3`: Die Faltung je zweier Strecken
 * ist eine Raute, und drei Rauten in den Richtungen 0/1, 0/2 und 1/2 ergeben
 * ein regelmässiges Sechseck mit flacher Mitte und scharfer Kante.
 */
function rauten(
  t0: Float32Array,
  t1: Float32Array,
  wb: number,
  wh: number,
  e1: readonly [number, number],
  e2: readonly [number, number],
  n: number,
  akku: Float32Array,
): void {
  const t = new Float32Array(4);
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < wb; x += 1) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let j = 0; j < n; j += 1) {
        const u = (j + 0.5) / n;
        bilinear(t0, wb, wh, x + 0.5 + e1[0] * u, y + 0.5 + e1[1] * u, t);
        s0 += t[0];
        s1 += t[1];
        s2 += t[2];
        s3 += t[3];
        bilinear(t0, wb, wh, x + 0.5 + e2[0] * u, y + 0.5 + e2[1] * u, t);
        s0 += t[0];
        s1 += t[1];
        s2 += t[2];
        s3 += t[3];
        bilinear(t1, wb, wh, x + 0.5 + e2[0] * u, y + 0.5 + e2[1] * u, t);
        s0 += t[0];
        s1 += t[1];
        s2 += t[2];
        s3 += t[3];
      }
      const o = (y * wb + x) * 4;
      const teiler = 3 * n;
      akku[o] += s0 / teiler;
      akku[o + 1] += s1 / teiler;
      akku[o + 2] += s2 / teiler;
      akku[o + 3] += s3 / teiler;
    }
  }
}

/** Der Zustand der Rechnung: Licht (linear), Einfluss, und die Masse. */
interface Zustand {
  readonly breite: number;
  readonly hoehe: number;
  /** Lineares Licht, drei Zahlen je Bildpunkt. */
  readonly licht: Float32Array;
  /** Wie stark die Unschärfe an diesem Bildpunkt gewirkt hat, 0 … 1. */
  readonly einfluss: Float32Array;
}

function bokehStufe(z: Zustand, q: UnscharfQuelle, guete: StufenGuete): void {
  const { breite: W, hoehe: H, licht, einfluss } = z;
  const n = W * H;
  const g = GUETEN[guete];
  const { bokehPx: R, reinheit } = q.ebene;
  const K = stufenAnzahl(reinheit, guete);
  const f = arbeitsFaktor(R, g.arbeitsradius, W, H);
  const wb = Math.ceil(W / f);
  const wh = Math.ceil(H / f);

  /*
   * Je Quellpunkt einmal: seine Stufe (0 = streut nicht), sein Gewicht, seine
   * Stärke. Die Stufe `k = ⌊s·K + ½⌋` ordnet jede Quelle genau einem Radius
   * zu; wer keine Stufe hat oder kein Kerngewicht, wird nie eingesammelt.
   */
  const stufe = new Uint8Array(n);
  const gewicht = new Float32Array(n);
  const staerken = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const m = q.maske[i] / 255;
    const rein = reinWert(m, q.kern ? q.kern[i] / 255 : 0, reinheit);
    const s = staerke(m, rein, reinheit);
    staerken[i] = s;
    const band = Math.floor(s * K + 0.5);
    const kg = kernGewicht(rein, reinheit);
    if (band === 0 || kg === 0) continue;
    const hell = Math.max(licht[i * 3], licht[i * 3 + 1], licht[i * 3 + 2]);
    stufe[i] = band;
    gewicht[i] = lichtGewicht(hell) * kg;
  }

  const p = new Float32Array(wb * wh * 4);
  const t0 = new Float32Array(wb * wh * 4);
  const t1 = new Float32Array(wb * wh * 4);
  const akku = new Float32Array(wb * wh * 4);
  const teilerVorbereitung = 1 / (f * f);

  for (let k = 1; k <= K; k += 1) {
    const rk = (R / f) * (k / K);
    const nn = linienAnzahl(rk, g.dichte);
    /*
     * Vorbereitung: Licht mal Gewicht und Gewicht, gemittelt über den Block.
     * Am Bildrand wird auf den Randpunkt geklemmt, nicht mit fehlenden
     * Punkten gemittelt – sonst hätte der Randblock weniger Gewicht, und die
     * Grafikeinheit rechnet es anders.
     */
    for (let wy = 0; wy < wh; wy += 1) {
      for (let wx = 0; wx < wb; wx += 1) {
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let sw = 0;
        for (let j = 0; j < f; j += 1) {
          const y = Math.min(wy * f + j, H - 1);
          for (let i = 0; i < f; i += 1) {
            const at = y * W + Math.min(wx * f + i, W - 1);
            if (stufe[at] !== k) continue;
            const w = gewicht[at];
            s0 += licht[at * 3] * w;
            s1 += licht[at * 3 + 1] * w;
            s2 += licht[at * 3 + 2] * w;
            sw += w;
          }
        }
        const o = (wy * wb + wx) * 4;
        p[o] = s0 * teilerVorbereitung;
        p[o + 1] = s1 * teilerVorbereitung;
        p[o + 2] = s2 * teilerVorbereitung;
        p[o + 3] = sw * teilerVorbereitung;
      }
    }
    strecke(p, wb, wh, ECKE_0[0] * rk, ECKE_0[1] * rk, nn, t0);
    strecke(p, wb, wh, ECKE_1[0] * rk, ECKE_1[1] * rk, nn, t1);
    rauten(
      t0,
      t1,
      wb,
      wh,
      [ECKE_1[0] * rk, ECKE_1[1] * rk],
      [ECKE_2[0] * rk, ECKE_2[1] * rk],
      nn,
      akku,
    );
  }

  /*
   * Zusammensetzen: Summe über alle Stufen, Rückfall aufs Original nach
   * Deckung, Einblendung nach Stärke. Ein Empfänger ohne Stufe (`k = 0`) bleibt
   * unberührt, wie dicht auch immer Quellen um ihn liegen.
   */
  const t = new Float32Array(4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const s = staerken[i];
      const ein = rampe(s, 0, EINBLENDUNG_BIS);
      if (!(ein > 0) || !(s > 0)) continue;
      if (Math.floor(s * K + 0.5) < 1) continue;
      bilinear(akku, wb, wh, ((x + 0.5) / W) * wb, ((y + 0.5) / H) * wh, t);
      const deck = glatt(DECKUNG_VON, DECKUNG_BIS, t[3]);
      const a = deck * ein;
      for (let c = 0; c < 3; c += 1) {
        const roh = licht[i * 3 + c];
        const bl = t[3] > 1e-6 ? t[c] / t[3] : roh;
        licht[i * 3 + c] = roh + (bl - roh) * a;
      }
      if (a > einfluss[i]) einfluss[i] = a;
    }
  }
}

function weichStufe(z: Zustand, q: UnscharfQuelle): void {
  const { breite: W, hoehe: H, licht, einfluss } = z;
  const n = W * H;
  const { weichPx: sigma, reinheit } = q.ebene;
  const f = arbeitsFaktor(sigma * 3, GAUSS_GRENZE, W, H);
  const wb = Math.ceil(W / f);
  const wh = Math.ceil(H / f);

  const staerken = new Float32Array(n);
  const kern = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const m = q.maske[i] / 255;
    const rein = reinWert(m, q.kern ? q.kern[i] / 255 : 0, reinheit);
    staerken[i] = staerke(m, rein, reinheit);
    kern[i] = kernGewicht(rein, reinheit);
  }

  // Vorbereitung: Licht mal Kerngewicht und Kerngewicht, gemittelt über den Block.
  const p = new Float32Array(wb * wh * 4);
  const teilerVorbereitung = 1 / (f * f);
  for (let wy = 0; wy < wh; wy += 1) {
    for (let wx = 0; wx < wb; wx += 1) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let sw = 0;
      for (let j = 0; j < f; j += 1) {
        const y = Math.min(wy * f + j, H - 1);
        for (let i = 0; i < f; i += 1) {
          const at = y * W + Math.min(wx * f + i, W - 1);
          const w = kern[at];
          if (w === 0) continue;
          s0 += licht[at * 3] * w;
          s1 += licht[at * 3 + 1] * w;
          s2 += licht[at * 3 + 2] * w;
          sw += w;
        }
      }
      const o = (wy * wb + wx) * 4;
      p[o] = s0 * teilerVorbereitung;
      p[o + 1] = s1 * teilerVorbereitung;
      p[o + 2] = s2 * teilerVorbereitung;
      p[o + 3] = sw * teilerVorbereitung;
    }
  }

  // Gauss, getrennt: erst waagerecht, dann senkrecht, am Rand geklemmt.
  const sig = Math.max(0.3, sigma / f);
  const r = Math.min(GAUSS_MAX, Math.ceil((sigma / f) * 3));
  const gew = new Float32Array(2 * r + 1);
  let gewSumme = 0;
  for (let j = -r; j <= r; j += 1) {
    gew[j + r] = Math.exp(-(j * j) / (2 * sig * sig));
    gewSumme += gew[j + r];
  }
  const quer = new Float32Array(wb * wh * 4);
  const fertig = new Float32Array(wb * wh * 4);
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < wb; x += 1) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let j = -r; j <= r; j += 1) {
        const xx = Math.min(wb - 1, Math.max(0, x + j));
        const at = (y * wb + xx) * 4;
        const w = gew[j + r];
        a0 += w * p[at];
        a1 += w * p[at + 1];
        a2 += w * p[at + 2];
        a3 += w * p[at + 3];
      }
      const o = (y * wb + x) * 4;
      quer[o] = a0 / gewSumme;
      quer[o + 1] = a1 / gewSumme;
      quer[o + 2] = a2 / gewSumme;
      quer[o + 3] = a3 / gewSumme;
    }
  }
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < wb; x += 1) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let j = -r; j <= r; j += 1) {
        const yy = Math.min(wh - 1, Math.max(0, y + j));
        const at = (yy * wb + x) * 4;
        const w = gew[j + r];
        a0 += w * quer[at];
        a1 += w * quer[at + 1];
        a2 += w * quer[at + 2];
        a3 += w * quer[at + 3];
      }
      const o = (y * wb + x) * 4;
      fertig[o] = a0 / gewSumme;
      fertig[o + 1] = a1 / gewSumme;
      fertig[o + 2] = a2 / gewSumme;
      fertig[o + 3] = a3 / gewSumme;
    }
  }

  // Zusammensetzen: Überblendung nach Stärke, Rückfall nach Deckung.
  const t = new Float32Array(4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const s = staerken[i];
      if (!(s > 0)) continue;
      bilinear(fertig, wb, wh, ((x + 0.5) / W) * wb, ((y + 0.5) / H) * wh, t);
      const deck = glatt(DECKUNG_VON, DECKUNG_BIS, t[3]);
      const a = deck * s;
      for (let c = 0; c < 3; c += 1) {
        const roh = licht[i * 3 + c];
        const bl = t[3] > 1e-6 ? t[c] / t[3] : roh;
        licht[i * 3 + c] = roh + (bl - roh) * a;
      }
      if (a > einfluss[i]) einfluss[i] = a;
    }
  }
}

/**
 * Weichzeichnen und Bokeh über ein RGBA-Feld – der Weg ohne Grafikeinheit.
 *
 * Arbeitet an Ort und Stelle und rührt nur R, G und B an, und nur dort, wo
 * die Unschärfe wirklich gewirkt hat: Alles andere behält sein Byte, so dass
 * ausserhalb der Maske (und bei neutralen Reglern) das Bild gleich bleibt –
 * nicht „fast“, sondern Byte für Byte.
 *
 * Mehrere Bereiche laufen nacheinander, jeder auf dem Ergebnis des vorigen;
 * je Bereich erst Bokeh, dann Weichzeichnen.
 *
 * Zurück kommt der Einfluss je Bildpunkt (0 … 255). Wer danach noch schärft,
 * dämpft damit: Sonst holte die Schärfe die Hochfrequenz zurück, die gerade
 * entfernt wurde.
 */
export function unscharfAufBytesAlt(
  daten: Uint8ClampedArray,
  breite: number,
  hoehe: number,
  quellen: readonly UnscharfQuelle[],
  guete: StufenGuete,
): Uint8Array {
  const n = breite * hoehe;
  const einfluss8 = new Uint8Array(Math.max(0, n));
  if (n <= 0 || daten.length < n * 4 || quellen.length === 0) return einfluss8;

  const licht = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    licht[i * 3] = ZU_LINEAR[daten[i * 4]];
    licht[i * 3 + 1] = ZU_LINEAR[daten[i * 4 + 1]];
    licht[i * 3 + 2] = ZU_LINEAR[daten[i * 4 + 2]];
  }
  const z: Zustand = { breite, hoehe, licht, einfluss: new Float32Array(n) };
  for (const q of quellen) {
    if (q.ebene.bokehPx > 0) bokehStufe(z, q, guete);
    if (q.ebene.weichPx > 0) weichStufe(z, q);
  }

  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, zuSrgb(Math.max(0, v)))) * 255);
  for (let i = 0; i < n; i += 1) {
    const a = Math.round(z.einfluss[i] * 255);
    einfluss8[i] = a;
    // Unter einem halben Byte Einfluss gilt der Bildpunkt als unberührt –
    // dieselbe Regel wie im Schattierer, dessen Alphakanal nur 8 Bit hat.
    if (a === 0) continue;
    daten[i * 4] = byte(licht[i * 3]);
    daten[i * 4 + 1] = byte(licht[i * 3 + 1]);
    daten[i * 4 + 2] = byte(licht[i * 3 + 2]);
  }
  return einfluss8;
}
