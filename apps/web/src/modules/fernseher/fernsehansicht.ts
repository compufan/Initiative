/**
 * Was die Fernsehansicht rechnet – ohne React, damit es sich prüfen lässt.
 *
 * Die Ansicht selbst steht in `Fernsehansicht.tsx`; warum es sie gibt, in
 * `spiegeln.ts`.
 */

/**
 * Ab wie vielen Punkten eine Bewegung ein Wischen ist und kein Tipp.
 *
 * Fünfzig Punkte sind auf jedem Telefon deutlich mehr als das Zittern eines
 * Fingers beim Tippen, und deutlich weniger als ein halbherziges Wischen.
 */
export const WISCH_PUNKTE = 50;

/**
 * Welche Richtung ein Wischen meint: `1` weiter, `-1` zurück, `0` keins.
 *
 * Nach links wischen heisst „weiter" – wie in jeder Bildergalerie: Das
 * nächste Bild kommt von rechts herein. Eine Bewegung, die mehr senkrecht als
 * waagrecht ist, zählt nicht; sonst blätterte schon, wer das Telefon nur
 * anders in die Hand nimmt.
 */
export function wischSchritt(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < WISCH_PUNKTE) return 0;
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * Wo die Ansicht beginnt.
 *
 * Der Reihe nach: bei dem Stück, das gerade offen war – wer im Betrachter bei
 * Bild sieben auf „Spiegeln" tippt, will nicht bei Bild eins landen. Gemischt:
 * am Anfang der Mischung, sonst stünde das gewählte Bild immer vorn und die
 * Mischung wäre keine.
 */
export function startStelle(start: number, anzahl: number, modus: 'linear' | 'zufall'): number {
  if (anzahl <= 0 || modus !== 'linear') return 0;
  return Math.min(Math.max(0, Math.floor(start)), anzahl - 1);
}

/** Ist das ein Gerät mit WebKit auf iOS/iPadOS – ohne Element-Vollbild? */
export function ohneElementVollbild(ua: string, beruehrungspunkte: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && beruehrungspunkte > 1);
}

/**
 * Vollbild und Querformat versuchen – SYNCHRON aus einem Klick heraus.
 *
 * # Warum hier und nicht in der Ansicht
 *
 * `requestFullscreen` verlangt eine frische Nutzeraktivierung, und Chrome
 * erlaubt `screen.orientation.lock` nur im Vollbild. Aufgerufen wird es
 * deshalb im Klick auf „Fernsehansicht starten", nicht in einem Effekt der
 * Ansicht – der liefe einen Takt zu spät.
 *
 * # Warum nicht auf dem iPhone
 *
 * Das iPhone kann kein Element-Vollbild (nur Videos, und das ist genau die
 * Falle, siehe `Fernsehansicht`), und `orientation.lock` gibt es in Safari
 * nicht. Dort muss die Ausrichtungssperre aus sein; die Anleitung sagt es.
 */
export function vollbildVersuchen(): void {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return;
  if (ohneElementVollbild(navigator.userAgent, navigator.maxTouchPoints || 0)) return;
  const wurzel = document.documentElement;
  if (typeof wurzel.requestFullscreen !== 'function' || document.fullscreenElement) return;
  wurzel
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      const lage = screen.orientation as ScreenOrientation & {
        lock?: (ausrichtung: string) => Promise<void>;
      };
      if (lage && typeof lage.lock === 'function') lage.lock('landscape').catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Vollbild und Querformat wieder freigeben – still, wenn nichts davon aktiv war. */
export function vollbildVerlassen(): void {
  if (typeof document === 'undefined') return;
  try {
    const lage = screen.orientation as ScreenOrientation & { unlock?: () => void };
    if (lage && typeof lage.unlock === 'function') lage.unlock();
  } catch {
    /* Nicht gesperrt – nichts zu lösen. */
  }
  if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
    document.exitFullscreen().catch(() => undefined);
  }
}
