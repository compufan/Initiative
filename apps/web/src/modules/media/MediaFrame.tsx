import type { MessageRendererProps } from '../types.js';

type RenderedMessage = MessageRendererProps['message'];

/** Chat bubble surface (tinted like the messenger bubbles) for non-image parts. */
export function surfaceClass(base: string, isMine: boolean): string {
  return isMine ? `${base} media-surface is-mine` : `${base} media-surface`;
}

/** Caption below a photo, video, voice message or file. */
export function MediaCaption({ body, isMine }: { body: string | null; isMine: boolean }) {
  if (!body || body.trim().length === 0) return null;
  return <p className={surfaceClass('media-caption', isMine)}>{body}</p>;
}

/**
 * Shown while a message still sits in the outbox: the attachment only exists as
 * a blob in IndexedDB at that point, so there is nothing to render yet.
 */
export function PendingMedia({
  emoji,
  label,
  message,
  isMine,
}: {
  emoji: string;
  label: string;
  message: RenderedMessage;
  isMine: boolean;
}) {
  const failed = message.failed === true;
  return (
    <div className="media-bubble">
      <div className={surfaceClass('media-placeholder', isMine)}>
        <span aria-hidden="true" className="media-placeholder-emoji">
          {emoji}
        </span>
        <span className="media-placeholder-label">{failed ? 'Senden fehlgeschlagen' : label}</span>
        {!failed && <span className="spinner" aria-hidden="true" />}
      </div>
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}
