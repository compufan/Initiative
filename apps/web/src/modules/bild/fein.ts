/**
 * Kurven und selektive Farbe – der Feinschliff nach der Kette.
 *
 * # Warum getrennt von `ton.ts`
 *
 * Die elf Regler in `ton.ts` sind ZAHLEN. Daran hängt mehr, als es aussieht:
 * `farbSchluessel` baut aus ihnen einen String, `lutBauen` giesst sie in eine
 * Farbtabelle, `bereichePunkt` überblendet sie je Bereich. Eine Kurve ist
 * keine Zahl, sondern eine Liste von Stützpunkten – und acht Farbbänder sind
 * vierundzwanzig Zahlen, die nur zusammen etwas bedeuten.
 *
 * Beides bleibt deshalb GLOBAL und geht nicht in die Bereiche. Das ist keine
 * Bequemlichkeit: Die Grafikeinheit bekommt die Bereiche als Feld von
 * Uniformen, und vier Bereiche mal vier Kurven mal dreiunddreissig
 * Stützstellen wären über sechshundert Zahlen – mehr, als ein Schattierer
 * auf einem Telefon halten muss. Dieselbe Grenze, aus der schon `schaerfe`
 * und `vignette` nicht in `Bereichston` stehen.
 *
 * # Die Reihenfolge
 *
 * Erst die Kurven, dann die Bänder. Das ist eine Entscheidung und keine
 * Selbstverständlichkeit: Eine Kurve auf einem einzelnen Kanal IST bereits
 * ein Farbwerkzeug (wer Blau in den Tiefen anhebt, macht die Schatten kühl),
 * und die Bänder danach sind das Werkzeug, mit dem man das wieder
 * zurechtrückt. Andersherum arbeitete man auf Farben, die eine Kurve gleich
 * darauf verschiebt.
 *
 * # Warum eine Tabelle und keine Formel
 *
 * Die Kurve wird EINMAL in dreiunddreissig Stützstellen gerechnet, und beide
 * Rechenwege lesen danach aus derselben Tabelle. Der Schattierer könnte kein
 * monotones Spline auswerten, ohne die Stützpunkte als Feld zu bekommen und
 * je Bildpunkt zu durchsuchen – und wenn Prozessor und Grafikeinheit zwei
 * verschiedene Auswertungen hätten, driftete genau das auseinander, was der
 * Vergleichstest festnagelt.
 *
 * Dreiunddreissig reicht: Zwischen den Stützstellen wird linear interpoliert,
 * der Fehler wächst mit dem Quadrat des Abstands und der zweiten Ableitung.
 * Für eine kräftige S-Kurve gerechnet liegt er bei rund 0,1 von 255 – eine
 * Größenordnung unter der Grenze von zwei, an der der Vergleichstest anschlägt.
 */

import { halten, weich } from './grund.js';

/** Ein Stützpunkt einer Kurve. Beide Achsen 0 … 1. */
export interface Kurvenpunkt {
  x: number;
  y: number;
}

/**
 * Die vier Kurven.
 *
 * `gesamt` wirkt auf alle drei Kanäle, die anderen drei je auf ihren. Eine
 * leere Liste heisst „gerade" – nicht „schwarz".
 */
export interface Kurven {
  gesamt: readonly Kurvenpunkt[];
  rot: readonly Kurvenpunkt[];
  gruen: readonly Kurvenpunkt[];
  blau: readonly Kurvenpunkt[];
}

export const KURVEN_NEUTRAL: Kurven = { gesamt: [], rot: [], gruen: [], blau: [] };

/** Ein Farbband: Farbton verschieben, Sättigung und Helligkeit ändern. Je −1 … 1. */
export interface Farbband {
  farbton: number;
  saettigung: number;
  helligkeit: number;
}

/**
 * Die acht Bänder, und wo ihre Mitte liegt.
 *
 * Die Winkel sind nicht gleichmässig verteilt, und das ist Absicht: Zwischen
 * Rot und Gelb liegen dreissig Grad, zwischen Grün und Türkis sechzig. So
 * liegen die Bänder dort dichter, wo das Auge am meisten unterscheidet – und
 * genau dort sitzen auch die Farben, an denen man in einem Foto arbeitet
 * (Haut zwischen Rot und Orange, Laub zwischen Gelb und Grün).
 */
export const BAENDER: readonly { key: string; label: string; winkel: number }[] = [
  { key: 'rot', label: 'Rot', winkel: 0 },
  { key: 'orange', label: 'Orange', winkel: 30 },
  { key: 'gelb', label: 'Gelb', winkel: 60 },
  { key: 'gruen', label: 'Grün', winkel: 120 },
  { key: 'tuerkis', label: 'Türkis', winkel: 180 },
  { key: 'blau', label: 'Blau', winkel: 240 },
  { key: 'violett', label: 'Violett', winkel: 270 },
  { key: 'magenta', label: 'Magenta', winkel: 300 },
];

export const BAENDER_NEUTRAL: readonly Farbband[] = BAENDER.map(() => ({
  farbton: 0,
  saettigung: 0,
  helligkeit: 0,
}));

/** Wie weit ein Band den Farbton höchstens dreht. */
export const FARBTON_HUB = 30 / 360;

export const KURVE_STUETZEN = 33;

/* ---------- die Kurve ---------- */

/**
 * Die Stützpunkte in eine Form bringen, auf der sich rechnen lässt.
 *
 * Sortiert, geklemmt, ohne doppelte x – und mit den Endpunkten. Eine Kurve
 * ohne Endpunkte wäre an den Rändern nicht definiert, und „nicht definiert"
 * heisst in der Auswertung „irgendetwas": Schwarz, Weiss oder NaN, je
 * nachdem, wer zuerst hinsieht.
 */
function geordnet(punkte: readonly Kurvenpunkt[]): Kurvenpunkt[] {
  const sauber = punkte
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: halten(p.x), y: halten(p.y) }))
    .sort((a, b) => a.x - b.x);
  const raus: Kurvenpunkt[] = [];
  for (const p of sauber) {
    // Zwei Punkte auf demselben x wären eine senkrechte Strecke – und im
    // Spline eine Division durch null. Der spätere gewinnt.
    if (raus.length > 0 && Math.abs(raus[raus.length - 1].x - p.x) < 1e-6) raus.pop();
    raus.push(p);
  }
  if (raus.length === 0 || raus[0].x > 0) raus.unshift({ x: 0, y: raus.length > 0 ? 0 : 0 });
  if (raus[raus.length - 1].x < 1) raus.push({ x: 1, y: 1 });
  return raus;
}

/**
 * Eine Kurve als Tabelle über `KURVE_STUETZEN` gleichmässige Stellen.
 *
 * Zwischen den Stützpunkten wird monoton kubisch interpoliert – das Verfahren
 * von Fritsch und Carlson. Der Unterschied zu einem gewöhnlichen kubischen
 * Spline ist der Grund, warum es hier steht: Ein gewöhnlicher Spline SCHWINGT
 * ÜBER. Wer drei Punkte setzt, die sauber ansteigen, bekommt zwischen ihnen
 * einen Bauch, der wieder fällt – in einem Foto ein heller Saum um jede
 * dunkle Kante und ein Verlauf, der stellenweise rückwärts läuft.
 *
 * Das Verfahren ist von 1980 und Allgemeingut; hier steht es als eigener
 * Code, nicht als Abhängigkeit.
 */
export function kurveTabelle(punkte: readonly Kurvenpunkt[]): Float32Array {
  const tabelle = new Float32Array(KURVE_STUETZEN);
  const p = geordnet(punkte);

  // Steigungen der Sehnen und erste Ableitungen an den Stützpunkten.
  const n = p.length;
  const sehne = new Float64Array(Math.max(1, n - 1));
  for (let i = 0; i < n - 1; i += 1) {
    sehne[i] = (p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x);
  }
  const m = new Float64Array(n);
  if (n === 1) {
    m[0] = 0;
  } else {
    m[0] = sehne[0];
    m[n - 1] = sehne[n - 2];
    for (let i = 1; i < n - 1; i += 1) m[i] = (sehne[i - 1] + sehne[i]) / 2;
    /*
     * Der Filter, der aus „kubisch" „monoton kubisch" macht.
     *
     * Wo zwei Sehnen die Richtung wechseln, muss die Ableitung null sein –
     * sonst schiesst die Kurve über den Wendepunkt hinaus. Und wo sie
     * gleichsinnig sind, darf die Ableitung höchstens das Dreifache der
     * kleineren Sehne betragen; darüber beult die Kurve aus.
     */
    for (let i = 0; i < n - 1; i += 1) {
      if (sehne[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / sehne[i];
      const b = m[i + 1] / sehne[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * sehne[i];
        m[i + 1] = t * b * sehne[i];
      }
    }
  }

  let j = 0;
  for (let i = 0; i < KURVE_STUETZEN; i += 1) {
    const x = i / (KURVE_STUETZEN - 1);
    while (j < n - 2 && x > p[j + 1].x) j += 1;
    if (n === 1) {
      tabelle[i] = halten(p[0].y);
      continue;
    }
    const h = p[j + 1].x - p[j].x;
    const t = h > 0 ? (x - p[j].x) / h : 0;
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite-Basis. Die beiden mittleren Terme tragen die Ableitungen und
    // sind der Unterschied zu einer Geraden zwischen den Punkten.
    const wert =
      (2 * t3 - 3 * t2 + 1) * p[j].y +
      (t3 - 2 * t2 + t) * h * m[j] +
      (-2 * t3 + 3 * t2) * p[j + 1].y +
      (t3 - t2) * h * m[j + 1];
    tabelle[i] = halten(wert);
  }
  return tabelle;
}

/** Ob eine Kurve überhaupt etwas tut. */
export function kurveGerade(punkte: readonly Kurvenpunkt[]): boolean {
  if (punkte.length === 0) return true;
  const p = geordnet(punkte);
  return p.every((punkt) => Math.abs(punkt.x - punkt.y) < 1e-6);
}

export function kurvenNeutral(kurven: Kurven): boolean {
  return (
    kurveGerade(kurven.gesamt) &&
    kurveGerade(kurven.rot) &&
    kurveGerade(kurven.gruen) &&
    kurveGerade(kurven.blau)
  );
}

/**
 * Alle vier Kurven in EINEM Feld – die Form, in der der Schattierer sie bekommt.
 *
 * Reihenfolge: gesamt, rot, grün, blau. Ein einziges Feld und keine vier, weil
 * ein Uniform-Feld in GLSL ES 3.00 eine feste Länge braucht und vier getrennte
 * Felder vier Namen, vier Bindungen und vier Gelegenheiten wären, eines davon
 * zu vergessen.
 */
export function kurvenFeld(kurven: Kurven): Float32Array {
  const raus = new Float32Array(KURVE_STUETZEN * 4);
  raus.set(kurveTabelle(kurven.gesamt), 0);
  raus.set(kurveTabelle(kurven.rot), KURVE_STUETZEN);
  raus.set(kurveTabelle(kurven.gruen), KURVE_STUETZEN * 2);
  raus.set(kurveTabelle(kurven.blau), KURVE_STUETZEN * 3);
  return raus;
}

/**
 * Aus der Tabelle lesen – linear zwischen den Stützstellen.
 *
 * Genau so, wie es der Schattierer auch tut. Wer hier etwas anderes rechnete
 * (etwa noch einmal ein Spline), bekäme zwei Bilder aus derselben Kurve.
 */
export function kurveAn(feld: Float32Array, kurve: number, x: number): number {
  const letzte = KURVE_STUETZEN - 1;
  const f = halten(x) * letzte;
  const i0 = Math.min(letzte, Math.floor(f));
  const i1 = Math.min(letzte, i0 + 1);
  const t = f - i0;
  const at = kurve * KURVE_STUETZEN;
  return feld[at + i0] * (1 - t) + feld[at + i1] * t;
}

/* ---------- selektive Farbe ---------- */

export function baenderNeutral(baender: readonly Farbband[]): boolean {
  return baender.every((b) => b.farbton === 0 && b.saettigung === 0 && b.helligkeit === 0);
}

/**
 * RGB → HSL. `h` in Umdrehungen (0 … 1), `s` und `l` in 0 … 1.
 *
 * Ausgeschrieben und nicht aus einer Bibliothek: Dieselbe Rechnung steht ein
 * zweites Mal in GLSL, und zwei Fassungen müssen Zeile für Zeile dasselbe
 * tun – der Vergleichstest hält sie auf zwei Stufen von 255 gegeneinander.
 */
export function zuHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-7) return [0, 0, l];
  // Der Nenner kippt bei l = 0,5: Darunter spannt die Sättigung über (max+min),
  // darüber über das, was nach oben noch übrig ist.
  const s = l > 0.5 ? d / Math.max(1e-7, 2 - max - min) : d / Math.max(1e-7, max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function kanal(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

export function ausHsl(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-7) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [kanal(p, q, h + 1 / 3), kanal(p, q, h), kanal(p, q, h - 1 / 3)];
}

/**
 * Die Gewichte der acht Bänder für diesen Farbton.
 *
 * # Warum genau zwei Bänder wirken und nicht mehr
 *
 * Zwischen zwei benachbarten Bandmitten wird überblendet, sonst nichts. Die
 * Summe der Gewichte ist damit ÜBERALL genau eins – ohne Normierung, weil
 * `t` und `1 − t` sich von selbst zu eins addieren.
 *
 * Die naheliegende Fassung war eine andere: jedem Band eine feste Halbbreite
 * von sechzig Grad geben, die Gewichte aufaddieren und hinterher normieren.
 * Sie hat einen Fehler, den man erst beim Nachmessen sieht. Die Bandmitten
 * stehen ungleich (Rot bis Orange dreissig Grad, Grün bis Türkis sechzig);
 * bei reinem Rot bekäme Orange dann trotzdem noch ein halbes Gewicht, und
 * nach dem Normieren blieben Rot nur zwei Drittel. „Rot ganz entsättigen"
 * liesse ein Drittel der Sättigung stehen – gemessen 0,2 von ursprünglich
 * 0,6.
 *
 * Mit der Überblendung zwischen Nachbarn ist ein Band an seiner eigenen
 * Mitte allein zuständig, und dazwischen geht es weich hinüber.
 */
export function bandGewichte(farbton: number): Float64Array {
  const n = BAENDER.length;
  const w = new Float64Array(n);
  const h = farbton - Math.floor(farbton);
  /*
   * Das erste Band liegt auf 0, also fällt jeder Farbton in einen Abschnitt
   * – der letzte reicht von der letzten Mitte bis zur vollen Umdrehung, wo
   * wieder das erste Band steht.
   */
  let i = n - 1;
  for (let k = 0; k < n - 1; k += 1) {
    if (h >= BAENDER[k].winkel / 360 && h < BAENDER[k + 1].winkel / 360) {
      i = k;
      break;
    }
  }
  const a = BAENDER[i].winkel / 360;
  const b = i + 1 < n ? BAENDER[i + 1].winkel / 360 : 1;
  const t = weich(0, 1, b > a ? (h - a) / (b - a) : 0);
  w[i] = 1 - t;
  w[(i + 1) % n] += t;
  return w;
}

/** Wurzel hebt an, Quadrat senkt ab – dieselbe Biegung wie in `tonPunkt`. */
export function biegen(wert: number, staerke: number): number {
  if (staerke === 0) return wert;
  const ziel = staerke > 0 ? Math.sqrt(wert) : wert * wert;
  const anteil = Math.min(1, Math.abs(staerke));
  return wert * (1 - anteil) + ziel * anteil;
}

/**
 * Kurven und Bänder auf einen Bildpunkt. Ein- und Ausgabe in 0 … 1.
 *
 * `kurven` ist das Feld aus `kurvenFeld`, nicht die Stützpunkte: Die Tabelle
 * wird einmal je Bild gebaut, nicht einmal je Bildpunkt.
 */
export function feinPunkt(
  eingabe: readonly [number, number, number],
  kurven: Float32Array | null,
  baender: readonly Farbband[] | null,
): [number, number, number] {
  let r = eingabe[0];
  let g = eingabe[1];
  let b = eingabe[2];

  if (kurven) {
    // Erst je Kanal, dann über alle drei – die Reihenfolge jedes
    // Kurvenwerkzeugs, das es gibt.
    r = kurveAn(kurven, 1, r);
    g = kurveAn(kurven, 2, g);
    b = kurveAn(kurven, 3, b);
    r = kurveAn(kurven, 0, r);
    g = kurveAn(kurven, 0, g);
    b = kurveAn(kurven, 0, b);
  }

  if (baender && !baenderNeutral(baender)) {
    const [h, s, l] = zuHsl(r, g, b);
    /*
     * Ein fast graues Bildpunkt hat einen Farbton, aber keine Aussage.
     *
     * Ohne diese Dämpfung bekäme jedes Rauschen in einer grauen Wand einen
     * Farbton zugewiesen und würde mitgedreht – aus einem ruhigen Grau würde
     * ein buntes Flimmern. Der Übergang ist weich, weil eine Schwelle
     * genau dort eine sichtbare Kante zöge, wo das Bild am empfindlichsten
     * ist.
     */
    const flaute = weich(0.04, 0.18, s);
    if (flaute > 0) {
      const w = bandGewichte(h);
      let dh = 0;
      let ds = 0;
      let dl = 0;
      for (let i = 0; i < w.length && i < baender.length; i += 1) {
        if (w[i] === 0) continue;
        dh += w[i] * baender[i].farbton;
        ds += w[i] * baender[i].saettigung;
        dl += w[i] * baender[i].helligkeit;
      }
      let hn = h + dh * FARBTON_HUB * flaute;
      hn -= Math.floor(hn);
      const sn = halten(s * Math.max(0, 1 + ds * flaute));
      const ln = halten(biegen(l, dl * flaute));
      [r, g, b] = ausHsl(hn, sn, ln);
    }
  }

  return [halten(r), halten(g), halten(b)];
}
