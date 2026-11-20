/**
 * Sprachnachricht per Gedrückthalten – was eine Bewegung des Fingers heisst.
 *
 * Wie bei WhatsApp: nach links wischen bricht ab, nach oben wischen sperrt
 * (die Aufnahme läuft ohne Finger weiter), loslassen sendet. Reine
 * Funktionen, geprüft in `haltenGeste.test.ts`.
 */
export type HaltenLage = 'aufnahme' | 'abbrechen' | 'sperren';

/** So weit nach links, und die Aufnahme ist verworfen. */
export const ABBRECHEN_PX = 90;
/** So weit nach oben, und die Aufnahme ist gesperrt. */
export const SPERREN_PX = 70;
/** Kürzer gehalten ist ein Tipp, keine Aufnahme. */
export const MINDEST_MS = 600;

export function haltenLage(dx: number, dy: number): HaltenLage {
  // Wer klar nach links zieht, will abbrechen – auch wenn er dabei etwas
  // nach oben gerät. Sperren nur, wenn die Bewegung vor allem nach oben geht.
  if (dx <= -ABBRECHEN_PX) return 'abbrechen';
  if (dy <= -SPERREN_PX && Math.abs(dx) < Math.abs(dy)) return 'sperren';
  return 'aufnahme';
}

/** Wie weit der Hinweis „‹ Zum Abbrechen wischen“ schon mitgezogen ist (0..1). */
export function abbruchFortschritt(dx: number): number {
  return Math.min(1, Math.max(0, -dx / ABBRECHEN_PX));
}

/** Was beim Loslassen geschieht. */
export function beimLoslassen(
  dauerMs: number,
  gesperrt: boolean,
): 'senden' | 'weiter' | 'verwerfen' {
  if (gesperrt) return 'weiter';
  return dauerMs < MINDEST_MS ? 'verwerfen' : 'senden';
}
