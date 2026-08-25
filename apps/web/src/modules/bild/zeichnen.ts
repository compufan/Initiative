/**
 * Das Zeichnen der Bildbearbeitung – Ansicht und Ausgabe aus einer Hand.
 *
 * Beides benutzt denselben Weg: erst das Bild mit seiner Drehung, dann die
 * gemalten Striche (die kleben am Bild und drehen mit), dann die Schriftzüge
 * (die bleiben aufrecht). Zwei getrennte Zeichenwege wären die zuverlässigste
 * Art, eine Vorschau zu bauen, die nicht zeigt, was am Ende herauskommt.
 */

import {
  ansichtGroesse,
  ausgabeGroesse,
  nachAnsicht,
  zuschnittInAnsicht,
  type BildDoc,
  type Schriftzug,
  type Zuschnitt,
} from './doc.js';

/**
 * Die Schriftarten zur Auswahl.
 *
 * Bewusst nur das, was auf dem Gerät ohnehin liegt: Eine mitgelieferte Schrift
 * kostet Download bei jedem Start und wirft eine Lizenzfrage auf, die niemand
 * stellen wollte. Jede Angabe ist eine Kette mit Rückfall, damit auf Android
 * etwas Ähnliches erscheint wie auf dem iPhone.
 */
export const SCHRIFTEN: { key: string; label: string; stack: string }[] = [
  {
    key: 'system',
    label: 'Normal',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  { key: 'serif', label: 'Serifen', stack: 'Georgia, "Times New Roman", Times, serif' },
  {
    key: 'mono',
    label: 'Technisch',
    stack: '"SF Mono", "Roboto Mono", Menlo, Consolas, monospace',
  },
  { key: 'rund', label: 'Rund', stack: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive' },
  {
    key: 'schmal',
    label: 'Schmal',
    stack: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif',
  },
];

export function schriftStack(key: string): string {
  return (SCHRIFTEN.find((eintrag) => eintrag.key === key) ?? SCHRIFTEN[0]).stack;
}

/** Wie dick die Kontur eines Schriftzugs im Verhältnis zur Schrifthöhe ist. */
const KONTUR_ANTEIL = 0.14;

/** Zeilenabstand – etwas mehr als die Schrifthöhe, sonst kleben Zeilen. */
const ZEILE = 1.18;

export interface Textmass {
  breite: number;
  hoehe: number;
  zeilen: string[];
}

/**
 * Misst einen Schriftzug in Ansichtspunkten.
 *
 * Wird an zwei Stellen gebraucht: zum Zeichnen und zum Antippen. Beide müssen
 * dasselbe Ergebnis bekommen, sonst greift man neben den Text, den man sieht.
 */
export function textMessen(ctx: CanvasRenderingContext2D, text: Schriftzug): Textmass {
  const zeilen = text.text.length > 0 ? text.text.split('\n') : [''];
  ctx.font = `${text.fett ? '700 ' : ''}${text.groesse}px ${schriftStack(text.schrift)}`;
  let breite = 0;
  for (const zeile of zeilen) breite = Math.max(breite, ctx.measureText(zeile).width);
  return { breite, hoehe: zeilen.length * text.groesse * ZEILE, zeilen };
}

/** Ob ein Punkt (in Ansichtspunkten) auf dem Schriftzug liegt. */
export function trifftText(
  ctx: CanvasRenderingContext2D,
  text: Schriftzug,
  ankerAnsicht: { x: number; y: number },
  punkt: { x: number; y: number },
): boolean {
  const mass = textMessen(ctx, text);
  // Etwas Luft: Ein Finger ist breiter als eine Schriftlinie, und ein leerer
  // Schriftzug haette sonst gar keine Trefferflaeche.
  const luft = Math.max(text.groesse * 0.4, 12);
  return (
    Math.abs(punkt.x - ankerAnsicht.x) <= mass.breite / 2 + luft &&
    Math.abs(punkt.y - ankerAnsicht.y) <= mass.hoehe / 2 + luft
  );
}

function zeichneText(
  ctx: CanvasRenderingContext2D,
  text: Schriftzug,
  anker: { x: number; y: number },
): void {
  if (text.text.trim().length === 0) return;
  const mass = textMessen(ctx, text);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const oben = anker.y - mass.hoehe / 2 + (text.groesse * ZEILE) / 2;
  mass.zeilen.forEach((zeile, index) => {
    const y = oben + index * text.groesse * ZEILE;
    if (text.kontur) {
      ctx.strokeStyle = text.kontur;
      ctx.lineWidth = text.groesse * KONTUR_ANTEIL;
      ctx.strokeText(zeile, anker.x, y);
    }
    ctx.fillStyle = text.farbe;
    ctx.fillText(zeile, anker.x, y);
  });
  ctx.restore();
}

/**
 * Setzt die Leinwand so, dass danach in Punkten des *gedrehten* Bildes
 * gezeichnet wird – unabhängig davon, wie gross die Leinwand ist und welchen
 * Ausschnitt sie zeigt.
 */
function ansichtsRaum(
  ctx: CanvasRenderingContext2D,
  faktor: number,
  versatz: { x: number; y: number },
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(faktor, faktor);
  ctx.translate(-versatz.x, -versatz.y);
}

/** Legt zusätzlich die Drehung des Bildes an, sodass in Originalpunkten gilt. */
function bildRaum(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  doc: BildDoc,
): void {
  const sicht = ansichtGroesse(width, height, doc.drehung);
  switch (doc.drehung) {
    case 90:
      ctx.translate(sicht.w, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case 180:
      ctx.translate(sicht.w, sicht.h);
      ctx.rotate(Math.PI);
      break;
    case 270:
      ctx.translate(0, sicht.h);
      ctx.rotate(-Math.PI / 2);
      break;
    default:
      break;
  }
  if (doc.spiegel) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
}

interface MalOptionen {
  faktor: number;
  versatz: { x: number; y: number };
}

/**
 * Malt Bild, Striche und Schriftzüge – der gemeinsame Kern von Ansicht und
 * Ausgabe.
 */
function malen(
  ctx: CanvasRenderingContext2D,
  bild: CanvasImageSource,
  width: number,
  height: number,
  doc: BildDoc,
  optionen: MalOptionen,
): void {
  ansichtsRaum(ctx, optionen.faktor, optionen.versatz);
  ctx.save();
  bildRaum(ctx, width, height, doc);
  ctx.drawImage(bild, 0, 0, width, height);

  // Die Striche liegen im selben Raum wie das Bild und drehen deshalb mit –
  // ein Kringel um einen Kopf bleibt um den Kopf.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const strich of doc.striche) {
    if (strich.punkte.length < 2) continue;
    ctx.strokeStyle = strich.farbe;
    ctx.fillStyle = strich.farbe;
    ctx.lineWidth = strich.breite;
    if (strich.punkte.length === 2) {
      ctx.beginPath();
      ctx.arc(strich.punkte[0], strich.punkte[1], strich.breite / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(strich.punkte[0], strich.punkte[1]);
    for (let i = 2; i < strich.punkte.length; i += 2) {
      ctx.lineTo(strich.punkte[i], strich.punkte[i + 1]);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Schrift bleibt aufrecht: Wer ein Foto hochkant dreht, will keinen
  // Schriftzug, der auf der Seite liegt.
  ansichtsRaum(ctx, optionen.faktor, optionen.versatz);
  for (const text of doc.texte) {
    zeichneText(ctx, text, nachAnsicht({ x: text.x, y: text.y }, width, height, doc));
  }
}

export interface AnsichtMass {
  /** Wie viele Leinwandpunkte auf einen Punkt des gedrehten Bildes kommen. */
  faktor: number;
  breite: number;
  hoehe: number;
}

/**
 * Zeichnet die Arbeitsansicht: das ganze gedrehte Bild, darüber die
 * Kennzeichnung des Zuschnitts.
 *
 * Der Zuschnitt wird angedeutet und nicht angewandt – solange man ihn noch
 * verschiebt, muss man sehen, was daneben liegt.
 */
export function zeichneAnsicht(
  canvas: HTMLCanvasElement,
  bild: CanvasImageSource,
  width: number,
  height: number,
  doc: BildDoc,
  optionen: { maxKante: number; zuschnittZeigen: boolean },
): AnsichtMass | null {
  const sicht = ansichtGroesse(width, height, doc.drehung);
  const faktor = Math.min(1, optionen.maxKante / Math.max(sicht.w, sicht.h));
  const breite = Math.max(1, Math.round(sicht.w * faktor));
  const hoehe = Math.max(1, Math.round(sicht.h * faktor));
  if (canvas.width !== breite) canvas.width = breite;
  if (canvas.height !== hoehe) canvas.height = hoehe;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, breite, hoehe);
  ctx.imageSmoothingQuality = 'high';
  malen(ctx, bild, width, height, doc, { faktor, versatz: { x: 0, y: 0 } });

  if (optionen.zuschnittZeigen) {
    zeichneZuschnitt(ctx, zuschnittInAnsicht(doc.zuschnitt, width, height, doc), faktor, {
      breite,
      hoehe,
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { faktor, breite, hoehe };
}

/** Der abgedunkelte Rand mit Rahmen, Ecken und Drittellinien. */
function zeichneZuschnitt(
  ctx: CanvasRenderingContext2D,
  z: Zuschnitt,
  faktor: number,
  leinwand: { breite: number; hoehe: number },
): void {
  const x = z.x * faktor;
  const y = z.y * faktor;
  const w = z.w * faktor;
  const h = z.h * faktor;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.fillStyle = 'rgba(4, 8, 20, 0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, leinwand.breite, leinwand.hoehe);
  // Zweites Rechteck gegen den Uhrzeigersinn: so bleibt der Ausschnitt frei.
  ctx.rect(x + w, y, -w, h);
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
    ctx.stroke();
  }

  // Ecken kräftig: Sie sind die Griffe, und man muss sehen, wo man anfassen kann.
  const arm = Math.min(24, w / 3, h / 3);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  const ecken: [number, number, number, number][] = [
    [x, y + arm, x, y],
    [x, y, x + arm, y],
    [x + w - arm, y, x + w, y],
    [x + w, y, x + w, y + arm],
    [x + w, y + h - arm, x + w, y + h],
    [x + w, y + h, x + w - arm, y + h],
    [x + arm, y + h, x, y + h],
    [x, y + h, x, y + h - arm],
  ];
  ctx.beginPath();
  for (const [ax, ay, bx, by] of ecken) {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
  ctx.restore();
}

/** Rechnet das fertige Bild – zugeschnitten, gedreht, mit allem darauf. */
export function zeichneAusgabe(
  bild: CanvasImageSource,
  width: number,
  height: number,
  doc: BildDoc,
): HTMLCanvasElement {
  const mass = ausgabeGroesse(doc.zuschnitt, doc.drehung);
  const canvas = document.createElement('canvas');
  canvas.width = mass.w;
  canvas.height = mass.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingQuality = 'high';
  const ausschnitt = zuschnittInAnsicht(doc.zuschnitt, width, height, doc);
  malen(ctx, bild, width, height, doc, {
    faktor: mass.faktor,
    versatz: { x: ausschnitt.x, y: ausschnitt.y },
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
