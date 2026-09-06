import { describe, expect, it, vi } from 'vitest';
import { useLongPress, type LongPressHandlers } from './useLongPress.js';

/**
 * Die Haken ohne React aufrufen.
 *
 * `useLongPress` benutzt `useRef`, `useCallback` und `useEffect` – alle drei
 * lassen sich für diesen Zweck durch das Naheliegende ersetzen: ein Kästchen,
 * die Funktion selbst, nichts. Damit ist der Rückgabewert prüfbar, ohne einen
 * Renderer aufzusetzen, und geprüft wird genau das, worum es geht: welcher
 * Zeiger-Ablauf löst aus und welcher nicht.
 */
vi.mock('react', () => ({
  useRef: <T>(start: T) => ({ current: start }),
  useCallback: <T>(fn: T) => fn,
  useEffect: () => undefined,
}));

interface Zeiger {
  button?: number;
  clientX: number;
  clientY: number;
  target?: unknown;
  currentTarget: { contains: (ziel: unknown) => boolean };
}

function zeiger(x: number, y: number): Zeiger {
  const ziel = {};
  return {
    button: 0,
    clientX: x,
    clientY: y,
    target: ziel,
    currentTarget: { contains: () => true },
  };
}

/**
 * `window.setTimeout` statt `setTimeout`.
 *
 * Der Haken ruft es über `window` auf, damit TypeScript im Browser die
 * Zahl-Fassung nimmt und nicht Nodes `Timeout`-Objekt. Die Tests laufen aber
 * in Node, wo es kein `window` gibt – also wird eines hingestellt, das auf
 * dieselben gefälschten Uhren zeigt.
 */
function fensterStellen(): void {
  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
}

function aufbau(): { haken: LongPressHandlers; ausgeloest: () => number } {
  vi.useFakeTimers();
  fensterStellen();
  let n = 0;
  const haken = useLongPress(() => {
    n += 1;
  }, 450);
  return { haken, ausgeloest: () => n };
}

describe('useLongPress', () => {
  it('löst nach der Wartezeit aus, wenn der Finger liegen bleibt', () => {
    const { haken, ausgeloest } = aufbau();
    haken.onPointerDown(zeiger(100, 100) as never);
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(1);
  });

  it('bricht ab, sobald der Finger weiter als 12 Punkte wandert', () => {
    /*
     * Der Test, der gefehlt hat.
     *
     * Weil `origin` vor dem Aufräumen gesetzt wurde und `clear()` es sofort
     * wieder auf null stellte, fand `onPointerMove` nie einen Anfangspunkt –
     * die Prüfung stieg jedes Mal aus, und das Menü sprang mitten im
     * Scrollen auf. Von aussen sah alles unverändert aus.
     */
    const { haken, ausgeloest } = aufbau();
    haken.onPointerDown(zeiger(100, 100) as never);
    haken.onPointerMove(zeiger(100, 140) as never);
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(0);
  });

  it('lässt ein leichtes Zittern durchgehen', () => {
    // Ein Finger liegt nie ganz still. Wer bei drei Punkten abbricht, hat
    // ein langes Antippen, das auf einem echten Gerät nie auslöst.
    const { haken, ausgeloest } = aufbau();
    haken.onPointerDown(zeiger(100, 100) as never);
    haken.onPointerMove(zeiger(104, 103) as never);
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(1);
  });

  it('bricht beim Loslassen ab', () => {
    const { haken, ausgeloest } = aufbau();
    haken.onPointerDown(zeiger(100, 100) as never);
    haken.onPointerUp();
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(0);
  });

  it('reagiert nicht auf einen Druck, der einem Portal gehört', () => {
    // React reicht Ereignisse den REACT-Baum entlang weiter, nicht den DOM.
    // Ein Sheet, das über einer Nachricht liegt, schickt seine Drücke sonst
    // an genau diese Nachricht – und der Fotoeditor sprang mitten im
    // Pinselstrich ins Nachrichtenmenü.
    const { haken, ausgeloest } = aufbau();
    const fremd = { ...zeiger(100, 100), currentTarget: { contains: () => false } };
    haken.onPointerDown(fremd as never);
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(0);
  });

  it('geht bei der rechten Maustaste nicht an', () => {
    const { haken, ausgeloest } = aufbau();
    haken.onPointerDown({ ...zeiger(100, 100), button: 2 } as never);
    vi.advanceTimersByTime(500);
    expect(ausgeloest()).toBe(0);
  });

  it('löst beim Kontextmenü sofort aus, ohne zu warten', () => {
    const { haken, ausgeloest } = aufbau();
    let verhindert = false;
    haken.onContextMenu({
      preventDefault: () => {
        verhindert = true;
      },
    });
    expect(ausgeloest()).toBe(1);
    expect(verhindert).toBe(true);
  });
});
