import { useRef } from 'react';
import { formatBytes } from '@initiative/shared';
import { restzeitText } from '../../lib/stueckUpload.js';
import { useChat } from '../../state/chat.js';
import { useHochladen } from '../../state/hochladen.js';
import { toast } from '../../state/ui.js';
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
        {!failed && !message.dateiFehlt && <span className="spinner" aria-hidden="true" />}
      </div>
      {message.clientId && !failed && (
        <Hochladefortschritt
          clientId={message.clientId}
          conversationId={message.conversationId}
          dateiFehlt={message.dateiFehlt}
          isMine={isMine}
        />
      )}
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}

/**
 * Prozent, Restzeit und Abbrechen – nur bei Uploads in Stücken (grosse
 * Dateien); ein Foto ist zu schnell da, als dass eine Leiste lohnte.
 *
 * Dazu der ehrliche Satz, dass die App offen bleiben muss. Ein Browser lädt
 * nicht im Hintergrund weiter – auf iOS schon gar nicht: Wer die App
 * schliesst oder das Telefon sperrt, hält den Upload an. Er geht danach dort
 * weiter, wo er stand, aber er geht nicht von selbst.
 */
function Hochladefortschritt({
  clientId,
  conversationId,
  dateiFehlt,
  isMine,
}: {
  clientId: string;
  conversationId: string;
  dateiFehlt?: { index: number; name: string; groesse: number };
  isMine: boolean;
}) {
  const stand = useHochladen((s) => s.stand[clientId]);
  const auswahl = useRef<HTMLInputElement>(null);

  const abbrechen = () => void useChat.getState().uploadAbbrechen(conversationId, clientId);

  if (dateiFehlt) {
    return (
      <div className={surfaceClass('media-upload', isMine)}>
        <p className="media-upload-hinweis">
          Die App wurde neu gestartet. Wähle „{dateiFehlt.name}“ ({formatBytes(dateiFehlt.groesse)})
          noch einmal aus – der Upload geht dort weiter, wo er stand.
        </p>
        <div className="media-upload-knoepfe">
          <button type="button" className="btn btn-sm" onClick={() => auswahl.current?.click()}>
            Datei wählen
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={abbrechen}>
            Abbrechen
          </button>
        </div>
        <input
          ref={auswahl}
          type="file"
          hidden
          onChange={async (event) => {
            const datei = event.target.files?.[0];
            event.target.value = '';
            if (!datei) return;
            const ok = await useChat
              .getState()
              .dateiNachreichen(conversationId, clientId, dateiFehlt.index, datei);
            if (!ok) {
              toast(
                `Das ist nicht dieselbe Datei (${formatBytes(datei.size)} statt ${formatBytes(dateiFehlt.groesse)}).`,
                'error',
              );
            }
          }}
        />
      </div>
    );
  }

  if (!stand) return null;
  const prozent = stand.gesamt > 0 ? Math.floor((stand.geladen / stand.gesamt) * 100) : 0;
  return (
    <div className={surfaceClass('media-upload', isMine)}>
      <div
        className="media-upload-leiste"
        role="progressbar"
        aria-label="Hochladen"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={prozent}
      >
        <span style={{ width: `${prozent}%` }} />
      </div>
      <div className="media-upload-zeile">
        <span className="media-upload-text">
          {prozent} % · {formatBytes(stand.geladen)} von {formatBytes(stand.gesamt)}
          {stand.restSek != null ? ` · ${restzeitText(stand.restSek)}` : ''}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={abbrechen}>
          Abbrechen
        </button>
      </div>
      <p className="media-upload-hinweis">
        Bitte die App offen lassen – im Hintergrund lädt das Telefon nicht weiter. Bricht es ab,
        geht es beim nächsten Öffnen an derselben Stelle weiter.
      </p>
    </div>
  );
}
