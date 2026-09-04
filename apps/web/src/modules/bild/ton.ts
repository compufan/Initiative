/**
 * Der Tonwert-Kern der Bildbearbeitung – Belichtung, Kontrast, Farbe.
 *
 * Hier steht die Farbrechnung **einmal**, in gewöhnlichem TypeScript. Die
 * Grafikeinheit rechnet sie nicht nach: Sie bekommt eine Tabelle (`lutBauen`),
 * die genau diese Funktion an 33³ Stützstellen enthält, und interpoliert
 * dazwischen. Eine zweite Fassung in GLSL gäbe es sonst – und zwei Fassungen
 * derselben Formel driften auseinander, meist an dem Tag, an dem niemand
 * hinsieht.
 *
 * Nebenwirkung, die eigentlich der Hauptzweck ist: Die ganze Rechnung ist
 * ohne Leinwand, ohne Grafikeinheit und ohne Browser prüfbar.
 *
 * Was NICHT hier steht, weil es nicht von der Farbe allein abhängt:
 * Schärfe (braucht die Nachbarpunkte) und Vignette (braucht den Ort). Beides
 * liegt in `tonGpu.ts` – vor beziehungsweise nach der Tabelle.
 */

/**
 * Die neun Regler, die allein von der FARBE abhängen.
 *
 * Genau diese – und nur diese – kann `tonPunkt` rechnen, in eine Farbtabelle
 * giessen und auf einen einzelnen Bildpunkt anwenden, ohne seine Nachbarn
 * oder seinen Ort zu kennen. Das ist keine Sortierlaune: Eine örtliche
 * Anpassung („nur hier heller“) braucht genau diese Eigenschaft, sonst gäbe
 * es keine Maske, mit der man sie überblenden könnte.
 */
export interface Farbanpassung {
  /** Belichtung in Blendenstufen, −3 … 3. */
  belichtung: number;
  /** −1 … 1. */
  kontrast: number;
  /** Die hellen Töne. Positiv hebt sie an, negativ holt sie zurück. */
  lichter: number;
  /** Die dunklen Töne. Positiv hellt auf, negativ säuft ab. */
  tiefen: number;
  /** Der Schwarzpunkt. Positiv vertieft, negativ hebt an. */
  schwarz: number;
  /** Weissabgleich: positiv wärmer (gelb), negativ kühler (blau). */
  waerme: number;
  /** Weissabgleich: positiv magenta, negativ grün. */
  toenung: number;
  /** −1 (grau) … 1 (doppelt). */
  saettigung: number;
  /** Wie Sättigung, aber nur für blasse Farben – Hauttöne bleiben heil. */
  dynamik: number;
}

/** Alle Regler. 0 heisst überall „nichts tun“. */
export interface Anpassung extends Farbanpassung {
  /** Unschärfemaske, 0 … 1. Braucht die NACHBARN, deshalb nicht in der Tabelle. */
  schaerfe: number;
  /** Positiv dunkelt die Ecken ab, negativ hellt sie auf. Braucht den ORT. */
  vignette: number;
}

export const FARB_NEUTRAL: Farbanpassung = {
  belichtung: 0,
  kontrast: 0,
  lichter: 0,
  tiefen: 0,
  schwarz: 0,
  waerme: 0,
  toenung: 0,
  saettigung: 0,
  dynamik: 0,
};

/*
 * Die Reihenfolge der Schlüssel bleibt damit Byte für Byte die heutige.
 * `tonSchluessel` baut seinen String über `Object.keys(NEUTRAL)`; ein
 * vertauschtes Feld machte jeden Merkzettel im Bestand ungültig, ohne dass
 * irgendetwas kaputt aussähe – es würde nur alles neu gerechnet.
 */
export const NEUTRAL: Anpassung = { ...FARB_NEUTRAL, schaerfe: 0, vignette: 0 };

/** Ob überhaupt etwas eingestellt ist – sonst wird die ganze Kette übersprungen. */
export function istNeutral(a: Anpassung): boolean {
  return (Object.keys(NEUTRAL) as (keyof Anpassung)[]).every((schlüssel) => a[schlüssel] === 0);
}

/** Dasselbe für die neun Farbregler allein. */
export function farbNeutral(a: Farbanpassung): boolean {
  return (Object.keys(FARB_NEUTRAL) as (keyof Farbanpassung)[]).every(
    (schlüssel) => a[schlüssel] === 0,
  );
}

/**
 * Eine Kennung über die neun Farbregler.
 *
 * Getrennt von `tonSchluessel`: Die Farbtabelle enthält `schaerfe` und
 * `vignette` gar nicht, ihre Änderung darf sie also nicht wegwerfen.
 */
export function farbSchluessel(a: Farbanpassung): string {
  return (Object.keys(FARB_NEUTRAL) as (keyof Farbanpassung)[])
    .map((schlüssel) => `${schlüssel}:${a[schlüssel]}`)
    .join('|');
}

/** Ob etwas eingestellt ist, das sich in eine Farbtabelle fassen lässt. */
export function brauchtTabelle(a: Anpassung): boolean {
  return (Object.keys(NEUTRAL) as (keyof Anpassung)[]).some(
    (schlüssel) => schlüssel !== 'schaerfe' && schlüssel !== 'vignette' && a[schlüssel] !== 0,
  );
}

/**
 * Eine Kennung, die sich genau dann ändert, wenn sich das Ergebnis ändert.
 *
 * Damit erkennen die Zwischenspeicher weiter oben, ob ihr Inhalt noch gilt.
 */
export function tonSchluessel(a: Anpassung): string {
  return (Object.keys(NEUTRAL) as (keyof Anpassung)[])
    .map((schlüssel) => `${schlüssel}:${a[schlüssel]}`)
    .join('|');
}

/* ---------- Farbraum ---------- */

/**
 * sRGB → lineares Licht.
 *
 * Belichtung und Weissabgleich sind physikalische Grössen: doppelt so viel
 * Licht ist doppelt so viel Licht. Rechnet man sie im Anzeigeraum, wird eine
 * Blende mehr zu einem flauen Grauschleier statt zu einem helleren Bild.
 */
export function zuLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function zuSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Die Helligkeit, wie das Auge sie wiegt (Rec. 709). */
export function luminanz(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function halten(wert: number): number {
  return wert < 0 ? 0 : wert > 1 ? 1 : wert;
}

/**
 * Der weiche Übergang von 0 auf 1 – dieselbe Kurve, die GLSL `smoothstep`
 * heisst.
 *
 * Ausgeführt, damit `maske.ts` sie benutzt statt eine zweite hinzuschreiben:
 * Die Kanten einer Maske und die Kanten von Lichtern/Tiefen sollen sich
 * gleich anfühlen, und zwei Fassungen derselben Kurve driften auseinander.
 */
export function weich(von: number, bis: number, wert: number): number {
  const t = halten((wert - von) / (bis - von || 1));
  return t * t * (3 - 2 * t);
}

/* ---------- die Rechnung ---------- */

/**
 * Die Weissabgleich-Faktoren, auf gleiche Helligkeit normiert.
 *
 * Ohne die Normierung würde jede Wärmekorrektur das Bild nebenbei heller oder
 * dunkler machen, und man justierte anschliessend die Belichtung nach, die
 * man gar nicht ändern wollte.
 */
export function weissFaktoren(waerme: number, toenung: number): [number, number, number] {
  const r = (1 + 0.4 * waerme) * (1 + 0.2 * toenung);
  const g = 1 * (1 - 0.2 * toenung);
  const b = (1 - 0.4 * waerme) * (1 + 0.2 * toenung);
  const norm = luminanz(r, g, b) || 1;
  return [r / norm, g / norm, b / norm];
}

/**
 * Ein Farbwert durch die ganze Kette. Ein- und Ausgabe in 0 … 1.
 *
 * Die Reihenfolge ist nicht beliebig:
 *
 * 1. **Im linearen Licht**: Belichtung und Weissabgleich. Beides sind
 *    Multiplikationen am Licht selbst.
 * 2. **Im Anzeigeraum**: Schwarzpunkt, Tiefen, Lichter, Kontrast, Farbe.
 *    Diese Regler beziehen sich auf das, was man sieht – „die Lichter“ sind
 *    die hellen Stellen im Bild, nicht die oberen zwei Blenden.
 *
 * Jeder Schritt für sich ist monoton: Wer einen Regler in eine Richtung
 * schiebt, bekommt nie stellenweise das Gegenteil.
 */
export function tonPunkt(
  eingabe: readonly [number, number, number],
  a: Farbanpassung,
): [number, number, number] {
  let r = eingabe[0];
  let g = eingabe[1];
  let b = eingabe[2];

  if (a.belichtung !== 0 || a.waerme !== 0 || a.toenung !== 0) {
    const [fr, fg, fb] = weissFaktoren(a.waerme, a.toenung);
    const blende = Math.pow(2, a.belichtung);
    r = zuSrgb(halten(zuLinear(r) * blende * fr));
    g = zuSrgb(halten(zuLinear(g) * blende * fg));
    b = zuSrgb(halten(zuLinear(b) * blende * fb));
  }

  if (a.schwarz !== 0) {
    // Positiv: den Schwarzpunkt anheben und wieder aufspreizen – die Tiefen
    // werden satt. Negativ: die Tiefen anheben, das Bild wird flauer.
    const s = a.schwarz * 0.25;
    if (s > 0) {
      const nenner = 1 - s || 1;
      r = halten((r - s) / nenner);
      g = halten((g - s) / nenner);
      b = halten((b - s) / nenner);
    } else {
      const hebe = -s;
      r = r * (1 - hebe) + hebe;
      g = g * (1 - hebe) + hebe;
      b = b * (1 - hebe) + hebe;
    }
  }

  if (a.lichter !== 0 || a.tiefen !== 0) {
    const l = luminanz(r, g, b);
    // Zwei weiche Masken statt harter Schwellen: Eine Kante bei „ab hier ist
    // es hell“ zeichnete sich als sichtbarer Ring in jeden Himmel.
    const maskeL = weich(0.45, 1, l);
    const maskeT = 1 - weich(0, 0.55, l);
    const biegen = (wert: number, staerke: number, maske: number) => {
      if (staerke === 0 || maske === 0) return wert;
      // Wurzel hebt an, Quadrat senkt ab – beides monoton und ohne Anschlag.
      const ziel = staerke > 0 ? Math.sqrt(wert) : wert * wert;
      const anteil = Math.abs(staerke) * maske;
      return wert * (1 - anteil) + ziel * anteil;
    };
    r = biegen(biegen(r, a.lichter, maskeL), a.tiefen, maskeT);
    g = biegen(biegen(g, a.lichter, maskeL), a.tiefen, maskeT);
    b = biegen(biegen(b, a.lichter, maskeL), a.tiefen, maskeT);
  }

  if (a.kontrast !== 0) {
    const s = (wert: number) =>
      a.kontrast > 0
        ? wert * (1 - a.kontrast) + wert * wert * (3 - 2 * wert) * a.kontrast
        : wert * (1 + a.kontrast) + (wert * 0.5 + 0.25) * -a.kontrast;
    r = s(r);
    g = s(g);
    b = s(b);
  }

  if (a.saettigung !== 0 || a.dynamik !== 0) {
    const y = luminanz(r, g, b);
    let faktor = 1 + a.saettigung;
    if (a.dynamik !== 0) {
      // Wie bunt ist die Stelle schon? Blasses bekommt viel, Kräftiges wenig
      // – deshalb kippen Hauttöne mit „Dynamik“ nicht ins Orange.
      const spanne = Math.max(r, g, b) - Math.min(r, g, b);
      faktor *= 1 + a.dynamik * (1 - spanne);
    }
    faktor = Math.max(0, faktor);
    r = y + (r - y) * faktor;
    g = y + (g - y) * faktor;
    b = y + (b - y) * faktor;
  }

  return [halten(r), halten(g), halten(b)];
}

/**
 * Wie örtliche Anpassungen übereinanderliegen.
 *
 * Das Gegenstück zur Bereichsschleife im Schattierer, und der Grund, warum es
 * diese Funktion überhaupt gibt: Die Reihenfolge ist eine Entscheidung, keine
 * Selbstverständlichkeit, und sie muss auf beiden Wegen dieselbe sein.
 *
 * Jeder Bereich rechnet auf dem ERGEBNIS des vorigen, nicht auf der Rohfarbe.
 * Das ist der Unterschied zwischen „hier zusätzlich wärmer“ und „hier statt
 * dessen“: Ein Bereich mit lauter Nullen nähme sonst dort, wo seine Maske
 * greift, die globale Anpassung wieder zurück.
 *
 * Überblendet wird mit dem Maskengewicht, nachdem gerechnet wurde – nicht
 * umgekehrt. Die gemischte Farbe durch die Kette zu schicken wäre bei starken
 * Kurven etwas ganz anderes, weil die Kette nicht linear ist.
 */
export function bereichePunkt(
  farbe: readonly [number, number, number],
  bereiche: readonly { gewicht: number; anpassung: Farbanpassung }[],
): [number, number, number] {
  let c: [number, number, number] = [farbe[0], farbe[1], farbe[2]];
  for (const bereich of bereiche) {
    const g = bereich.gewicht;
    if (g <= 0) continue;
    const voll = tonPunkt(c, bereich.anpassung);
    if (g >= 1) {
      c = voll;
      continue;
    }
    c = [c[0] + (voll[0] - c[0]) * g, c[1] + (voll[1] - c[1]) * g, c[2] + (voll[2] - c[2]) * g];
  }
  return c;
}

/* ---------- die Farbtabelle ---------- */

/**
 * Kantenlänge der Farbtabelle.
 *
 * 33 und nicht 32: Bei ungerader Kantenlänge liegt das mittlere Grau genau
 * auf einer Stützstelle. Kosten: 33³ · 3 = 105 KB.
 */
export const LUT_KANTE = 33;

/**
 * Die Achsenverzerrung der Tabelle – und warum es sie gibt.
 *
 * Zwischen den Stützstellen wird linear interpoliert. Wo die Kurve stark
 * gekrümmt ist, ist das ungenau, und am stärksten gekrümmt ist sie ganz
 * unten: Ein Regler „Tiefen +1“ ist dort eine Wurzel, deren Steigung gegen
 * unendlich geht.
 *
 * Nachgemessen an einem um 2,5 Blenden abgedunkelten Bild mit voll
 * aufgezogenen Tiefen: mit gleichmässiger Achse 5,5 Stufen von 255 daneben,
 * mit der Wurzelachse 0,6. Der Grund ist keine Zauberei – in der
 * Wurzelachse IST die Wurzel eine Gerade.
 *
 * Die Umkehrung muss die Grafikeinheit nicht kennen: Sie rechnet gar nicht
 * mit der Tabelle (siehe `tonGpu.ts`).
 */
export function formHin(x: number): number {
  return Math.sqrt(x < 0 ? 0 : x > 1 ? 1 : x);
}

export function formHer(u: number): number {
  return u * u;
}

/**
 * Baut die Farbtabelle: für jede Stützstelle das Ergebnis von `tonPunkt`.
 *
 * Anordnung: `index = ((b · KANTE) + g) · KANTE + r`, drei Bytes je Eintrag –
 * r läuft am schnellsten.
 */
export function lutBauen(a: Farbanpassung): Uint8Array {
  const n = LUT_KANTE;
  const daten = new Uint8Array(n * n * n * 3);
  const letzte = n - 1;
  // Die Stützstellen einmal vorrechnen statt dreimal je Eintrag.
  const stuetzen = new Float64Array(n);
  for (let i = 0; i < n; i += 1) stuetzen[i] = formHer(i / letzte);
  let at = 0;
  for (let ib = 0; ib < n; ib += 1) {
    for (let ig = 0; ig < n; ig += 1) {
      for (let ir = 0; ir < n; ir += 1) {
        const [r, g, b] = tonPunkt([stuetzen[ir], stuetzen[ig], stuetzen[ib]], a);
        daten[at] = Math.round(r * 255);
        daten[at + 1] = Math.round(g * 255);
        daten[at + 2] = Math.round(b * 255);
        at += 3;
      }
    }
  }
  return daten;
}

/**
 * Liest aus der Tabelle – trilinear, genau wie die Grafikeinheit es täte.
 *
 * Ein- und Ausgabe in 0 … 255. Wird vom Rückfallweg ohne Grafikeinheit
 * benutzt und von den Prüfungen, die Tabelle gegen Rechnung halten.
 */
export function lutAnwenden(
  lut: Uint8Array,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const n = LUT_KANTE;
  const letzte = n - 1;
  const fx = formHin(r / 255) * letzte;
  const fy = formHin(g / 255) * letzte;
  const fz = formHin(b / 255) * letzte;
  const x0 = Math.min(letzte, Math.floor(fx));
  const y0 = Math.min(letzte, Math.floor(fy));
  const z0 = Math.min(letzte, Math.floor(fz));
  const x1 = Math.min(letzte, x0 + 1);
  const y1 = Math.min(letzte, y0 + 1);
  const z1 = Math.min(letzte, z0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;

  const bei = (x: number, y: number, z: number, k: number) => lut[((z * n + y) * n + x) * 3 + k];
  const aus: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    const c00 = bei(x0, y0, z0, k) * (1 - tx) + bei(x1, y0, z0, k) * tx;
    const c10 = bei(x0, y1, z0, k) * (1 - tx) + bei(x1, y1, z0, k) * tx;
    const c01 = bei(x0, y0, z1, k) * (1 - tx) + bei(x1, y0, z1, k) * tx;
    const c11 = bei(x0, y1, z1, k) * (1 - tx) + bei(x1, y1, z1, k) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    aus[k] = c0 * (1 - tz) + c1 * tz;
  }
  return aus;
}

/* ---------- Vignette ---------- */

/**
 * Der Faktor der Vignette an einer Stelle. `u`/`v` laufen von 0 bis 1.
 *
 * Steht hier und nicht im Renderer, damit der Rückfallweg und die
 * Grafikeinheit dieselbe Kurve benutzen – und damit sie prüfbar ist.
 */
export function vignetteFaktor(u: number, v: number, staerke: number): number {
  if (staerke === 0) return 1;
  const dx = u - 0.5;
  const dy = v - 0.5;
  // Auf die halbe Diagonale normiert: In der Ecke ist der Abstand 1.
  const d = Math.min(1, Math.hypot(dx, dy) / Math.SQRT1_2);
  return 1 - staerke * weich(0.3, 1, d);
}

/* ---------- Automatik ---------- */

/**
 * Ein Vorschlag aus dem Histogramm der Helligkeit.
 *
 * Die Regel, die jede Automatik benutzt: Was in den untersten und obersten
 * Promille liegt, ist Rauschen oder eine Lampe – nicht der Bildinhalt. Der
 * Rest wird auf den vollen Bereich gespreizt.
 *
 * `histogramm` hat 256 Fächer und zählt Bildpunkte.
 */
export function autoAnpassung(histogramm: ArrayLike<number>): Anpassung {
  let gesamt = 0;
  for (let i = 0; i < 256; i += 1) gesamt += histogramm[i];
  if (gesamt <= 0) return { ...NEUTRAL };

  const grenze = gesamt * 0.005;
  let unten = 0;
  let summe = 0;
  for (let i = 0; i < 256; i += 1) {
    summe += histogramm[i];
    if (summe >= grenze) {
      unten = i;
      break;
    }
  }
  let oben = 255;
  summe = 0;
  for (let i = 255; i >= 0; i -= 1) {
    summe += histogramm[i];
    if (summe >= grenze) {
      oben = i;
      break;
    }
  }
  if (oben <= unten) return { ...NEUTRAL };

  // Der Mittelwert sagt, ob das Bild insgesamt zu dunkel oder zu hell ist.
  let gewichtet = 0;
  for (let i = 0; i < 256; i += 1) gewichtet += i * histogramm[i];
  const mittel = gewichtet / gesamt / 255;

  // Belichtung so, dass das Mittel bei 0,46 landet (etwas unter der Mitte –
  // ein Foto, dessen Mittelwert genau 0,5 ist, wirkt bereits flau).
  const ziel = 0.46;
  const blenden = mittel > 0.004 ? Math.max(-1.5, Math.min(1.5, Math.log2(ziel / mittel))) : 1.5;

  // Der Schwarzpunkt greift nur, wenn unten wirklich nichts liegt.
  const schwarz = Math.max(0, Math.min(0.6, (unten / 255) * 2));
  // Kontrast nur, wenn das Bild flau ist – ein Bild, das schon spreizt,
  // bekommt keinen dazu.
  const spanne = (oben - unten) / 255;
  const kontrast = Math.max(0, Math.min(0.45, (0.85 - spanne) * 0.8));

  return {
    ...NEUTRAL,
    belichtung: Math.round(blenden * 100) / 100,
    schwarz: Math.round(schwarz * 100) / 100,
    kontrast: Math.round(kontrast * 100) / 100,
    dynamik: 0.15,
  };
}
