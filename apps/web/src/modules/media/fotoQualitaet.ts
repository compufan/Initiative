/**
 * Foto-Qualität: Standard oder HD.
 *
 * Standard sind 1920 Punkte an der langen Kante – scharf auf jedem Telefon,
 * klein genug für jedes Netz. HD sind bis zu 4096 Punkte, also die
 * Originalauflösung bis zu dieser Grenze, mit höherer Güte.
 *
 * Bewusst wird auch in HD neu kodiert und nie die Kameradatei selbst
 * geschickt: Ein Original trägt seine Metadaten mit (EXIF – darunter oft der
 * Ort der Aufnahme). Wer das Original will, schickt es „Als Datei“; dort sagt
 * die Oberfläche, was mitgeht. Reine Funktionen, geprüft in
 * `fotoQualitaet.test.ts`.
 */
export const STANDARD_KANTE = 1920;
export const HD_KANTE = 4096;
export const STANDARD_GUETE = 0.82;
export const HD_GUETE = 0.9;

export interface HdZiel {
  /** Lange Kante, auf die höchstens verkleinert wird. */
  kante: number;
  /** Güte der Kodierung (WebP/JPEG). */
  guete: number;
}

export function fotoKante(hd: boolean): number {
  return hd ? HD_KANTE : STANDARD_KANTE;
}

export function hdZiel(hd: boolean): HdZiel {
  return hd
    ? { kante: HD_KANTE, guete: HD_GUETE }
    : { kante: STANDARD_KANTE, guete: STANDARD_GUETE };
}

/** Die Masse nach dem Verkleinern auf `kante` (nie vergrössert). */
export function zielMasse(
  breite: number,
  hoehe: number,
  kante: number,
): { breite: number; hoehe: number } {
  const faktor = Math.min(1, kante / Math.max(breite, hoehe, 1));
  return { breite: Math.round(breite * faktor), hoehe: Math.round(hoehe * faktor) };
}

/** Verdient ein Bild das „HD“-Abzeichen? Mehr als Standard an der langen Kante. */
export function istHd(
  breite: number | null | undefined,
  hoehe: number | null | undefined,
): boolean {
  return Math.max(breite ?? 0, hoehe ?? 0) > STANDARD_KANTE;
}

const SCHLUESSEL = 'initiative.foto.hd';

/** Die zuletzt gewählte Qualität – je Gerät gemerkt, Standard aus. */
export function hdGemerkt(): boolean {
  try {
    return localStorage.getItem(SCHLUESSEL) === '1';
  } catch {
    return false;
  }
}

export function hdMerken(an: boolean): void {
  try {
    localStorage.setItem(SCHLUESSEL, an ? '1' : '0');
  } catch {
    /* ohne Speicher eben nicht gemerkt */
  }
}
