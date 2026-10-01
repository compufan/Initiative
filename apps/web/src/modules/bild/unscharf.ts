/**
 * Weichzeichnen und Bokeh an der Maske – alles, was Prozessor und
 * Grafikeinheit teilen, und die Rechnung auf dem Prozessor.
 *
 * # Zwei Regler, zwei Dinge
 *
 * - **Weichzeichnen** (`unschaerfe`): ein gewöhnlicher Gauss, überblendet nach
 *   der Stärke der Maske. Eine Mattscheibe vor dem Sensor.
 * - **Bokeh** (`bokeh`): eine Linse. Der Radius der Blendenscheibe wächst mit
 *   der Stärke der Maske, helle Stellen wiegen schwerer und werden zu
 *   sichtbaren Scheiben.
 *
 * Beide dürfen zugleich wirken, in dieser Reihenfolge: erst die Linse, dann
 * die Mattscheibe. So bekommt die Scheibe bei Weichzeichnen > 0 einen weichen
 * Rand und bleibt bei 0 scharf berandet; andersherum verwischte der Gauss die
 * Lichter, bevor sie verstärkt werden, und nähme ihnen die Spitze.
 *
 * # Warum es keine Scheibe aus Zufallstupfen mehr gibt
 *
 * Vorher ersetzte der Schattierer jeden Bildpunkt mit Maske > 0,002 durch 48
 * Zufallstupfen im Radius ∝ Maske. Gemessen an einer Netzmaske (Staub 0 … 12
 * von 255, Saum 11 Punkte): 92 % der Bildpunkte mit Maske ≤ 15 änderten sich,
 * die Wirkung reichte über 64 Punkte hinaus, im Saum kam 40 % Fremdfarbe
 * herein, und ein Lichtpunkt wurde eine körnige Scheibe (Streuung 0,61). Der
 * Weg ohne Grafikeinheit rechnete ein anderes, kaputtes Bild. Drei Dinge
 * ändern das:
 *
 * 1. **Stärke statt Maske.** Staub und Zuversichtsrauschen der Netze liegen
 *    unter 0,25 und über 0,75; die Unschärfe wirkt erst dazwischen. Die Maske
 *    selbst bleibt, wie sie ist – die Farbregler im Bereich sehen dieselbe
 *    weiche Kante wie bisher.
 * 2. **Kern statt Rand.** Eingesammelt werden nur Bildpunkte, die sicher zum
 *    Bereich gehören (Kerngewicht). Der Saum ist eine Mischfarbe aus Motiv und
 *    Grund; wer ihn mitmittelt, holt den Hof herein. Wo gar nichts Gültiges in
 *    der Nähe liegt, bleibt das Original (Deckung).
 * 3. **Eine Faltung statt Zufall.** Die Blende ist ein Sechseck aus drei
 *    Rauten (fünf Strecken), gefaltet über vorgemittelte Arbeitspunkte. Kein
 *    Rauschen, keine Wirbel, keine Potenzspreizung.
 *
 * # Die Stufen
 *
 * Der Radius folgt der Stärke in Stufen: Jede Quelle gehört genau einer Stufe
 * (Radius `R · k / K`), und das Ergebnis ist die SUMME über alle Stufen. Das
 * ist physikalisch das Streuen je Quelle. Verworfen wurden „Stufe des
 * Empfängers wählen“ (Halbscheiben an den Stufengrenzen) und lineares
 * Überblenden der Stufen (Doppelscheiben).
 *
 * # Gleiche Rechnung auf beiden Wegen
 *
 * Diese Datei und `unscharfGpu.ts` bauen dieselben Strecken mit demselben
 * Abtastmuster, dieselbe Stärke, denselben Kern, dieselben Stufen. Die
 * Prozessorfassung ist nicht durch andere Mathematik schneller, sondern durch
 * den Arbeitsmassstab. Die Konstanten stehen hier einmal; die GLSL-Texte
 * bekommen sie per `${…}` eingesetzt.
 */

import type { Bereichston } from './doc.js';
import type { Reinheit } from './maskenSpeicher.js';
import { zuLinear, zuSrgb } from './ton.js';

/* ---------- Konstanten ---------- */

/**
 * Staub- und Saumgrenze der Stärke: Unter 0,03 wirkt nichts, ab 0,97 voll.
 * Bei Silhouetten kommt `REINHEIT_*` dazu und strafft den Saum auf etwa 40 %.
 */
export const STAERKE_VON = 0.03;
export const STAERKE_BIS = 0.97;
/** Bei Silhouetten und gemischten Masken: ab wann der Kernwert die Stärke freigibt. */
export const REINHEIT_VON = 0.25;
export const REINHEIT_BIS = 0.75;
/** Das Kerngewicht: ab 0,5 zählt ein Bildpunkt ein wenig, ab 0,9 voll. */
export const KERN_VON = 0.5;
export const KERN_BIS = 0.9;
/** Die Deckung: Unter 2 % gültiger Fläche bleibt das Original, ab 20 % gilt das Ergebnis. */
export const DECKUNG_VON = 0.02;
export const DECKUNG_BIS = 0.2;
/** Bokeh blendet sein Ergebnis bis zu dieser Stärke ein – ein Saum ist kein Sprung. */
export const EINBLENDUNG_BIS = 0.5;
/**
 * Die Verstärkung heller Stellen: Gewicht `1 + LICHT_STAERKE · glatt(VON, BIS, Hellstes)`
 * auf lineares Licht, danach normiert. Ein gewichtetes Mittel, keine
 * Energiesumme – eine gleichmässig helle Fläche blüht dadurch nicht auf.
 *
 * Gemessen (Licht 2,6 Punkte, Radius 24): Inneres der Scheibe 172 von 255,
 * bei 20/60/120/240 waren es 70/105/132/160. 100 ist der Kompromiss zwischen
 * „erkennbar“ und „Himmel blüht auf“. Noch nicht an echten Fotos gesehen.
 */
export const LICHT_STAERKE = 100;
export const LICHT_VON = 0.6;
export const LICHT_BIS = 0.98;
/** Regler 1 entspricht diesem Anteil der längeren Bildkante – wie schon `bokehRadius` früher. */
export const BOKEH_ANTEIL = 0.02;
export const WEICH_ANTEIL = 0.012;
/** Der Radius der Scheibe in der Ausgabe nie über so viele Bildpunkte. */
export const BOKEH_MAX = 96;
/** Darunter wäre die Stufe schmaler als ein Bildpunkt – sie entfällt, das Bild bleibt bytegleich. */
export const BOKEH_MIN = 0.75;
export const WEICH_MIN = 0.4;
/** Abtastungen je Strecke höchstens, Gauss-Halbbreite höchstens (Arbeitspunkte). */
export const LINIE_MAX = 63;
export const GAUSS_MAX = 64;
/** Wieviele Arbeitspunkte der Gauss in die Breite rechnet, bevor der Massstab wächst. */
export const GAUSS_GRENZE = 12;
/** Die grösste Verkleinerung des Arbeitsmassstabs (Zweierpotenz). */
export const FAKTOR_MAX = 8;
/**
 * Speicher der Arbeitstexturen: fünf RGBA16F-Felder je Arbeitspunkt. Darüber
 * wird der Massstab verdoppelt – auf einem Telefon mit zwei Gigabyte ist das
 * der Unterschied zwischen „läuft“ und „Reiter weg“.
 */
export const ARBEITSSPEICHER_MAX = 40e6;
export const BYTES_JE_ARBEITSPUNKT = 5 * 8;

/** Die drei Richtungen des Sechsecks in Bildkoordinaten (y nach unten), Länge 1. */
export const ECKE_0: readonly [number, number] = [0, -1];
export const ECKE_1: readonly [number, number] = [-Math.sqrt(3) / 2, 0.5];
export const ECKE_2: readonly [number, number] = [Math.sqrt(3) / 2, 0.5];

/* ---------- Güte ---------- */

/**
 * Wie genau gerechnet wird – dieselbe Tabelle für beide Wege.
 *
 * `hoch` für Ausgabe und Export, `mittel` für das Standbild am Bildschirm und
 * den angehaltenen Film, `niedrig` beim Wischen und Abspielen. Je Güte: der
 * grösste Radius in Arbeitspunkten (darüber wächst der Massstab), wie viele
 * Stufen der Radius bekommt (Silhouette / glatt) und wie dicht die Strecken
 * abgetastet werden (Abtastungen je Arbeitspunkt Radius).
 */
export type StufenGuete = 'hoch' | 'mittel' | 'niedrig';

export interface GueteWerte {
  readonly arbeitsradius: number;
  readonly stufenSilhouette: number;
  readonly stufenGlatt: number;
  readonly dichte: number;
}

export const GUETEN: Readonly<Record<StufenGuete, GueteWerte>> = {
  hoch: { arbeitsradius: 12, stufenSilhouette: 3, stufenGlatt: 8, dichte: 1 },
  mittel: { arbeitsradius: 8, stufenSilhouette: 3, stufenGlatt: 6, dichte: 0.5 },
  niedrig: { arbeitsradius: 4, stufenSilhouette: 2, stufenGlatt: 4, dichte: 0.5 },
};

/** Wieviele Stufen der Radius bei dieser Maskenart und Güte bekommt. */
export function stufenAnzahl(reinheit: Reinheit, guete: StufenGuete): number {
  const g = GUETEN[guete];
  return reinheit === 0 ? g.stufenSilhouette : g.stufenGlatt;
}

/* ---------- Rampen und Regler ---------- */

export function rampe(x: number, von: number, bis: number): number {
  const t = (x - von) / (bis - von);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Wie `smoothstep` in GLSL. */
export function glatt(von: number, bis: number, x: number): number {
  const t = rampe(x, von, bis);
  return t * t * (3 - 2 * t);
}

/**
 * Ein Reglerwert, wie ihn die Rechnung sehen darf.
 *
 * An EINER Stelle: Eine Datei kann NaN, unendlich oder 7 liefern, und weder
 * Grafikeinheit noch Prozessor sollen je etwas anderes als eine Zahl von 0
 * bis 1 sehen. Alles Unsinnige zählt als aus.
 */
export function reglerWert(wert: unknown): number {
  const v = typeof wert === 'number' ? wert : Number.NaN;
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Der Kreisradius des Sechsecks in Bildpunkten der Arbeitsgrösse, 0 = aus.
 *
 * Als Anteil der längeren Kante, damit die Vorschau (1200 Punkte) aussieht
 * wie die Ausgabe (2560): Ein fester Radius wäre in der Ausgabe halb so stark
 * wie das, was man am Regler eingestellt hat.
 */
export function bokehRadiusPx(bokeh: number, kante: number): number {
  const r = Math.min(BOKEH_MAX, reglerWert(bokeh) * BOKEH_ANTEIL * Math.max(0, kante));
  return r < BOKEH_MIN ? 0 : r;
}

/** Die Standardabweichung des Gauss in Bildpunkten der Arbeitsgrösse, 0 = aus. */
export function weichSigmaPx(weich: number, kante: number): number {
  const s = reglerWert(weich) * WEICH_ANTEIL * Math.max(0, kante);
  return s < WEICH_MIN ? 0 : s;
}

/* ---------- Stärke, Kern, Arbeitsmassstab ---------- */

/** Der Kernwert, an dem sich Stärke und Gewicht orientieren (0 … 1). */
export function reinWert(m: number, kern: number, reinheit: Reinheit): number {
  return reinheit === 2 ? kern : m;
}

/**
 * Wie stark die Unschärfe an einem Bildpunkt wirkt, 0 … 1.
 *
 * Aus der Maske `m` (0 … 1) und, bei Silhouetten, dem Kernwert: Staub unter
 * 0,03 und das Rauschen unter 0,25 fallen weg, die Wirkung endet an der
 * Isolinie statt am Fuss des Saums.
 */
export function staerke(m: number, rein: number, reinheit: Reinheit): number {
  const s = rampe(m, STAERKE_VON, STAERKE_BIS);
  return reinheit === 1 ? s : s * rampe(rein, REINHEIT_VON, REINHEIT_BIS);
}

/** Wie sehr ein Bildpunkt als Quelle zählt: 0 für Saum und Staub, 1 für Kern. */
export function kernGewicht(rein: number, reinheit: Reinheit): number {
  return reinheit === 1 ? 1 : rampe(rein, KERN_VON, KERN_BIS);
}

/** Die Verstärkung heller Stellen für das hellste Licht eines Bildpunkts (linear). */
export function lichtGewicht(hell: number): number {
  return 1 + LICHT_STAERKE * glatt(LICHT_VON, LICHT_BIS, hell);
}

/**
 * Der Arbeitsmassstab: Zweierpotenz, 1 bis 8.
 *
 * Gerechnet wird nicht auf jedem Bildpunkt, sondern auf Blöcken von `f × f`.
 * Der Radius in Arbeitspunkten soll `grenze` nicht überschreiten, und die
 * Arbeitsfelder sollen in den Speicher passen. Beide Wege rufen diese
 * Funktion mit denselben Zahlen – sonst wären ihre Bilder verschieden.
 */
export function arbeitsFaktor(
  radius: number,
  grenze: number,
  breite: number,
  hoehe: number,
): number {
  let f = 1;
  while (f < FAKTOR_MAX) {
    const zuGross = radius / f > grenze;
    const zuSchwer =
      Math.ceil(breite / f) * Math.ceil(hoehe / f) * BYTES_JE_ARBEITSPUNKT > ARBEITSSPEICHER_MAX;
    if (!zuGross && !zuSchwer) break;
    f *= 2;
  }
  return f;
}

/** Wieviele Stellen eine Strecke der Länge `radius` (Arbeitspunkte) abtastet. */
export function linienAnzahl(radius: number, dichte: number): number {
  return Math.max(1, Math.min(LINIE_MAX, Math.ceil(radius * dichte)));
}

/**
 * Wieviele Texturabtastungen ein Bildpunkt der Ausgabe kostet – der Massstab
 * für „ist das auf einem Telefon zu schaffen“.
 *
 * Gezählt wird, was jede Stufe je Arbeitspunkt liest (Vorbereitung `f²`, zwei
 * Strecken, drei Rauten, der Akkumulator) und je Ausgabepunkt (Quelle, Maske,
 * Ergebnis), umgerechnet auf Ausgabepunkte: ein Arbeitspunkt steht für `f²`
 * von ihnen. Absolute Millisekunden taugen dafür nicht – unter SwiftShader
 * zählen Texturabfragen anders als auf einer echten Grafikeinheit –, die
 * Abtastungen aber stimmen.
 */
export function abtastungenJeBildpunkt(
  art: 'bokeh' | 'weich',
  radiusPx: number,
  guete: StufenGuete,
  reinheit: Reinheit,
  breite = 1200,
  hoehe = 900,
): number {
  const g = GUETEN[guete];
  const ausgabe = 3;
  if (art === 'weich') {
    const f = arbeitsFaktor(radiusPx * 3, GAUSS_GRENZE, breite, hoehe);
    const r = Math.min(GAUSS_MAX, Math.ceil((radiusPx / f) * 3));
    return 1 + (2 * (2 * r + 1)) / (f * f) + ausgabe;
  }
  const f = arbeitsFaktor(radiusPx, g.arbeitsradius, breite, hoehe);
  const stufen = stufenAnzahl(reinheit, guete);
  let summe = ausgabe;
  for (let k = 1; k <= stufen; k += 1) {
    const n = linienAnzahl(((radiusPx / f) * k) / stufen, g.dichte);
    summe += 1 + (5 * n + 1) / (f * f);
  }
  return summe;
}

/* ---------- Ebenen: was gerechnet wird ---------- */

/** Ein Bereich mit Unschärfe, wie ihn beide Wege sehen. */
export interface UnscharfEbene {
  /** Der Platz im Maskenatlas (Kanal), 0 … 3. */
  readonly platz: number;
  /** Radius der Scheibe in Bildpunkten der Arbeitsgrösse, 0 = kein Bokeh. */
  readonly bokehPx: number;
  /** Sigma des Gauss in Bildpunkten, 0 = kein Weichzeichnen. */
  readonly weichPx: number;
  readonly reinheit: Reinheit;
}

/**
 * Welche Bereiche überhaupt unscharf rechnen, in Wirkreihenfolge.
 *
 * Die eine Stelle, an der Reglerwerte und Reinheit normiert werden: NaN,
 * negative und zu grosse Werte, ein Radius unter einem Bildpunkt, eine
 * gemischte Maske ohne Kernfeld (dann gilt sie als Silhouette). Wer hier
 * nichts findet, rechnet gar nicht erst – und das Bild bleibt bytegleich.
 */
export function unscharfEbenen(
  bereiche: readonly {
    anpassung: Pick<Bereichston, 'unschaerfe' | 'bokeh'>;
    reinheit?: Reinheit;
    maske: { kern?: Uint8Array };
  }[],
  breite: number,
  hoehe: number,
): UnscharfEbene[] {
  const kante = Math.max(breite, hoehe);
  const aus: UnscharfEbene[] = [];
  bereiche.forEach((b, platz) => {
    const bokehPx = bokehRadiusPx(b.anpassung.bokeh, kante);
    const weichPx = weichSigmaPx(b.anpassung.unschaerfe, kante);
    if (bokehPx === 0 && weichPx === 0) return;
    let reinheit: Reinheit = b.reinheit ?? 1;
    if (reinheit === 2 && !b.maske.kern) reinheit = 0;
    aus.push({ platz, bokehPx, weichPx, reinheit });
  });
  return aus;
}

/* ---------- die Rechnung auf dem Prozessor ---------- */

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

/** Was ein Bereich für die Rechnung auf dem Prozessor mitbringt, auf Bildgrösse gebracht. */
export interface UnscharfQuelle {
  readonly ebene: UnscharfEbene;
  /** Die Maske, 0 … 255, in Bildgrösse. */
  readonly maske: Uint8Array;
  /** Nur bei Reinheit 2: das Kernfeld in Bildgrösse. */
  readonly kern: Uint8Array | null;
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
export function unscharfAufBytes(
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
