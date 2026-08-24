import { useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { Lightbox } from './Lightbox.js';
import { MediaCaption, PendingMedia } from './MediaFrame.js';
import { mediaSrc } from './helpers.js';

function ImageTile({
  attachment,
  square,
  onOpen,
}: {
  attachment: AttachmentDto;
  square: boolean;
  onOpen: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const ratio =
    attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '4 / 3';

  return (
    <button
      type="button"
      className="media-frame"
      style={{ aspectRatio: square ? '1 / 1' : ratio }}
      onClick={onOpen}
      aria-label="Foto öffnen"
    >
      {attachment.previewDataUrl && (
        <img className="media-blur" src={attachment.previewDataUrl} alt="" aria-hidden="true" />
      )}
      {broken ? (
        <span className="media-frame-note">Bild nicht verfügbar</span>
      ) : (
        <img
          className={loaded ? 'media-image is-loaded' : 'media-image'}
          src={mediaSrc(attachment)}
          alt={attachment.fileName ?? 'Foto'}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
      )}
    </button>
  );
}

/** Photo bubble – instant blurred preview, no layout jump, tap to enlarge. */
export function ImageBubble({ message, isMine }: MessageRendererProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const images = message.attachments.filter((attachment) => attachment.kind === 'image');

  if (images.length === 0) {
    return <PendingMedia emoji="📷" label="Foto wird gesendet …" message={message} isMine={isMine} />;
  }

  return (
    <div className="media-bubble">
      {images.length === 1 ? (
        <ImageTile attachment={images[0]} square={false} onOpen={() => setOpenIndex(0)} />
      ) : (
        <div className={images.length === 2 ? 'media-grid media-grid-2' : 'media-grid media-grid-3'}>
          {images.map((attachment, index) => (
            <ImageTile
              key={attachment.id}
              attachment={attachment}
              square
              onOpen={() => setOpenIndex(index)}
            />
          ))}
        </div>
      )}
      <MediaCaption body={message.body} isMine={isMine} />
      {openIndex !== null && (
        <Lightbox items={images} index={openIndex} onClose={() => setOpenIndex(null)} />
      )}
    </div>
  );
}
