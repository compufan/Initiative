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
 *
 * Eine GELÖSCHTE Nachricht sieht von hier aus genauso aus – der Server gibt
 * `attachments: []` zurück und behält nur den Typ. Ohne die Abfrage unten
 * stünde über einem gelöschten Foto für immer „Foto wird gesendet …“ samt
 * drehendem Rädchen: eine Nachricht, die es nicht mehr gibt, sähe aus wie
 * eine, die gleich ankommt. Der Text ist derselbe wie in `TextBubble`, damit
 * eine gelöschte Nachricht überall gleich aussieht.
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
  if (message.deletedAt) {
    return (
      <div
        className={`msg-bubble ${isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs'} msg-bubble-deleted`}
      >
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

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
