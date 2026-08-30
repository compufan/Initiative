/**
 * The rendering pipeline of the sticker studio.
 *
 * The editor never mutates pixels destructively: the document below describes
 * *what* should happen and `renderSticker` replays the whole pipeline into a
 * 512×512 canvas. Undo therefore only has to restore an older document, and
 * moving the photo after erasing something keeps working.
 *
 * Order: source → background removal → shape mask → eraser → outline → text.
 */

import { maskeAus, type Teile } from './engines/teile.js';

export const STICKER_SIZE = 512;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export type ShapeKind = 'square' | 'circle' | 'free';
export type TextSlot = 'top' | 'bottom';

export interface TextLayer {
  value: string;
  size: number;
  color: string;
  outline: boolean;
}

/**
 * Ein Pinselstrich in Sticker-Koordinaten, Punkte als flache x/y-Liste.
 *
 * `weg` radiert, `zurueck` holt das Original wieder hervor. Das zweite ist
 * kein Luxus: Ein Modell frisst gern eine Ohrspitze oder eine Haarsträhne
 * weg, und ohne Zurückholen bliebe nur, das Freistellen ganz zu verwerfen.
 */
export interface Stroke {
  size: number;
  points: number[];
  mode: 'weg' | 'zurueck';
}

/** Ein Antippen im Bild: alles, was farblich daran hängt, bleibt erhalten. */
export interface KeepSeed {
  /** Position auf der Sticker-Fläche, 0 … STICKER_SIZE. */
  x: number;
  y: number;
  /**
   * Ob dieser Tipp etwas hinzunimmt oder wegnimmt.
   *
   * Fehlt der Wert, gilt „dazu“ – so bleiben Sticker gültig, die vor dieser
   * Unterscheidung entstanden sind, und die Farbflutung (`keepAtSeeds`)
   * verhält sich unverändert.
   *
   * `weg` kann nur „Antippen mit Netz“: Das Netz nimmt Punkte mit Vorzeichen
   * entgegen, die Flutung kennt nur Hinzunehmen.
   */
  mode?: 'dazu' | 'weg';
  /**
   * Zu welchem Tipp dieser Punkt gehört.
   *
   * Beim Netz meint ein Tipp **einen Gegenstand**: SAM nimmt zwar beliebig
   * viele Punkte, versteht sie aber als Hinweise auf *ein* Ding. Zwei Tipps
   * auf getrennte Dinge in einem Lauf liefern deshalb Matsch – nachgemessen
   * deckte sich die gemeinsame Maske mit der Vereinigung der Einzelmasken nur
   * zu IoU 0,54, und 46 % ihrer Fläche gehörte zu keinem der beiden Dinge.
   *
   * Also: je Plus-Tipp eine eigene Gruppe, je Gruppe ein Lauf, und die
   * Ergebnisse werden vereinigt. Ein Minus-Tipp hängt sich an die Gruppe, die
   * er berichtigen soll.
   */
  gruppe?: number;
  /** Wer die Maske für diese Gruppe rechnet. Ohne Angabe die Farbflutung. */
  quelle?: 'flutung' | 'netz';
}

/**
 * Das Ergebnis eines Modells: eine fertige Maske.
 *
 * Sie liegt bewusst in den Koordinaten des **Quellbildes**, nicht der
 * Sticker-Fläche. Nur so bleibt sie beim Verschieben und Zoomen gültig –
 * sonst müsste nach jeder Geste neu gerechnet werden.
 *
 * Einmal berechnet, wird sie nicht mehr verändert. `cloneDoc` reicht deshalb
 * dieselbe Maske weiter, statt ein Megabyte pro Rückgängig-Schritt zu kopieren.
 */
export interface AutoMask {
  /** Welches Verfahren sie erzeugt hat – für die Anzeige im Studio. */
  engine: string;
  width: number;
  height: number;
  /** `width * height` Werte, 0 = weg, 255 = bleibt. */
  alpha: Uint8Array;
  /**
   * Die Maske, zerlegt in zusammenhängende Flächen – damit man einzelne
   * antippen kann. Siehe `engines/teile.ts`.
   *
   * Wie `alpha` nach dem Berechnen unveränderlich, also per Referenz
   * weitergereicht statt kopiert.
   */
  teile?: Teile;
}

export interface StickerDoc {
  offsetX: number;
  offsetY: number;
  scale: number;
  shape: ShapeKind;
  removeBg: boolean;
  /** Angetippte Stellen, die im Sticker bleiben sollen. */
  keep: KeepSeed[];
  /** Die Maske eines Modells, falls eines gelaufen ist. */
  autoMask: AutoMask | null;
  /**
   * Die Maske der Netz-Tipps – getrennt von `autoMask`, und das ist der Punkt.
   *
   * Lägen beide im selben Feld, wären Antippen und Modell wieder Alternativen
   * statt unabhängig. Getrennt lassen sie sich vereinigen: Die Person kommt
   * vom Modell, die Säule vom Tipp, und beide bleiben.
   *
   * Wie `autoMask` in Quellbild-Koordinaten, damit sie das Verschieben und
   * Zoomen übersteht.
   */
  tippMaske: AutoMask | null;
  /**
   * Welche Teile der Modell-Maske gewählt sind.
   *
   * Leer heisst **alle** – solange niemand etwas angetippt hat, verhält sich
   * das Modell wie zuvor. Wer einmal tippt, sieht genau das Gewählte.
   */
  maskParts: number[];
  /**
   * Ob im Editor das Abgewählte gekennzeichnet statt weggenommen wird.
   *
   * Beim Auswählen will man sehen, was da ist – sonst tippt man ins Schwarze
   * und kann nichts hinzunehmen. Auf dem fertigen Sticker ist es natürlich
   * fort; das hier gilt nur für die Ansicht während der Arbeit.
   */
  showUnselected: boolean;
  tolerance: number;
  outline: boolean;
  outlineWidth: number;
  strokes: Stroke[];
  top: TextLayer;
  bottom: TextLayer;
}

export type EditorSource =
  | { kind: 'image'; image: HTMLImageElement; width: number; height: number }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'text' };

export function createDoc(): StickerDoc {
  return {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    shape: 'square',
    removeBg: false,
    keep: [],
    autoMask: null,
    tippMaske: null,
    maskParts: [],
    showUnselected: true,
    tolerance: 40,
    outline: true,
    outlineWidth: 10,
    strokes: [],
    top: { value: '', size: 68, color: '#ffffff', outline: true },
    bottom: { value: '', size: 68, color: '#ffffff', outline: true },
  };
}

export function cloneDoc(doc: StickerDoc): StickerDoc {
  return {
    ...doc,
    // Die Maske wird nach dem Berechnen nie mehr angefasst – eine Referenz
    // genuegt und spart pro Rueckgaengig-Schritt ein Megabyte.
    autoMask: doc.autoMask,
    tippMaske: doc.tippMaske,
    maskParts: doc.maskParts.slice(),
    keep: doc.keep.map((seed) => ({ ...seed })),
    strokes: doc.strokes.map((stroke) => ({ ...stroke, points: stroke.points.slice() })),
    top: { ...doc.top },
    bottom: { ...doc.bottom },
  };
}

/** True as soon as the document would produce visible pixels. */
export function isEmptyDoc(source: EditorSource | null, doc: StickerDoc): boolean {
  if (source && source.kind !== 'text') return false;
  return doc.top.value.trim().length === 0 && doc.bottom.value.trim().length === 0;
}

/* ---------- background removal ---------- */

function colourDistance(dr: number, dg: number, db: number): number {
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/**
 * "Antippen zum Behalten": das Gegenstück zu `removeBackground`.
 *
 * Statt vom Rand her wegzuräumen, wächst hier von jeder angetippten Stelle ein
 * Bereich über farblich verwandte Nachbarn – alles ausserhalb wird
 * durchsichtig. Das trifft genau die Erwartung „ich tippe auf das, was ich im
 * Sticker haben will“, und funktioniert auf jedem Gerät ohne Download.
 *
 * Mehrere Antipper addieren sich, damit sich auch mehrfarbige Motive
 * zusammensetzen lassen (Gesicht, dann Haare, dann Pullover).
 */
export function flutmaske(image: ImageData, seeds: KeepSeed[], tolerance: number): Uint8Array {
  const { width, height, data } = image;
  const total = width * height;
  if (seeds.length === 0) return new Uint8Array(total);

  const keep = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);

  for (const seed of seeds) {
    // Die Flutung kann kein Wegnehmen – ein Minus-Tipp waere hier ein
    // zusaetzlicher Saatpunkt, also das genaue Gegenteil des Gemeinten.
    if (seed.mode === 'weg') continue;
    const sx = Math.round(seed.x);
    const sy = Math.round(seed.y);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const start = sy * width + sx;
    const startAt = start * 4;
    if (data[startAt + 3] === 0) continue;

    // Jeder Antipper beginnt mit frischer Besuchsliste, sonst blockieren sich
    // zwei Bereiche gegenseitig.
    visited.fill(0);
    const seedR = data[startAt];
    const seedG = data[startAt + 1];
    const seedB = data[startAt + 2];

    let top = 0;
    visited[start] = 1;
    keep[start] = 1;
    stack[top++] = start;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;

      const visit = (neighbour: number) => {
        if (visited[neighbour]) return;
        visited[neighbour] = 1;
        const at = neighbour * 4;
        if (data[at + 3] === 0) return;
        const distance = colourDistance(
          data[at] - seedR,
          data[at + 1] - seedG,
          data[at + 2] - seedB,
        );
        if (distance <= tolerance) {
          keep[neighbour] = 1;
          stack[top++] = neighbour;
        }
      };

      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y < height - 1) visit(index + width);
    }
  }

  // Kleine Löcher im Motiv schliessen (Lichtreflexe, Augen) und die Kante
  // weich auslaufen lassen, damit kein Treppenmuster stehen bleibt.
  const grown = dilateAlpha(
    Uint8Array.from(keep, (value) => (value ? 255 : 0)),
    width,
    height,
    2,
  );
  return blurAlpha(grown, width, height, 1);
}

/**
 * Die alte, anwendende Fassung – nur noch für Aufrufer, die das Bild direkt
 * beschneiden wollen.
 *
 * Die Zeichenkette benutzt sie **nicht** mehr: Dort wird die Flutmaske mit der
 * Modellmaske vereinigt statt sie zu überschreiben. Genau diese Multiplikation
 * hier war der Grund, dass ein Tipp neben dem Motiv den Sticker leerte.
 */
export function keepAtSeeds(image: ImageData, seeds: KeepSeed[], tolerance: number): void {
  if (seeds.length === 0) return;
  const soft = flutmaske(image, seeds, tolerance);
  const { data } = image;
  for (let i = 0; i < soft.length; i += 1) {
    const at = i * 4;
    if (data[at + 3] === 0) continue;
    data[at + 3] = Math.round((data[at + 3] * soft[i]) / 255);
  }
}

/**
 * Zwei Deckungen vereinigen – die eine Rechnung, auf der Punkt D beruht.
 *
 * `b über a`, wie zwei Folien übereinander:
 *
 *     v = b + a · (255 − b) / 255
 *
 * Zwei Eigenschaften machen sie zur richtigen Wahl, und beide sind der Grund,
 * dass „Antippen überschreibt das Freigestellte nicht“ keine Absichtserklärung
 * ist, sondern aus der Formel folgt:
 *
 *   - `v ≥ a` und `v ≥ b` – ein Tipp kann eine vorhandene Maske niemals
 *     verkleinern, und eine Maske niemals einen Tipp.
 *   - `v ≤ 255` – nichts läuft über.
 *
 * Ein blosses Maximum täte es auch, aber an weichen Kanten, wo beide Masken
 * halb decken, entstünde eine sichtbare Naht; hier ergänzen sie sich glatt.
 */
export function vereinigeAlpha(a: Uint8Array, b: Uint8Array): Uint8Array {
  const raus = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    raus[i] = Math.round(b[i] + (a[i] * (255 - b[i])) / 255);
  }
  return raus;
}

/**
 * "Hintergrund entfernen (einfach)": a flood fill that starts at the four
 * corners and clears everything close enough to the corner colour. Pixels just
 * outside the tolerance fade out instead of ending in a hard staircase edge.
 */
export function removeBackground(image: ImageData, tolerance: number): void {
  const { width, height, data } = image;
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const feather = Math.max(6, tolerance * 0.4);
  const corners = [0, width - 1, (height - 1) * width, total - 1];

  for (const seed of corners) {
    if (visited[seed]) continue;
    const seedAt = seed * 4;
    if (data[seedAt + 3] === 0) {
      visited[seed] = 1;
      continue;
    }
    const seedR = data[seedAt];
    const seedG = data[seedAt + 1];
    const seedB = data[seedAt + 2];

    let top = 0;
    visited[seed] = 1;
    data[seedAt + 3] = 0;
    stack[top++] = seed;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;

      const visit = (neighbour: number) => {
        if (visited[neighbour]) return;
        const at = neighbour * 4;
        if (data[at + 3] === 0) {
          visited[neighbour] = 1;
          return;
        }
        const distance = colourDistance(
          data[at] - seedR,
          data[at + 1] - seedG,
          data[at + 2] - seedB,
        );
        if (distance <= tolerance) {
          visited[neighbour] = 1;
          data[at + 3] = 0;
          stack[top++] = neighbour;
        } else if (distance <= tolerance + feather) {
          visited[neighbour] = 1;
          data[at + 3] = Math.round((data[at + 3] * (distance - tolerance)) / feather);
        }
      };

      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y < height - 1) visit(index + width);
    }
  }
}

/* ---------- white outline ---------- */

/** Separable maximum filter – the dilation of the alpha mask. */
function dilateAlpha(alpha: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      let max = 0;
      for (let i = from; i <= to; i += 1) {
        const value = alpha[row + i];
        if (value > max) {
          max = value;
          if (max === 255) break;
        }
      }
      horizontal[row + x] = max;
    }
  }

  const result = new Uint8Array(alpha.length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      let max = 0;
      for (let i = from; i <= to; i += 1) {
        const value = horizontal[i * width + x];
        if (value > max) {
          max = value;
          if (max === 255) break;
        }
      }
      result[y * width + x] = max;
    }
  }
  return result;
}

/** Box blur with a running sum – rounds the corners of the square dilation. */
function blurAlpha(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius < 1) return mask;
  const window = radius * 2 + 1;
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1)
      sum += mask[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / window;
      sum -= mask[row + Math.max(0, x - radius)];
      sum += mask[row + Math.min(width - 1, x + radius + 1)];
    }
  }

  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / window;
      sum -= horizontal[Math.max(0, y - radius) * width + x];
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x];
    }
  }
  return result;
}

/** Puts a soft white sticker border underneath whatever is on the canvas. */
function applyOutline(canvas: HTMLCanvasElement, radius: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || radius < 1) return;
  const { width, height } = canvas;
  const source = ctx.getImageData(0, 0, width, height);

  const alpha = new Uint8Array(width * height);
  let visible = false;
  for (let i = 0; i < alpha.length; i += 1) {
    const value = source.data[i * 4 + 3];
    alpha[i] = value;
    if (value > 8) visible = true;
  }
  if (!visible) return;

  const dilated = dilateAlpha(alpha, width, height, radius);
  const soft = blurAlpha(dilated, width, height, Math.max(1, Math.round(radius / 3)));

  const outline = new ImageData(width, height);
  for (let i = 0; i < soft.length; i += 1) {
    const at = i * 4;
    outline.data[at] = 255;
    outline.data[at + 1] = 255;
    outline.data[at + 2] = 255;
    outline.data[at + 3] = Math.min(255, Math.round(soft[i] * 1.8));
  }

  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const layerCtx = layer.getContext('2d');
  if (!layerCtx) return;
  layerCtx.putImageData(outline, 0, 0);
  layerCtx.drawImage(canvas, 0, 0);

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(layer, 0, 0);
}

/* ---------- text ---------- */

function contrastColour(hex: string): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const r = Number.parseInt(full.slice(0, 2), 16) || 0;
  const g = Number.parseInt(full.slice(2, 4), 16) || 0;
  const b = Number.parseInt(full.slice(4, 6), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111111' : '#ffffff';
}

function drawTextLayer(ctx: CanvasRenderingContext2D, layer: TextLayer, slot: TextSlot): void {
  const value = layer.value.trim();
  if (value.length === 0) return;

  const maxWidth = STICKER_SIZE - 44;
  let size = layer.size;
  ctx.textAlign = 'center';
  ctx.textBaseline = slot === 'top' ? 'top' : 'bottom';
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  while (size > 18 && ctx.measureText(value).width > maxWidth) {
    size -= 2;
    ctx.font = `800 ${size}px ${FONT_STACK}`;
  }

  const x = STICKER_SIZE / 2;
  const y = slot === 'top' ? 22 : STICKER_SIZE - 22;
  if (layer.outline) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(3, size * 0.18);
    ctx.strokeStyle = contrastColour(layer.color);
    ctx.strokeText(value, x, y);
  }
  ctx.fillStyle = layer.color;
  ctx.fillText(value, x, y);
}

/* ---------- pipeline ---------- */

/**
 * Wohin das Quellbild auf der Sticker-Fläche gezeichnet wird.
 *
 * Steht hier allein, weil die Maske eines Modells **genau dieselbe** Geometrie
 * braucht: Bild und Maske müssen deckungsgleich landen, sonst sitzt der
 * Ausschnitt daneben.
 */
export function sourceRect(
  source: { width: number; height: number },
  doc: Pick<StickerDoc, 'scale' | 'offsetX' | 'offsetY'>,
): { x: number; y: number; width: number; height: number } {
  const cover = Math.max(STICKER_SIZE / source.width, STICKER_SIZE / source.height);
  const scale = cover * doc.scale;
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (STICKER_SIZE - width) / 2 + doc.offsetX,
    y: (STICKER_SIZE - height) / 2 + doc.offsetY,
    width,
    height,
  };
}

/**
 * Rechnet einen Punkt auf der Sticker-Fläche zurück ins Quellbild.
 *
 * Wird gebraucht, wenn jemand ein Gesicht antippt: das Modell arbeitet im
 * Quellbild, der Finger auf der Fläche.
 */
export function toSourcePoint(
  point: { x: number; y: number },
  source: { width: number; height: number },
  doc: Pick<StickerDoc, 'scale' | 'offsetX' | 'offsetY'>,
): { x: number; y: number } {
  const rect = sourceRect(source, doc);
  return {
    x: ((point.x - rect.x) / rect.width) * source.width,
    y: ((point.y - rect.y) / rect.height) * source.height,
  };
}

function drawSource(ctx: CanvasRenderingContext2D, source: EditorSource, doc: StickerDoc): void {
  if (source.kind === 'image') {
    const rect = sourceRect(source, doc);
    ctx.drawImage(source.image, rect.x, rect.y, rect.width, rect.height);
    return;
  }
  if (source.kind === 'emoji') {
    ctx.font = `${Math.round(340 * doc.scale)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(source.emoji, STICKER_SIZE / 2 + doc.offsetX, STICKER_SIZE / 2 + doc.offsetY);
  }
}

function applyShape(ctx: CanvasRenderingContext2D, shape: ShapeKind): void {
  if (shape !== 'circle') return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  ctx.arc(STICKER_SIZE / 2, STICKER_SIZE / 2, STICKER_SIZE / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();
}

/**
 * Fasst aufeinanderfolgende Striche derselben Richtung zusammen.
 *
 * Das ist der ganze Trick an der Reihenfolge: Radieren und Zurückholen sind
 * gegenläufig, und wer dieselbe Stelle radiert, zurückholt und wieder radiert,
 * erwartet, dass der letzte Strich gewinnt. Alle Radierstriche in einem Rutsch
 * und danach alle Zurückhol-Striche wäre einfacher – und falsch.
 */
export function strichBloecke(strokes: Stroke[]): Stroke[][] {
  const bloecke: Stroke[][] = [];
  for (const stroke of strokes) {
    const letzter = bloecke[bloecke.length - 1];
    if (letzter && letzter[0].mode === stroke.mode) letzter.push(stroke);
    else bloecke.push([stroke]);
  }
  return bloecke;
}

/**
 * Hält die Lupe im Bild.
 *
 * `zoom` ist die Vergrösserung, `x`/`y` der Punkt, der in der Mitte steht.
 * Ohne die Begrenzung könnte man bis in die leere Fläche neben dem Sticker
 * schieben und fände nicht mehr zurück.
 */
export function lupeGrenzen(
  next: { zoom: number; x: number; y: number },
  maxZoom: number,
): { zoom: number; x: number; y: number } {
  const zoom = Math.min(Math.max(next.zoom, 1), maxZoom);
  const halb = STICKER_SIZE / (2 * zoom);
  const halten = (wert: number) => Math.min(Math.max(wert, halb), STICKER_SIZE - halb);
  return { zoom, x: halten(next.x), y: halten(next.y) };
}

/** Zeichnet einen Strich – als Kreis, wenn er nur aus einem Antippen besteht. */
function strichZeichnen(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const points = stroke.points;
  if (points.length < 2) return;
  if (points.length === 2) {
    ctx.beginPath();
    ctx.arc(points[0], points[1], stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

/**
 * Wendet die Pinselstriche an – Radieren und Zurückholen in der Reihenfolge,
 * in der sie gemacht wurden.
 *
 * Die Reihenfolge ist nicht egal: Wer radiert, zurückholt und dieselbe Stelle
 * wieder radiert, erwartet, dass der letzte Strich gewinnt. Deshalb werden nur
 * *aufeinanderfolgende* Striche derselben Richtung zusammengefasst – in der
 * Praxis sind das ein oder zwei Blöcke, und die Reihenfolge stimmt trotzdem.
 *
 * `original` ist das Bild, wie es vor dem Freistellen gezeichnet war. Ohne das
 * gäbe es nichts zurückzuholen.
 */
function applyStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  original: HTMLCanvasElement | null,
): void {
  if (strokes.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  for (const block of strichBloecke(strokes)) {
    const mode = block[0].mode;

    if (mode === 'weg') {
      ctx.globalCompositeOperation = 'destination-out';
      for (const stroke of block) strichZeichnen(ctx, stroke);
      continue;
    }

    // Zurückholen: das Original durch die Strichform hindurch aufs Bild legen.
    if (!original) continue;
    const hilf = hilfsflaeche();
    const hctx = hilf.getContext('2d');
    if (!hctx) continue;
    hctx.setTransform(1, 0, 0, 1, 0, 0);
    hctx.globalCompositeOperation = 'source-over';
    hctx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
    hctx.drawImage(original, 0, 0);
    hctx.globalCompositeOperation = 'destination-in';
    hctx.lineCap = 'round';
    hctx.lineJoin = 'round';
    hctx.fillStyle = '#000000';
    hctx.strokeStyle = '#000000';
    for (const stroke of block) strichZeichnen(hctx, stroke);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(hilf, 0, 0);
  }
  ctx.restore();
}

/**
 * Legt eine Kopie des aktuellen Standes ab – das Bild vor dem Freistellen.
 *
 * Eigene Flaeche, nicht die aus `hilfsflaeche()`: die wird beim Zurueckholen
 * selbst gebraucht, und beides auf derselben Flaeche wuerde sich gegenseitig
 * ueberschreiben.
 */
let originalCanvas: HTMLCanvasElement | null = null;
function originalMerken(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  if (!originalCanvas) {
    originalCanvas = document.createElement('canvas');
    originalCanvas.width = STICKER_SIZE;
    originalCanvas.height = STICKER_SIZE;
  }
  const octx = originalCanvas.getContext('2d', { willReadFrequently: true });
  if (octx) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
    octx.drawImage(ctx.canvas, 0, 0);
  }
  return originalCanvas;
}

/**
 * Eine wiederverwendete Arbeitsfläche.
 *
 * Bei jedem Strich eine neue anzulegen hiesse, waehrend des Malens im
 * Sekundentakt 512x512-Flaechen zu erzeugen und dem Aufraeumer zu ueberlassen
 * – auf einem Handy merkt man das als Ruckeln.
 */
let hilfsCanvas: HTMLCanvasElement | null = null;
function hilfsflaeche(): HTMLCanvasElement {
  if (!hilfsCanvas) {
    hilfsCanvas = document.createElement('canvas');
    hilfsCanvas.width = STICKER_SIZE;
    hilfsCanvas.height = STICKER_SIZE;
  }
  return hilfsCanvas;
}

/**
 * Bringt eine Maske aus Quellbild-Koordinaten auf Sticker-Grösse.
 *
 * Gezeichnet wird mit **derselben** Geometrie wie das Bild – deshalb passt sie
 * auch dann noch, wenn danach verschoben oder gezoomt wurde. Beschnitten wird
 * hier nichts; das Ergebnis ist eine Deckung, die der Aufrufer mit anderen
 * vereinigt (siehe `freistellMaske`).
 */
function maskenflaeche(
  source: Extract<EditorSource, { kind: 'image' }>,
  doc: StickerDoc,
  mask: AutoMask,
  teileAnwenden: boolean,
): HTMLCanvasElement | null {
  const grau = document.createElement('canvas');
  grau.width = mask.width;
  grau.height = mask.height;
  const grauCtx = grau.getContext('2d');
  if (!grauCtx) return null;

  // Nur die gewaehlten Teile. Ohne Auswahl gilt die ganze Maske.
  const alpha =
    teileAnwenden && mask.teile && doc.maskParts.length > 0
      ? maskeAus(mask.alpha, mask.teile, doc.maskParts)
      : mask.alpha;

  const bild = new ImageData(mask.width, mask.height);
  for (let i = 0; i < alpha.length; i += 1) {
    const at = i * 4;
    bild.data[at] = 255;
    bild.data[at + 1] = 255;
    bild.data[at + 2] = 255;
    bild.data[at + 3] = alpha[i];
  }
  grauCtx.putImageData(bild, 0, 0);

  // Erst auf eine eigene Flaeche in Stickergroesse bringen. Direkt mit
  // "destination-in" zu zeichnen ginge schief: alles ausserhalb des
  // gezeichneten Rechtecks wuerde sonst ebenfalls stehenbleiben.
  const flaeche = document.createElement('canvas');
  flaeche.width = STICKER_SIZE;
  flaeche.height = STICKER_SIZE;
  const flaecheCtx = flaeche.getContext('2d');
  if (!flaecheCtx) return null;
  flaecheCtx.imageSmoothingQuality = 'high';
  const rect = sourceRect(source, doc);
  flaecheCtx.drawImage(grau, rect.x, rect.y, rect.width, rect.height);

  return flaeche;
}

/** Liest den Alphakanal einer Sticker-grossen Flaeche als Uint8Array. */
function deckungLesen(flaeche: HTMLCanvasElement | null): Uint8Array | null {
  if (!flaeche) return null;
  const fctx = flaeche.getContext('2d', { willReadFrequently: true });
  if (!fctx) return null;
  const bild = fctx.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE);
  const raus = new Uint8Array(STICKER_SIZE * STICKER_SIZE);
  for (let i = 0; i < raus.length; i += 1) raus[i] = bild.data[i * 4 + 3];
  return raus;
}

/**
 * Die eine Rechnung, aus der das Freistellen entsteht.
 *
 * Alle drei Deckungen liegen bereits in Sticker-Koordinaten und in derselben
 * Grösse. Modell und Tipp werden **vereinigt** – nicht multipliziert:
 *
 *     M = (Modell ∪ Netztipp) ∪ Flutung
 *
 * Genau hier steckt Punkt D des Pflichtenhefts. Vorher lief die Flutung als
 * zweiter, multiplizierender Schritt auf dem bereits beschnittenen Bild. Das
 * hatte zwei Folgen, beide nachgestellt: Die Säule neben der freigestellten
 * Person war dort schon durchsichtig, also nicht mehr zu fluten – und die
 * Schlussmultiplikation löschte alles Ungeflutete, also auch die Person.
 * Gemessen an einer 60×40-Vorlage: 450 von 450 Personenpunkten vorher, 0
 * nachher. Mit dieser Vereinigung sind es 450 Person und 450 Säule.
 *
 * `null` heisst „gibt es nicht“ und nicht „ist überall 0“ – sonst wäre der
 * Sticker leer, sobald gar nichts freigestellt wurde. Sind alle drei `null`,
 * gibt es nichts zu beschneiden, und der Aufrufer lässt den Schritt aus.
 */
export function freistellMaske(
  modell: Uint8Array | null,
  netz: Uint8Array | null,
  flutung: Uint8Array | null,
): Uint8Array | null {
  const teile = [modell, netz, flutung].filter((teil): teil is Uint8Array => teil !== null);
  if (teile.length === 0) return null;
  return teile.reduce((a, b) => vereinigeAlpha(a, b));
}

/**
 * Kennzeichnet, was gerade NICHT gewählt ist – statt es wegzunehmen.
 *
 * Beim Auswählen ist das der Unterschied zwischen bedienbar und nicht: Wer die
 * Bierflasche angetippt hat und nun die Person dazunehmen will, muss die
 * Person noch sehen. Ist sie bereits fort, tippt er ins Schwarze.
 *
 * Deshalb wird das Abgewählte abgedunkelt und schraffiert, nicht entfernt. Die
 * Schraffur ist dabei nicht Zierrat: Eine blosse Abdunklung ist von einem
 * dunklen Bildteil nicht zu unterscheiden, und dann rät man wieder.
 *
 * Auf dem fertigen Sticker gibt es das nicht – dies gilt allein für die
 * Ansicht während der Arbeit.
 */
function markiereAbgewaehltes(
  ctx: CanvasRenderingContext2D,
  source: Extract<EditorSource, { kind: 'image' }>,
  doc: StickerDoc,
  mask: AutoMask,
): void {
  if (!mask.teile || doc.maskParts.length === 0) return;

  const gewaehlt = maskeAus(mask.alpha, mask.teile, doc.maskParts);

  // Eine Karte des Abgewählten: dort deckend, wo die Maske etwas hat, die
  // Auswahl aber nicht.
  const karte = document.createElement('canvas');
  karte.width = mask.width;
  karte.height = mask.height;
  const karteCtx = karte.getContext('2d');
  if (!karteCtx) return;
  const bild = new ImageData(mask.width, mask.height);
  for (let i = 0; i < mask.alpha.length; i += 1) {
    const at = i * 4;
    bild.data[at] = 255;
    bild.data[at + 1] = 255;
    bild.data[at + 2] = 255;
    bild.data[at + 3] = Math.max(0, mask.alpha[i] - gewaehlt[i]);
  }
  karteCtx.putImageData(bild, 0, 0);

  const flaeche = document.createElement('canvas');
  flaeche.width = STICKER_SIZE;
  flaeche.height = STICKER_SIZE;
  const flaecheCtx = flaeche.getContext('2d');
  if (!flaecheCtx) return;

  // Erst die Schraffur über die ganze Fläche, dann auf das Abgewählte
  // beschneiden. Andersherum – Muster direkt in die Karte – bekäme man die
  // Streifen nicht durch die weichen Kanten der Maske.
  flaecheCtx.fillStyle = 'rgba(6, 10, 24, 0.5)';
  flaecheCtx.fillRect(0, 0, STICKER_SIZE, STICKER_SIZE);
  const muster = flaecheCtx.createPattern(schraffur(), 'repeat');
  if (muster) {
    flaecheCtx.fillStyle = muster;
    flaecheCtx.fillRect(0, 0, STICKER_SIZE, STICKER_SIZE);
  }

  flaecheCtx.globalCompositeOperation = 'destination-in';
  flaecheCtx.imageSmoothingQuality = 'high';
  const rect = sourceRect(source, doc);
  flaecheCtx.drawImage(karte, rect.x, rect.y, rect.width, rect.height);

  ctx.drawImage(flaeche, 0, 0);
}

/** Ein kleines Kachelbild mit Schrägstreifen. */
let schraffurCache: HTMLCanvasElement | null = null;
function schraffur(): HTMLCanvasElement {
  if (schraffurCache) return schraffurCache;
  const kachel = document.createElement('canvas');
  kachel.width = 12;
  kachel.height = 12;
  const ctx = kachel.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-4, 16);
    ctx.lineTo(16, -4);
    ctx.moveTo(2, 22);
    ctx.lineTo(22, 2);
    ctx.stroke();
  }
  schraffurCache = kachel;
  return kachel;
}

/**
 * Draws the whole document. `fast` skips the two expensive steps (flood fill
 * and dilation) so panning and pinching stay at 60 fps on a phone; the full
 * pipeline runs again as soon as the gesture ends.
 *
 * `weggenommenesZeigen` blendet das Weggenommene als grauen Schleier ein. Wer
 * die Säule neben der freigestellten Person antippen soll, muss sie noch
 * sehen; ist sie schon fort, tippt er ins Leere.
 *
 * `auswahlZeigen` ist die Ansicht während der Arbeit: Abgewähltes bleibt
 * sichtbar und wird nur gekennzeichnet. Für das Speichern niemals setzen.
 */
export function renderSticker(
  canvas: HTMLCanvasElement,
  source: EditorSource | null,
  doc: StickerDoc,
  options: { fast?: boolean; auswahlZeigen?: boolean; weggenommenesZeigen?: boolean } = {},
): void {
  if (canvas.width !== STICKER_SIZE) canvas.width = STICKER_SIZE;
  if (canvas.height !== STICKER_SIZE) canvas.height = STICKER_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
  ctx.imageSmoothingQuality = 'high';

  if (source) drawSource(ctx, source, doc);

  // Das unberuehrte Bild festhalten, solange es das noch ist – nur wenn es
  // auch jemand braucht. Fuer den Normalfall ohne Zurueckhol-Striche waere
  // die Kopie reine Arbeit ohne Wirkung.
  // Das unbeschnittene Bild wird jetzt an zwei Stellen gebraucht: vom
  // Zurueck-Pinsel wie bisher, und neu von der Farbflutung – die muss auf dem
  // ungeschnittenen Bild laufen, sonst ist das Angetippte schon fort.
  const brauchtStrich = doc.strokes.some((stroke) => stroke.mode === 'zurueck');
  const original = brauchtStrich ? originalMerken(ctx) : null;

  // Die Maske eines Modells zuerst: sie beschreibt das Motiv genauer als jede
  // Farbschwelle. Antippen und "Ecken entfernen" wirken danach nur noch auf
  // das, was uebrig geblieben ist.
  const zeigeAuswahl = Boolean(options.auswahlZeigen && doc.showUnselected);
  let schleier: ImageData | null = null;
  const flutSaat = doc.keep.filter((seed) => (seed.quelle ?? 'flutung') === 'flutung');

  /*
   * Modell, Netztipp und Farbflutung werden VEREINIGT, nicht nacheinander
   * multipliziert. Warum, steht bei `freistellMaske` – kurz: die alte
   * Reihenfolge liess einen Tipp neben dem Motiv den ganzen Sticker leeren.
   *
   * Die Flutung läuft dabei auf dem **unbeschnittenen** Bild. Auf dem
   * beschnittenen wäre die Säule neben der freigestellten Person längst
   * durchsichtig, und die Flutung bricht an durchsichtigen Punkten ab – es
   * gäbe dort schlicht nichts mehr anzutippen.
   */
  if (
    !options.fast &&
    source?.kind === 'image' &&
    (doc.autoMask || doc.tippMaske || flutSaat.length > 0 || doc.removeBg)
  ) {
    const modell = doc.autoMask
      ? deckungLesen(maskenflaeche(source, doc, doc.autoMask, !zeigeAuswahl))
      : null;
    const netz = doc.tippMaske
      ? deckungLesen(maskenflaeche(source, doc, doc.tippMaske, false))
      : null;

    const unberuehrt = originalMerken(ctx);
    let flutung: Uint8Array | null = null;
    if (flutSaat.length > 0 || doc.removeBg) {
      const octx = unberuehrt.getContext('2d', { willReadFrequently: true });
      const roh = octx?.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE) ?? null;
      if (roh) {
        if (flutSaat.length > 0) {
          flutung = flutmaske(roh, flutSaat, doc.tolerance);
        } else {
          // „Ecken entfernen“ arbeitet weiterhin abziehend, aber ebenfalls auf
          // dem unbeschnittenen Bild – sonst sind die vier Ecken bereits
          // durchsichtig und der Knopf täte buchstäblich nichts.
          removeBackground(roh, doc.tolerance);
          flutung = new Uint8Array(STICKER_SIZE * STICKER_SIZE);
          for (let i = 0; i < flutung.length; i += 1) flutung[i] = roh.data[i * 4 + 3];
        }
      }
    }

    const maske = freistellMaske(modell, netz, flutung);
    if (maske) {
      const bild = ctx.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE);
      for (let i = 0; i < maske.length; i += 1) {
        const at = i * 4 + 3;
        if (bild.data[at] === 0) continue;
        bild.data[at] = Math.round((bild.data[at] * maske[i]) / 255);
      }
      ctx.putImageData(bild, 0, 0);
    }

    if (options.weggenommenesZeigen && maske) {
      // Was die Maske weggenommen hat: dort, wo vorher Bild war und jetzt
      // keins mehr ist. Gezeichnet wird es erst ganz am Schluss – vor der
      // Kontur gezeichnet, bekäme der Schleier eine weisse Umrandung und
      // verdeckte genau den Rand, an dem man tippen will.
      const octx2 = unberuehrt.getContext('2d', { willReadFrequently: true });
      const roh2 = octx2?.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE);
      if (roh2) {
        for (let i = 0; i < maske.length; i += 1) {
          const at = i * 4 + 3;
          roh2.data[at] = Math.round((roh2.data[at] * (255 - maske[i])) / 255);
        }
        schleier = roh2;
      }
    }

    if (zeigeAuswahl && doc.autoMask) markiereAbgewaehltes(ctx, source, doc, doc.autoMask);
  }

  applyShape(ctx, doc.shape);
  applyStrokes(ctx, doc.strokes, original);

  if (!options.fast && doc.outline && doc.outlineWidth > 0) {
    applyOutline(canvas, Math.round(doc.outlineWidth));
  }

  // Der Schleier zuletzt: nach der Kontur, damit er nicht umrandet wird, und
  // vor der Schrift, damit die lesbar bleibt.
  if (schleier) schleierZeichnen(ctx, schleier);

  drawTextLayer(ctx, doc.top, 'top');
  drawTextLayer(ctx, doc.bottom, 'bottom');
}

/**
 * Zeichnet das Weggenommene matt und entfärbt zurück ins Bild.
 *
 * Bewusst ein glatter Wasch und keine Schraffur: Beim Auswählen von Teilen
 * braucht es die Schraffur, weil dort ein abgedunkelter Bildteil nicht von
 * einem dunklen zu unterscheiden wäre. Hier ist die Frage eine andere – „ist
 * das noch drin oder schon weg“ –, und dafür ist ein gleichmässiger Schleier
 * ruhiger und zeigt die Kante genauer.
 */
function schleierZeichnen(ctx: CanvasRenderingContext2D, weggenommen: ImageData): void {
  const flaeche = schleierflaeche();
  const sctx = flaeche.getContext('2d');
  if (!sctx) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
  sctx.putImageData(weggenommen, 0, 0);
  // Entfärben, aber nur dort, wo überhaupt etwas liegt.
  sctx.globalCompositeOperation = 'source-atop';
  sctx.fillStyle = 'rgba(126, 132, 140, 0.62)';
  sctx.fillRect(0, 0, STICKER_SIZE, STICKER_SIZE);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // `destination-over`: der Schleier legt sich UNTER das schon Gezeichnete.
  // So überdeckt er das Motiv nicht und füllt nur die Lücken.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(flaeche, 0, 0);
  ctx.restore();
}

/** Eigene Fläche für den Schleier – die beiden anderen sind schon belegt. */
let schleierCanvas: HTMLCanvasElement | null = null;
function schleierflaeche(): HTMLCanvasElement {
  if (!schleierCanvas) {
    schleierCanvas = document.createElement('canvas');
    schleierCanvas.width = STICKER_SIZE;
    schleierCanvas.height = STICKER_SIZE;
  }
  return schleierCanvas;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Sticker konnte nicht kodiert werden'))),
      mime,
      quality,
    );
  });
}

/** 512×512 export – WebP where the browser supports it, PNG otherwise. */
export async function exportSticker(
  canvas: HTMLCanvasElement,
  webp: boolean,
): Promise<{ blob: Blob; mime: string }> {
  const mime = webp ? 'image/webp' : 'image/png';
  return { blob: await toBlob(canvas, mime, 0.92), mime };
}
