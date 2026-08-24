import { formatBytes } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia, surfaceClass } from './MediaFrame.js';
import { fileIconFor, mediaSrc } from './helpers.js';

/** File bubble – icon by mime type, name, size and a download link. */
export function FileBubble({ message, isMine }: MessageRendererProps) {
  const attachment =
    message.attachments.find((item) => item.kind === 'file') ?? message.attachments[0];

  if (!attachment) {
    return (
      <PendingMedia emoji="📎" label="Datei wird gesendet …" message={message} isMine={isMine} />
    );
  }

  const name = attachment.fileName ?? 'Datei';

  return (
    <div className="media-bubble">
      <a
        className={surfaceClass('media-file', isMine)}
        href={mediaSrc(attachment)}
        download={name}
        target="_blank"
        rel="noreferrer"
      >
        <span className="media-file-icon" aria-hidden="true">
          {fileIconFor(attachment.mime, attachment.fileName)}
        </span>
        <span className="media-file-text">
          <span className="media-file-name truncate">{name}</span>
          <span className="media-file-meta">{formatBytes(attachment.size)} · Herunterladen</span>
        </span>
        <span className="media-file-arrow" aria-hidden="true">
          ⬇
        </span>
      </a>
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}
