import { useRef } from 'react';
import { formatDuration } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia } from './MediaFrame.js';
import { claimPlayback, mediaSrc, releasePlayback } from './helpers.js';

/** Video bubble – poster from the inline preview, metadata only until played. */
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
        <video
          ref={videoRef}
          className="media-video"
          src={mediaSrc(attachment)}
          poster={attachment.previewDataUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
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
