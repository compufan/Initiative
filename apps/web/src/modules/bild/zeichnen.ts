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
  type Malstrich,
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
/** Ein fertig gerechneter Unkenntlich-Strich, so wie er gezeichnet wird. */
interface Unkenntlichkeit {
  flaeche: HTMLCanvasElement;
  /** Die betroffene Fläche in Bildpunkten – dorthin wird zurückgezeichnet. */
  x0: number;
  y0: number;
  bw: number;
  bh: number;
  /** Massstab, in dem gerechnet wurde. Ändert er sich, gilt der Zettel nicht. */
  skala: number;
  /** Länge des Strichs. Kommt ein Punkt dazu, gilt der Zettel nicht. */
  punkte: number;
}

/**
 * Der Merkzettel: je Strich das fertige Ergebnis.
 *
 * `WeakMap` und nicht `Map`: Ein Strich, der aus dem Dokument verschwindet
 * (rückgängig, gelöscht), nimmt seinen Zettel mit. Eine gewöhnliche Map
 * hielte beides fest, und jeder zurückgenommene Weichzeichner bliebe für
 * immer im Speicher stehen.
 */
const gemerkt = new WeakMap<Malstrich, Unkenntlichkeit>();

/**
 * Verpixelt oder verwischt, was unter dem Strich liegt.
 *
 * Die Rechnung läuft auf dem Quellbild, beschnitten durch die Strichform
 * selbst, damit ein Zug mit rundem Pinsel auch rund wirkt und nicht als
 * Rechteck.
 *
 * Zwei Dinge halten das bezahlbar:
 *
 * 1. Gerechnet wird in der Auflösung, in der das Ergebnis auch gezeigt wird.
 *    Ein 4000er Foto in einer 1200er Ansicht braucht keine 4000er Kacheln –
 *    das ist rund elfmal weniger Arbeit, sichtbar ist davon nichts.
 * 2. Das Ergebnis bleibt am Strich hängen. Vorher rechnete *jeder*
 *    Zeichenrahmen *jeden* Weichzeichner neu – bei einem grossen Strich
 *    Sekunden, und zwar je Bild. Jetzt einmal je Strich, wie es hier immer
 *    schon behauptet wurde.
 */
function unkenntlich(
  ctx: CanvasRenderingContext2D,
  bild: CanvasImageSource,
  strich: Malstrich,
  width: number,
  height: number,
  skala: number,
): void {
  const alt = gemerkt.get(strich);
  if (alt && alt.skala === skala && alt.punkte === strich.punkte.length) {
    ctx.drawImage(alt.flaeche, alt.x0, alt.y0, alt.bw, alt.bh);
    return;
  }

  // Die betroffene Fläche, grosszügig um die halbe Strichbreite erweitert.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < strich.punkte.length; i += 2) {
    x0 = Math.min(x0, strich.punkte[i]);
    x1 = Math.max(x1, strich.punkte[i]);
    y0 = Math.min(y0, strich.punkte[i + 1]);
    y1 = Math.max(y1, strich.punkte[i + 1]);
  }
  const rand = strich.breite / 2 + 2;
  x0 = Math.max(0, Math.floor(x0 - rand));
  y0 = Math.max(0, Math.floor(y0 - rand));
  x1 = Math.min(width, Math.ceil(x1 + rand));
  y1 = Math.min(height, Math.ceil(y1 + rand));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;
  // Die Arbeitsgrösse: so gross wie die Ausgabe, nie grösser als das Original.
  const pw = Math.max(1, Math.round(bw * skala));
  const ph = Math.max(1, Math.round(bh * skala));

  /*
   * Gelesen wird aus dem QUELLBILD, nicht aus der Leinwand.
   *
   * Das ist keine Bequemlichkeit, sondern notwendig: `getImageData` arbeitet
   * laut Spezifikation im Raster der Ausgabe und ignoriert die aktuelle
   * Transformation, `drawImage` dagegen zeichnet durch sie hindurch. An
   * dieser Stelle trägt die Leinwand Massstab, Versatz und Drehung – ein
   * `getImageData(x0, y0, …)` mit Bildkoordinaten läse also an einer ganz
   * anderen Stelle als der, an die anschliessend gezeichnet wird. Bei Faktor
   * 0,5 läge ein Strich bei Bildpunkt 1000 auf Gerätepunkt 500, gelesen würde
   * aber bei 1000 – meist ausserhalb der Leinwand, also nichts.
   *
   * Aus dem Quellbild zu lesen ist zugleich das richtigere Ergebnis: Verpixelt
   * wird das Foto, nicht die Kringel, die jemand darübergemalt hat.
   */
  const hilf = arbeitsflaeche(pw, ph);
  const hctx = hilf.getContext('2d', { willReadFrequently: true });
  if (!hctx) return;
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.globalCompositeOperation = 'source-over';
  hctx.clearRect(0, 0, pw, ph);
  hctx.drawImage(bild, x0, y0, bw, bh, 0, 0, pw, ph);
  const daten = hctx.getImageData(0, 0, pw, ph);
  // Kachel und Radius wandern in denselben Massstab wie die Fläche, sonst
  // wäre die Verpixelung in der Ansicht gröber oder feiner als im Ergebnis.
  const kachel = Math.max(2, Math.round((strich.breite * skala) / 2));
  if (strich.art === 'pixel') {
    // Kachelweise Mittelwert – die klassische Verpixelung.
    for (let ky = 0; ky < ph; ky += kachel) {
      for (let kx = 0; kx < pw; kx += kachel) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        const bisY = Math.min(ky + kachel, ph);
        const bisX = Math.min(kx + kachel, pw);
        for (let y = ky; y < bisY; y += 1) {
          for (let x = kx; x < bisX; x += 1) {
            const at = (y * pw + x) * 4;
            r += daten.data[at];
            g += daten.data[at + 1];
            b += daten.data[at + 2];
            n += 1;
          }
        }
        if (n === 0) continue;
        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);
        for (let y = ky; y < bisY; y += 1) {
          for (let x = kx; x < bisX; x += 1) {
            const at = (y * pw + x) * 4;
            daten.data[at] = r;
            daten.data[at + 1] = g;
            daten.data[at + 2] = b;
          }
        }
      }
    }
  } else {
    // Kastenweichzeichner, getrennt in zwei Durchgänge – das ist linear in
    // der Radiusgrösse statt quadratisch.
    const radius = Math.max(1, Math.round((strich.breite * skala) / 6));
    kastenWeich(daten.data, pw, ph, radius);
  }

  // Zurück auf die Hilfsfläche, dann die Strichform als Schablone. Die
  // Transformation bringt Bildpunkte auf die Hilfsfläche – so darf der Strich
  // mit seinen eigenen Koordinaten gezeichnet werden.
  hctx.putImageData(daten, 0, 0);
  hctx.globalCompositeOperation = 'destination-in';
  hctx.setTransform(skala, 0, 0, skala, -x0 * skala, -y0 * skala);
  hctx.lineCap = 'round';
  hctx.lineJoin = 'round';
  hctx.strokeStyle = '#000';
  hctx.fillStyle = '#000';
  hctx.lineWidth = strich.breite;
  hctx.beginPath();
  if (strich.punkte.length === 2) {
    hctx.arc(strich.punkte[0], strich.punkte[1], strich.breite / 2, 0, Math.PI * 2);
    hctx.fill();
  } else {
    hctx.moveTo(strich.punkte[0], strich.punkte[1]);
    for (let i = 2; i < strich.punkte.length; i += 2) {
      hctx.lineTo(strich.punkte[i], strich.punkte[i + 1]);
    }
    hctx.stroke();
  }
  hctx.setTransform(1, 0, 0, 1, 0, 0);

  // Die Arbeitsfläche ist geteilt und beim nächsten Strich überschrieben –
  // für den Merkzettel braucht es eine eigene Kopie.
  const eigen = document.createElement('canvas');
  eigen.width = pw;
  eigen.height = ph;
  const ectx = eigen.getContext('2d');
  if (ectx) {
    ectx.drawImage(hilf, 0, 0);
    gemerkt.set(strich, { flaeche: eigen, x0, y0, bw, bh, skala, punkte: strich.punkte.length });
  }
  ctx.drawImage(hilf, x0, y0, bw, bh);
}

/** Kastenweichzeichner, waagerecht und senkrecht getrennt. */
function kastenWeich(daten: Uint8ClampedArray, w: number, h: number, r: number): void {
  const zwischen = new Uint8ClampedArray(daten.length);
  for (let k = 0; k < 3; k += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let summe = 0;
        let n = 0;
        for (let d = -r; d <= r; d += 1) {
          const xx = x + d;
          if (xx < 0 || xx >= w) continue;
          summe += daten[(y * w + xx) * 4 + k];
          n += 1;
        }
        zwischen[(y * w + x) * 4 + k] = summe / n;
      }
    }
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < h; y += 1) {
        let summe = 0;
        let n = 0;
        for (let d = -r; d <= r; d += 1) {
          const yy = y + d;
          if (yy < 0 || yy >= h) continue;
          summe += zwischen[(yy * w + x) * 4 + k];
          n += 1;
        }
        daten[(y * w + x) * 4 + k] = summe / n;
      }
    }
  }
}

/** Eine wiederverwendete Arbeitsfläche – nicht bei jedem Strich eine neue. */
let arbeitsCanvas: HTMLCanvasElement | null = null;
function arbeitsflaeche(w: number, h: number): HTMLCanvasElement {
  if (!arbeitsCanvas) arbeitsCanvas = document.createElement('canvas');
  if (arbeitsCanvas.width !== w) arbeitsCanvas.width = w;
  if (arbeitsCanvas.height !== h) arbeitsCanvas.height = h;
  return arbeitsCanvas;
}

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

  /*
   * Erst unkenntlich machen, dann malen – und zwar unabhängig davon, in
   * welcher Reihenfolge die Striche entstanden sind.
   *
   * `unkenntlich` liest aus dem Quellbild und zeichnet mit `source-over`.
   * Wer also einen schwarzen Balken über ein Kennzeichen zieht und danach
   * daneben verwischt, holte mit dem Verwischen das Foto unter dem Balken
   * wieder hervor, soweit sich beide überlappen. Das ist genau der Fall, in
   * dem jemand etwas verbergen wollte – der teuerste denkbare Fehler.
   */
  const skala = Math.min(1, optionen.faktor);
  for (const strich of doc.striche) {
    if (strich.punkte.length < 2) continue;
    if (strich.art === 'pixel' || strich.art === 'weich') {
      unkenntlich(ctx, bild, strich, width, height, skala);
    }
  }
  for (const strich of doc.striche) {
    if (strich.punkte.length < 2) continue;
    if (strich.art === 'pixel' || strich.art === 'weich') continue;
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
  /**
   * Die linke obere Ecke des gezeigten Ausschnitts, in Ansichtspunkten.
   *
   * Gehört zum Rückgabewert, weil die Bedienseite ihn zum Zurückrechnen von
   * Bildschirmpunkten braucht – und weil er hier gekappt wird, damit der
   * Ausschnitt nicht über das Bild hinausläuft. Wer den ungekappten Wunsch
   * zurückrechnete, träfe daneben.
   */
  versatz: { x: number; y: number };
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
  optionen: {
    maxKante: number;
    zuschnittZeigen: boolean;
    /** Lupenfaktor, 1 = ganzes Bild. */
    zoom?: number;
    /** Linke obere Ecke des sichtbaren Ausschnitts, in Ansichtspunkten. */
    versatz?: { x: number; y: number };
  },
): AnsichtMass | null {
  const sicht = ansichtGroesse(width, height, doc.drehung);
  // Die Leinwand behält ihre Grösse; herangezoomt wird der INHALT. So bleibt
  // das Fenster gleich und man sieht einen Ausschnitt statt eines grösseren
  // Bildes, das über den Rand hinausragt.
  const basis = Math.min(1, optionen.maxKante / Math.max(sicht.w, sicht.h));
  const zoom = Math.max(1, optionen.zoom ?? 1);
  const faktor = basis * zoom;
  const breite = Math.max(1, Math.round(sicht.w * basis));
  const hoehe = Math.max(1, Math.round(sicht.h * basis));
  // Der Ausschnitt darf nicht über das Bild hinauslaufen.
  const sichtbarB = breite / faktor;
  const sichtbarH = hoehe / faktor;
  const versatz = {
    x: Math.max(0, Math.min(sicht.w - sichtbarB, optionen.versatz?.x ?? 0)),
    y: Math.max(0, Math.min(sicht.h - sichtbarH, optionen.versatz?.y ?? 0)),
  };
  if (canvas.width !== breite) canvas.width = breite;
  if (canvas.height !== hoehe) canvas.height = hoehe;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, breite, hoehe);
  ctx.imageSmoothingQuality = 'high';
  malen(ctx, bild, width, height, doc, { faktor, versatz });

  if (optionen.zuschnittZeigen) {
    zeichneZuschnitt(
      ctx,
      zuschnittInAnsicht(doc.zuschnitt, width, height, doc),
      faktor,
      { breite, hoehe },
      versatz,
    );
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { faktor, breite, hoehe, versatz };
}

/** Der abgedunkelte Rand mit Rahmen, Ecken und Drittellinien. */
function zeichneZuschnitt(
  ctx: CanvasRenderingContext2D,
  z: Zuschnitt,
  faktor: number,
  leinwand: { breite: number; hoehe: number },
  versatz: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const x = (z.x - versatz.x) * faktor;
  const y = (z.y - versatz.y) * faktor;
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
