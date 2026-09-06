import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
}

/**
 * Long press (touch) plus the desktop context menu, both leading to the same
 * action sheet. Moving the finger cancels, so scrolling never opens the menu.
 */
export function useLongPress(onTrigger: () => void, delay = 450): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  return {
    onPointerDown(event) {
      if (event.button != null && event.button !== 0) return;
      /*
       * Nur, wenn der Druck WIRKLICH auf dieser Nachricht landete.
       *
       * React leitet Ereignisse am eigenen Baum entlang weiter – auch durch
       * ein Portal hindurch. Die Lichtbox hängt im DOM am Dokumentkörper,
       * im React-Baum aber weiter unter der Nachrichtenblase. Ein
       * Zeigerdruck im Bildeditor, der aus dieser Lichtbox heraus geöffnet
       * wurde, kam damit hier an und stellte den Wecker.
       *
       * Was der Anwender davon sah: Er zog im Editor den ersten
       * Pinselstrich, und mitten hinein sprang das Nachrichtenmenü mit
       * „Für alle löschen“. Nachgemessen: Der Wecker schlug 502 ms nach dem
       * Beginn des Zugs zu – die 450 ms von hier.
       *
       * `contains` fragt den DOM und nicht React. Ein Druck im Portal ist
       * dort nicht enthalten, und genau das ist die Auskunft, die wir
       * brauchen.
       */
      const ziel = event.target as Node | null;
      if (ziel && !event.currentTarget.contains(ziel)) return;
      /*
       * Erst aufräumen, DANN den Anfangspunkt merken.
       *
       * Andersherum stand es hier eine Zeit lang, und es machte die
       * Bewegungsprüfung unten wirkungslos: `clear()` setzt `origin` auf
       * null, also fand `onPointerMove` nie einen Anfangspunkt und stieg
       * jedes Mal sofort aus. Man konnte den Finger quer über den Bildschirm
       * ziehen, und nach 450 ms sprang trotzdem das Menü auf – während des
       * Scrollens, mitten im Wischen.
       *
       * Der Fehler ist die unangenehme Sorte: Er macht nichts kaputt, was
       * auffällt, er lässt nur eine Schutzmassnahme still ausfallen.
       */
      clear();
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onTrigger();
      }, delay);
    },
    onPointerMove(event) {
      const start = origin.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu(event) {
      event.preventDefault();
      clear();
      onTrigger();
    },
  };
}
