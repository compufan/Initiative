import { API_BASE } from '../../lib/api.js';
import { timestampName } from '../media/helpers.js';

/**
 * Small helpers shared by the sticker picker, the studio and the library.
 * Everything that touches storage, blobs or URLs lives here so the components
 * stay readable.
 */

/** Sticker URLs are relative to the API, which may live on another host. */
export function stickerSrc(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  return `${API_BASE}${url}`;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ---------- recently used stickers ---------- */

const RECENT_KEY = 'initiative.stickers.recent';
export const RECENT_MAX = 24;

export function readRecentStickers(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Moves the sticker to the front of the recents list and returns the new list. */
export function rememberSticker(id: string): string[] {
  const next = [id, ...readRecentStickers().filter((value) => value !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode – recents simply do not persist */
  }
  return next;
}

/* ---------- image sources ---------- */

/**
 * Decodes a picked file. An `<img>` element (instead of `createImageBitmap`)
 * keeps HEIC photos from iPhones working and needs no manual lifecycle.
 */
export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        reject(new Error('Bild konnte nicht gelesen werden'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Bild konnte nicht gelesen werden'));
    };
    image.src = url;
  });
}

let webpSupport: boolean | null = null;

/** WebP keeps a 512×512 sticker well below the 2 MB upload ceiling. */
export function supportsWebp(): boolean {
  if (webpSupport != null) return webpSupport;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/**
 * Die Bytes eines Stickers – zum Lesen, nicht zum Anzeigen.
 *
 * Ueber `/bytes`, nicht ueber die Adresse selbst: Die leitet zum Speicher um,
 * und nach einer Umleitung auf eine andere Herkunft schickt der Browser
 * `Origin: null` – die CORS-Regel des Speichers greift dann nicht mehr und
 * `fetch` bekommt nichts zurueck. Beim blossen Anzeigen (`<img src>`) ist das
 * egal, beim Lesen der Bytes nicht.
 *
 * Bewusst OHNE `credentials`: Die Medienrouten kennen keinen angemeldeten
 * Benutzer, die Anhangskennung ist der Schluessel. Steht `CORS_ORIGINS` auf
 * `*`, schaltet der Server `allow_credentials(false)` (app.rs) – eine
 * Anfrage mit Anmeldedaten wuerde dann vom Browser verworfen.
 *
 * Nur die Bytes, nicht das Speichern: Wer erst holt und dann teilt, hat auf
 * dem iPhone die Nutzerhandlung schon verbraucht und das Teilen-Blatt geht
 * nicht mehr auf. Die Aufrufer holen deshalb vorab und speichern erst auf
 * Knopfdruck.
 */
export async function stickerBytes(url: string): Promise<Blob> {
  const antwort = await fetch(`${stickerSrc(url)}/bytes`);
  if (!antwort.ok) throw new Error(`Der Sticker konnte nicht geladen werden (${antwort.status})`);
  return await antwort.blob();
}

/**
 * `sticker-20260825-172531.webp`.
 *
 * Die Endung kommt aus der Tabelle in `media/helpers.ts` und nicht aus einer
 * eigenen Abfrage: Die riet frueher „webp, ausser es steht png dran“ – und
 * lieferte fuer eine Antwort mit `application/octet-stream` einen Namen, der
 * ein Format behauptet, das nicht drin ist.
 */
export function stickerFileName(mime: string): string {
  return timestampName('sticker', mime);
}

/** First grapheme of the input – a sticker carries exactly one emoji. */
export function firstEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });
    for (const segment of segmenter.segment(trimmed)) return segment.segment;
    return '';
  }
  return [...trimmed][0] ?? '';
}
