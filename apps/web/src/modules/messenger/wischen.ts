import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Nach rechts wischen zum Antworten (Touch).
 *
 * Die Regel ist rein (`wischSchritt`), damit der Test sie ohne DOM prüft:
 *
 * - Erst ab [`ENTSCHIEDEN_PX`] Weg entscheidet sich, ob es ein Wischen ist:
 *   deutlich waagerecht und nach rechts. Sonst ist es Scrollen, und die Geste
 *   gehört dem Verlauf.
 * - Die Blase folgt dem Finger, gedämpft, höchstens [`MAX_PX`].
 * - Ab [`SCHWELLE_PX`] gilt sie als Antwort; beim Überschreiten gibt es einen
 *   kurzen Ruck (`navigator.vibrate`, falls vorhanden). Losgelassen darunter:
 *   nichts.
 *
 * Mit der Maus wird nicht gewischt – dort gibt es das Menü (Tastatur und
 * Rechtsklick), und ein Zieh-Versuch beim Markieren von Text soll nicht
 * antworten.
 */
export const ENTSCHIEDEN_PX = 10;
export const SCHWELLE_PX = 56;
export const MAX_PX = 80;

export interface WischZustand {
  start: { x: number; y: number } | null;
  /** `null`: noch offen; `true`: wischt; `false`: scrollt (nicht mehr unsere Geste). */
  wischt: boolean | null;
  versatz: number;
  ueberSchwelle: boolean;
}

export const RUHE: WischZustand = { start: null, wischt: null, versatz: 0, ueberSchwelle: false };

export function wischSchritt(zustand: WischZustand, x: number, y: number): WischZustand {
  if (!zustand.start || zustand.wischt === false) return zustand;
  const dx = x - zustand.start.x;
  const dy = y - zustand.start.y;
  let wischt: boolean | null = zustand.wischt;
  if (wischt === null) {
    if (Math.hypot(dx, dy) < ENTSCHIEDEN_PX) return zustand;
    wischt = dx > 0 && Math.abs(dy) < dx * 0.6;
    if (!wischt) return { ...zustand, wischt: false, versatz: 0 };
  }
  // Gedämpft: Die Blase folgt dem Finger, aber nicht beliebig weit.
  const versatz = Math.max(0, Math.min(MAX_PX, dx * 0.7));
  return { ...zustand, wischt, versatz, ueberSchwelle: versatz >= SCHWELLE_PX * 0.7 };
}

export interface WischHandler {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Wischen nach rechts an einem Element; `onAntworten` beim Loslassen über der Schwelle. */
export function useWischenZumAntworten(
  onAntworten: (() => void) | null,
): WischHandler {
  const zustand = useRef<WischZustand>(RUHE);
  const element = useRef<HTMLElement | null>(null);

  function setzen(versatz: number) {
    const ziel = element.current;
    if (!ziel) return;
    ziel.style.transform = versatz > 0 ? `translateX(${versatz}px)` : '';
    ziel.style.transition = versatz > 0 ? 'none' : '';
  }

  function ende() {
    const war = zustand.current;
    zustand.current = RUHE;
    setzen(0);
    if (war.wischt && war.ueberSchwelle) onAntworten?.();
  }

  return {
    onPointerDown(event) {
      if (!onAntworten || event.pointerType !== 'touch') return;
      element.current = event.currentTarget;
      zustand.current = { ...RUHE, start: { x: event.clientX, y: event.clientY } };
    },
    onPointerMove(event) {
      if (!zustand.current.start) return;
      const vorher = zustand.current;
      const nachher = wischSchritt(vorher, event.clientX, event.clientY);
      zustand.current = nachher;
      if (nachher.wischt) setzen(nachher.versatz);
      if (nachher.ueberSchwelle && !vorher.ueberSchwelle) {
        try {
          navigator.vibrate?.(12);
        } catch {
          /* kein Vibrationsmotor */
        }
      }
    },
    onPointerUp: ende,
    onPointerCancel() {
      zustand.current = RUHE;
      setzen(0);
    },
  };
}
