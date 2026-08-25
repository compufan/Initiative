import { useCallback, useEffect, useRef, useState, type TouchEvent, type TouchList } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentDto } from '@initiative/shared';
import { FotoWerkstatt } from './FotoWerkstatt.js';
import { mediaSrc } from './helpers.js';

interface LightboxProps {
  items: AttachmentDto[];
  index: number;
  onClose: () => void;
  /**
   * Wohin eine bearbeitete Fassung gehört. Ohne das bleibt vom Bearbeiten nur
   * das Speichern aufs Telefon.
   */
  ablegen?: (blob: Blob, name: string) => Promise<void>;
  zielName?: string;
}

type GestureMode = 'none' | 'pan' | 'pinch' | 'dismiss';

interface GestureState {
  mode: GestureMode;
  startDistance: number;
  startScale: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
}

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DISMISS_DISTANCE = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * Full screen photo viewer: pinch and double tap to zoom, drag to pan, swipe
 * down to close. `touch-action: none` keeps Safari from hijacking the gesture.
 */
export function Lightbox({ items, index, onClose, ablegen, zielName }: LightboxProps) {
  const [current, setCurrent] = useState(index);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dismissY, setDismissY] = useState(0);
  /**
   * Solange Editor oder Studio offen sind, hört der Betrachter auf, Tasten zu
   * deuten – sonst schlösse Escape beides auf einmal und die Pfeiltasten
   * blätterten hinter dem Editor weiter.
   */
  const [werkstattOffen, setWerkstattOffen] = useState(false);
  const gesture = useRef<GestureState>({
    mode: 'none',
    startDistance: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
  });
  const moved = useRef(false);
  const lastTap = useRef(0);
  const item = items[current];

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setDismissY(0);
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      setCurrent((value) => (value + delta + items.length) % items.length);
      reset();
    },
    [items.length, reset],
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (werkstattOffen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go, onClose, werkstattOffen]);

  const toggleZoom = useCallback(() => {
    setScale((value) => (value > 1 ? 1 : DOUBLE_TAP_SCALE));
    setOffset({ x: 0, y: 0 });
  }, []);

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    moved.current = false;
    if (event.touches.length >= 2) {
      gesture.current = {
        mode: 'pinch',
        startDistance: distanceBetween(event.touches),
        startScale: scale,
        startX: 0,
        startY: 0,
        startOffsetX: offset.x,
        startOffsetY: offset.y,
      };
      return;
    }
    const touch = event.touches[0];
    gesture.current = {
      mode: scale > 1 ? 'pan' : 'dismiss',
      startDistance: 0,
      startScale: scale,
      startX: touch.clientX,
      startY: touch.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
    };
  };

  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (state.mode === 'pinch' && event.touches.length >= 2) {
      const factor = distanceBetween(event.touches) / (state.startDistance || 1);
      const next = clamp(state.startScale * factor, 1, MAX_SCALE);
      moved.current = true;
      setScale(next);
      if (next <= 1.01) setOffset({ x: 0, y: 0 });
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - state.startX;
    const dy = touch.clientY - state.startY;
    if (Math.hypot(dx, dy) > 8) moved.current = true;
    if (state.mode === 'pan') {
      setOffset({ x: state.startOffsetX + dx, y: state.startOffsetY + dy });
    } else if (state.mode === 'dismiss') {
      setDismissY(Math.max(0, dy));
    }
  };

  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length > 0) return;
    const state = gesture.current;
    gesture.current = { ...state, mode: 'none' };
    if (state.mode === 'dismiss' && dismissY > DISMISS_DISTANCE) {
      onClose();
      return;
    }
    setDismissY(0);
    if (!moved.current) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        toggleZoom();
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
    }
  };

  if (!item) return null;

  const fadeOut = Math.min(dismissY / 400, 0.7);

  return createPortal(
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label="Foto">
      <div className="media-lightbox-bar" style={{ opacity: 1 - fadeOut }}>
        <button type="button" className="media-round-btn" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
        {items.length > 1 && (
          <span className="media-lightbox-count">
            {current + 1} / {items.length}
          </span>
        )}
        <div className="media-lightbox-tools">
          <FotoWerkstatt
            foto={item}
            ablegen={ablegen}
            zielName={zielName}
            onOffen={setWerkstattOffen}
          />
          <a
            className="media-round-btn"
            href={mediaSrc(item)}
            download={item.fileName ?? 'foto'}
            target="_blank"
            rel="noreferrer"
            aria-label="Herunterladen"
          >
            ⬇
          </a>
        </div>
      </div>

      <div
        className="media-zoom"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onDoubleClick={toggleZoom}
      >
        <img
          src={mediaSrc(item)}
          alt={item.fileName ?? 'Foto'}
          className="media-zoom-image"
          draggable={false}
          style={{
            transform: `translate3d(${offset.x}px, ${offset.y + dismissY}px, 0) scale(${scale})`,
            opacity: 1 - fadeOut,
            transition: gesture.current.mode === 'none' ? 'transform 160ms ease-out' : 'none',
          }}
        />
      </div>

      {items.length > 1 && (
        <div className="media-lightbox-nav">
          <button
            type="button"
            className="media-round-btn"
            onClick={() => go(-1)}
            aria-label="Vorheriges Foto"
          >
            ‹
          </button>
          <button
            type="button"
            className="media-round-btn"
            onClick={() => go(1)}
            aria-label="Nächstes Foto"
          >
            ›
          </button>
        </div>
      )}
      <p className="media-lightbox-hint">
        Nach unten wischen zum Schließen · Doppeltippen zum Zoomen
      </p>
    </div>,
    document.body,
  );
}
