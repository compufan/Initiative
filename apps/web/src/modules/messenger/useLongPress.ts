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
      origin.current = { x: event.clientX, y: event.clientY };
      clear();
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
