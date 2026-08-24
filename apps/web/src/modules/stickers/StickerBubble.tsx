import { useState } from 'react';
import type { MessageRendererProps } from '../types.js';
import { stickerSrc } from './helpers.js';

/**
 * Sticker bubble – 128 px, no bubble background. A sticker whose pack was
 * deleted in the meantime leaves a discreet hint instead of a broken image.
 */
export function StickerBubble({ message }: MessageRendererProps) {
  const [broken, setBroken] = useState(false);
  const sticker = message.sticker;

  if (!sticker) {
    if (message.pending) {
      return (
        <div className="stk-bubble stk-bubble-pending">
          <span className="spinner" aria-hidden="true" />
          <span>Sticker wird gesendet …</span>
        </div>
      );
    }
    return <div className="stk-bubble-missing">Dieser Sticker ist nicht mehr verfügbar</div>;
  }

  if (broken) {
    return <div className="stk-bubble-missing">Dieser Sticker ist nicht mehr verfügbar</div>;
  }

  return (
    <div className="stk-bubble">
      <img
        className="stk-bubble-image"
        src={stickerSrc(sticker.url)}
        alt={sticker.emoji ? `Sticker ${sticker.emoji}` : `Sticker aus ${sticker.packName}`}
        width={128}
        height={128}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
      />
    </div>
  );
}
