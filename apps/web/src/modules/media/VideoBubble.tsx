import { useRef } from 'react';
import { formatDuration } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia } from './MediaFrame.js';
import { claimPlayback, mediaSrc, releasePlayback, standbildHolen } from './helpers.js';

/**
 * Video bubble – unscharfe Vorschau als Untergrund, darauf ein echtes Standbild.
 *
 * Kein `poster`: Das Plakat bliebe stehen, bis jemand abspielt, und es IST die
 * unscharfe Vorschau. Statt dessen liegt dieselbe Vorschau als `media-blur`
 * HINTER dem Video – sie füllt den Rahmen sofort und ohne schwarzes Aufblitzen –
 * und `standbildHolen` holt darüber das erste echte Bild.
 */
export function VideoBubble({ message, isMine }: MessageRendererProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachment = message.attachments.find((item) => item.kind === 'video');

  if (!attachment) {
    return (
      <PendingMedia emoji="🎬" label="Video wird gesendet …" message={message} isMine={isMine} />
    );
  }

  const ratio =
    attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : '16 / 9';

  return (
    <div className="media-bubble">
      <div className="media-frame" style={{ aspectRatio: ratio }}>
        {attachment.previewDataUrl && (
          <img className="media-blur" src={attachment.previewDataUrl} alt="" aria-hidden="true" />
        )}
        <video
          ref={videoRef}
          className="media-video"
          src={mediaSrc(attachment)}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(ereignis) => standbildHolen(ereignis.currentTarget)}
          onPlay={() => {
            if (videoRef.current) claimPlayback(videoRef.current);
          }}
          onPause={() => {
            if (videoRef.current) releasePlayback(videoRef.current);
          }}
        />
        {attachment.durationMs != null && attachment.durationMs > 0 && (
          <span className="media-badge">{formatDuration(attachment.durationMs)}</span>
        )}
      </div>
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}
