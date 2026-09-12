import { useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { Lightbox } from './Lightbox.js';
import { MediaCaption, PendingMedia } from './MediaFrame.js';
import { buildAttachment, mediaSrc, sendMedia } from './helpers.js';
import { rezeptSenden } from './RezeptBubble.js';
import { prepareImage } from '../../lib/upload.js';
import { toast } from '../../state/ui.js';
import { MAX_KANTE } from '../bild/doc.js';

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
    return (
      <PendingMedia emoji="📷" label="Foto wird gesendet …" message={message} isMine={isMine} />
    );
  }

  return (
    <div className="media-bubble">
      {images.length === 1 ? (
        <ImageTile attachment={images[0]} square={false} onOpen={() => setOpenIndex(0)} />
      ) : (
        <div
          className={images.length === 2 ? 'media-grid media-grid-2' : 'media-grid media-grid-3'}
        >
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
        <Lightbox
          items={images}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          zielName="In den Chat"
          alsRezept={async (original, rezept, name) => {
            /*
             * Das Original geht hinaus, wie es angekommen ist – hier steht
             * bewusst kein `prepareImage` mit einer eigenen Kante daneben:
             * `rezeptSenden` macht genau einen Lauf und schreibt die Masse,
             * die dabei herauskommen, ins Rezept.
             */
            const gesendet = await rezeptSenden(
              message.conversationId,
              original,
              rezept,
              name,
              images[0],
            );
            if (gesendet) {
              toast(
                'Liegt im Chat – mit dem Original und der Bearbeitung als Anweisung daneben.',
                'success',
              );
              setOpenIndex(null);
            }
          }}
          ablegen={async (blob, name) => {
            // Als neue Nachricht, nicht als Ersatz: Das Original bleibt im
            // Verlauf stehen, wo es steht.
            // `MAX_KANTE`, nicht 1920: Was der Editor ausgibt, geht in seiner
            // vollen Kante weiter. (Das Argument stand vorher auf 1920 und
            // wurde von `fertig` stillschweigend übergangen – jetzt gilt es,
            // also muss hier stehen, was wirklich gemeint ist.)
            const bild = await prepareImage(blob, MAX_KANTE, true);
            const gesendet = await sendMedia(message.conversationId, 'image', null, [
              buildAttachment({
                kind: 'image',
                mime: bild.mime,
                fileName: name,
                blob: bild.blob,
                width: bild.width,
                height: bild.height,
                previewDataUrl: bild.previewDataUrl,
              }),
            ]);
            /*
             * Bei Erfolg macht der Betrachter den Weg frei.
             *
             * Der Rückgabewert wurde nicht ausgewertet: Der Editor schloss
             * sich, der Vollbildbetrachter blieb aber mit dem UNBEARBEITETEN
             * Original offen. Wer gerade zugeschnitten hatte, sah sein altes
             * Bild und hielt das Senden für gescheitert – die neue Nachricht
             * lag die ganze Zeit dahinter im Chat.
             *
             * Ging es schief, bleibt der Betrachter stehen: Dort steht das
             * Bild noch, mit dem sich der zweite Versuch machen lässt.
             */
            /*
             * „Liegt im Chat", nicht „ist angekommen".
             *
             * `sendMedia` gibt true zurück, sobald die Nachricht in der Outbox
             * liegt und ein Sendeversuch angestossen wurde – ohne Netz ist das
             * genauso wahr wie mit. „Geschickt" wäre dort eine Behauptung über
             * etwas, das noch niemand bestätigt hat. Was wirklich zählt, steht
             * an der Blase selbst: Sanduhr, Haken oder Warnzeichen.
             */
            if (gesendet) {
              toast(
                'Liegt im Chat – der Haken an der Blase zeigt, wann es angekommen ist.',
                'success',
              );
              setOpenIndex(null);
            }
          }}
        />
      )}
    </div>
  );
}
