/**
 * Das Modell hinter der Bildbearbeitung – ohne Leinwand, ohne React.
 *
 * Alles, was hier steht, ist reine Rechnerei über Koordinaten und lässt sich
 * ohne Browser prüfen. Das ist kein Selbstzweck: Drehen, Spiegeln und
 * Zuschneiden sind genau die Stellen, an denen sich Vorzeichenfehler
 * verstecken, und ein solcher Fehler sieht auf dem Bildschirm nach „irgendwas
 * stimmt nicht“ aus, ohne zu verraten, was.
 *
 * **Ein Bezugssystem für alles.** Zuschnitt, Striche und Textanker stehen in
 * Punkten des *Originalbildes*. Wird gedreht, ändert sich nur die Drehung –
 * Zuschnitt und Striche wandern automatisch mit, weil sie am Bild kleben.
 * Der Anwender arbeitet dagegen im *Ansichtsraum*, also im gedrehten Bild;
 * dazwischen übersetzen `nachAnsicht` und `nachOriginal`.
 */

export type Drehung = 0 | 90 | 180 | 270;

export interface Punkt {
  x: number;
  y: number;
}

/** Ein Ausschnitt in Punkten des Originalbildes. */
export interface Zuschnitt {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ein gemalter Strich – Punkte flach als x/y, in Originalpunkten. */
export interface Malstrich {
  farbe: string;
  breite: number;
  punkte: number[];
}

export interface Schriftzug {
  id: string;
  text: string;
  /** Mittelpunkt des Schriftzugs, in Originalpunkten. */
  x: number;
  y: number;
  /** Schrifthöhe in Originalpunkten – wächst mit dem Bild, nicht mit dem Bildschirm. */
  groesse: number;
  farbe: string;
  kontur: string | null;
  schrift: string;
  fett: boolean;
}

export interface BildDoc {
  drehung: Drehung;
  spiegel: boolean;
  zuschnitt: Zuschnitt;
  striche: Malstrich[];
  texte: Schriftzug[];
}

/** Die längste Kante, die beim Speichern herauskommt. */
export const MAX_KANTE = 2560;

export function neuesDoc(width: number, height: number): BildDoc {
  return {
    drehung: 0,
    spiegel: false,
    zuschnitt: { x: 0, y: 0, w: width, h: height },
    striche: [],
    texte: [],
  };
}

export function docKopie(doc: BildDoc): BildDoc {
  return {
    drehung: doc.drehung,
    spiegel: doc.spiegel,
    zuschnitt: { ...doc.zuschnitt },
    striche: doc.striche.map((strich) => ({ ...strich, punkte: strich.punkte.slice() })),
    texte: doc.texte.map((text) => ({ ...text })),
  };
}

/** Ob überhaupt etwas geändert wurde – sonst lohnt das Speichern nicht. */
export function docUnberuehrt(doc: BildDoc, width: number, height: number): boolean {
  return (
    doc.drehung === 0 &&
    !doc.spiegel &&
    doc.striche.length === 0 &&
    doc.texte.every((text) => text.text.trim().length === 0) &&
    doc.zuschnitt.x === 0 &&
    doc.zuschnitt.y === 0 &&
    doc.zuschnitt.w === width &&
    doc.zuschnitt.h === height
  );
}

/** Wie gross das Bild nach dem Drehen ist – hochkant tauscht die Kanten. */
export function ansichtGroesse(
  width: number,
  height: number,
  drehung: Drehung,
): { w: number; h: number } {
  return drehung === 90 || drehung === 270 ? { w: height, h: width } : { w: width, h: height };
}

/** Originalpunkt → Punkt im gedrehten Bild. */
export function nachAnsicht(p: Punkt, width: number, height: number, doc: BildDoc): Punkt {
  const x = doc.spiegel ? width - p.x : p.x;
  const y = p.y;
  switch (doc.drehung) {
    case 90:
      return { x: height - y, y: x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: y, y: width - x };
    default:
      return { x, y };
  }
}

/** Punkt im gedrehten Bild → Originalpunkt. Die Umkehrung von `nachAnsicht`. */
export function nachOriginal(p: Punkt, width: number, height: number, doc: BildDoc): Punkt {
  let x: number;
  let y: number;
  switch (doc.drehung) {
    case 90:
      x = p.y;
      y = height - p.x;
      break;
    case 180:
      x = width - p.x;
      y = height - p.y;
      break;
    case 270:
      x = width - p.y;
      y = p.x;
      break;
    default:
      x = p.x;
      y = p.y;
  }
  return { x: doc.spiegel ? width - x : x, y };
}

/** Der Zuschnitt, wie er in der Ansicht liegt – als achsenparalleles Rechteck. */
export function zuschnittInAnsicht(
  zuschnitt: Zuschnitt,
  width: number,
  height: number,
  doc: BildDoc,
): Zuschnitt {
  const a = nachAnsicht({ x: zuschnitt.x, y: zuschnitt.y }, width, height, doc);
  const b = nachAnsicht(
    { x: zuschnitt.x + zuschnitt.w, y: zuschnitt.y + zuschnitt.h },
    width,
    height,
    doc,
  );
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Und zurück: ein in der Ansicht gezogenes Rechteck als Zuschnitt am Original. */
export function ansichtAlsZuschnitt(
  rechteck: Zuschnitt,
  width: number,
  height: number,
  doc: BildDoc,
): Zuschnitt {
  const a = nachOriginal({ x: rechteck.x, y: rechteck.y }, width, height, doc);
  const b = nachOriginal(
    { x: rechteck.x + rechteck.w, y: rechteck.y + rechteck.h },
    width,
    height,
    doc,
  );
  return zuschnittHalten(
    {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    },
    width,
    height,
  );
}

/** Die kleinste Kante, die ein Zuschnitt haben darf – darunter ist es kein Bild mehr. */
const MIN_KANTE = 16;

/**
 * Hält einen Zuschnitt im Bild.
 *
 * Erst die Grösse begrenzen, dann die Lage: andersherum liesse sich ein zu
 * grosses Rechteck an den Rand schieben und würde dort abgeschnitten, was den
 * Zuschnitt beim blossen Verschieben kleiner machte.
 */
export function zuschnittHalten(z: Zuschnitt, width: number, height: number): Zuschnitt {
  const w = Math.min(Math.max(z.w, Math.min(MIN_KANTE, width)), width);
  const h = Math.min(Math.max(z.h, Math.min(MIN_KANTE, height)), height);
  return {
    x: Math.min(Math.max(z.x, 0), width - w),
    y: Math.min(Math.max(z.y, 0), height - h),
    w,
    h,
  };
}

/**
 * Passt einen Zuschnitt an ein festes Seitenverhältnis an.
 *
 * Es wird immer *verkleinert*, nie vergrössert – sonst könnte das Rechteck aus
 * dem Bild herauswachsen und müsste anschliessend wieder hineingeschoben
 * werden, was den Bildausschnitt verschöbe, ohne dass jemand darum gebeten
 * hat. Der Mittelpunkt bleibt, wo er war.
 */
export function aufVerhaeltnis(
  z: Zuschnitt,
  verhaeltnis: number,
  width: number,
  height: number,
): Zuschnitt {
  const mx = z.x + z.w / 2;
  const my = z.y + z.h / 2;
  let w = z.w;
  let h = z.h;
  if (w / h > verhaeltnis) w = h * verhaeltnis;
  else h = w / verhaeltnis;
  // Auch am Bild selbst darf es nicht scheitern: ein 16:9-Ausschnitt aus einem
  // hochkanten Foto ist schmaler als das Foto breit ist.
  if (w > width) {
    w = width;
    h = w / verhaeltnis;
  }
  if (h > height) {
    h = height;
    w = h * verhaeltnis;
  }
  return zuschnittHalten({ x: mx - w / 2, y: my - h / 2, w, h }, width, height);
}

/**
 * Die Ausgabegrösse und der Massstab dorthin.
 *
 * Ein Handyfoto hat heute gut 4000 Punkte Kantenlänge. Unverkleinert
 * gespeichert wäre das mehrere Megabyte pro Bearbeitung – für ein Bild, das
 * am Ende auf einem Telefon angeschaut wird.
 */
export function ausgabeGroesse(
  zuschnitt: Zuschnitt,
  drehung: Drehung,
  maxKante = MAX_KANTE,
): { w: number; h: number; faktor: number } {
  const roh = ansichtGroesse(zuschnitt.w, zuschnitt.h, drehung);
  const faktor = Math.min(1, maxKante / Math.max(roh.w, roh.h));
  return {
    w: Math.max(1, Math.round(roh.w * faktor)),
    h: Math.max(1, Math.round(roh.h * faktor)),
    faktor,
  };
}

/** Dreht im Uhrzeigersinn weiter und bleibt dabei im Bereich 0…270. */
export function weiterdrehen(drehung: Drehung, schritte: number): Drehung {
  const grad = (((drehung / 90 + schritte) % 4) + 4) % 4;
  return (grad * 90) as Drehung;
}
