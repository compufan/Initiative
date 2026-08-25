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

/** One eraser stroke in canvas coordinates, points stored as a flat x/y list. */
export interface Stroke {
  size: number;
  points: number[];
}

/** Ein Antippen im Bild: alles, was farblich daran hängt, bleibt erhalten. */
export interface KeepSeed {
  /** Position auf der Sticker-Fläche, 0 … STICKER_SIZE. */
  x: number;
  y: number;
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
    keep: doc.keep.map((seed) => ({ ...seed })),
    strokes: doc.strokes.map((stroke) => ({ size: stroke.size, points: stroke.points.slice() })),
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
export function keepAtSeeds(image: ImageData, seeds: KeepSeed[], tolerance: number): void {
  const { width, height, data } = image;
  const total = width * height;
  if (seeds.length === 0) return;

  const keep = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);

  for (const seed of seeds) {
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
  const soft = blurAlpha(grown, width, height, 1);

  for (let i = 0; i < total; i += 1) {
    const at = i * 4;
    if (data[at + 3] === 0) continue;
    data[at + 3] = Math.round((data[at + 3] * soft[i]) / 255);
  }
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

function applyStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
  if (strokes.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  for (const stroke of strokes) {
    const points = stroke.points;
    if (points.length < 2) continue;
    if (points.length === 2) {
      ctx.beginPath();
      ctx.arc(points[0], points[1], stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Blendet die Maske eines Modells über das gezeichnete Bild.
 *
 * Die Maske liegt in Quellbild-Koordinaten und wird mit **derselben**
 * Geometrie gezeichnet wie das Bild selbst – deshalb passt sie auch dann noch,
 * wenn danach verschoben oder gezoomt wurde.
 */
function applyAutoMask(
  ctx: CanvasRenderingContext2D,
  source: Extract<EditorSource, { kind: 'image' }>,
  doc: StickerDoc,
  mask: AutoMask,
): void {
  const grau = document.createElement('canvas');
  grau.width = mask.width;
  grau.height = mask.height;
  const grauCtx = grau.getContext('2d');
  if (!grauCtx) return;

  const bild = new ImageData(mask.width, mask.height);
  for (let i = 0; i < mask.alpha.length; i += 1) {
    const at = i * 4;
    bild.data[at] = 255;
    bild.data[at + 1] = 255;
    bild.data[at + 2] = 255;
    bild.data[at + 3] = mask.alpha[i];
  }
  grauCtx.putImageData(bild, 0, 0);

  // Erst auf eine eigene Flaeche in Stickergroesse bringen. Direkt mit
  // "destination-in" zu zeichnen ginge schief: alles ausserhalb des
  // gezeichneten Rechtecks wuerde sonst ebenfalls stehenbleiben.
  const flaeche = document.createElement('canvas');
  flaeche.width = STICKER_SIZE;
  flaeche.height = STICKER_SIZE;
  const flaecheCtx = flaeche.getContext('2d');
  if (!flaecheCtx) return;
  flaecheCtx.imageSmoothingQuality = 'high';
  const rect = sourceRect(source, doc);
  flaecheCtx.drawImage(grau, rect.x, rect.y, rect.width, rect.height);

  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(flaeche, 0, 0);
  ctx.restore();
}

/**
 * Draws the whole document. `fast` skips the two expensive steps (flood fill
 * and dilation) so panning and pinching stay at 60 fps on a phone; the full
 * pipeline runs again as soon as the gesture ends.
 */
export function renderSticker(
  canvas: HTMLCanvasElement,
  source: EditorSource | null,
  doc: StickerDoc,
  options: { fast?: boolean } = {},
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

  // Die Maske eines Modells zuerst: sie beschreibt das Motiv genauer als jede
  // Farbschwelle. Antippen und "Ecken entfernen" wirken danach nur noch auf
  // das, was uebrig geblieben ist.
  if (!options.fast && source?.kind === 'image' && doc.autoMask) {
    applyAutoMask(ctx, source, doc, doc.autoMask);
  }

  // Angetippte Bereiche haben Vorrang: Wer sagt, was bleiben soll, braucht das
  // Wegräumen von den Ecken her nicht mehr.
  if (!options.fast && source?.kind === 'image' && (doc.keep.length > 0 || doc.removeBg)) {
    const image = ctx.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE);
    if (doc.keep.length > 0) keepAtSeeds(image, doc.keep, doc.tolerance);
    else removeBackground(image, doc.tolerance);
    ctx.putImageData(image, 0, 0);
  }

  applyShape(ctx, doc.shape);
  applyStrokes(ctx, doc.strokes);

  if (!options.fast && doc.outline && doc.outlineWidth > 0) {
    applyOutline(canvas, Math.round(doc.outlineWidth));
  }

  drawTextLayer(ctx, doc.top, 'top');
  drawTextLayer(ctx, doc.bottom, 'bottom');
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
