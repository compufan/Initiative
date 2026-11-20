import { useEffect, useState } from 'react';
import { messagePreview, ohneFormatierung, type ConversationDto, type MessageDto } from '@initiative/shared';
import { angeheftetLaden, useChatZusatz } from '../../state/angeheftet.js';
import { senderName } from './helpers.js';

const KEINE: MessageDto[] = [];

/**
 * Der Banner oben im Chat: die angehefteten Nachrichten, neueste zuerst.
 *
 * Ein Tipp springt zur gezeigten Nachricht und schaltet danach zur nächsten
 * weiter (wie bei WhatsApp/Telegram), so dass mehrere Tipps alle durchgehen.
 * Die Striche links zeigen, wie viele es sind und welche gerade dran ist.
 */
export function AngeheftetBanner({
  conversationId,
  conversation,
  onSprung,
}: {
  conversationId: string;
  conversation: ConversationDto | null;
  onSprung: (messageId: string) => void;
}) {
  const liste = useChatZusatz((state) => state.angeheftet[conversationId] ?? KEINE);
  const [stelle, setStelle] = useState(0);
  useEffect(() => {
    setStelle(0);
    void angeheftetLaden(conversationId);
  }, [conversationId]);
  if (liste.length === 0) return null;
  const aktuell = liste[Math.min(stelle, liste.length - 1)]!;
  const text = ohneFormatierung(messagePreview(aktuell));

  return (
    <div className="msg-angeheftet" role="region" aria-label="Angeheftete Nachrichten">
      <span className="msg-angeheftet-striche" aria-hidden="true">
        {liste.map((m, i) => (
          <span key={m.id} className={i === stelle ? 'is-aktiv' : undefined} />
        ))}
      </span>
      <button
        type="button"
        className="msg-angeheftet-inhalt"
        onClick={() => {
          onSprung(aktuell.id);
          setStelle((s) => (s + 1) % liste.length);
        }}
        aria-label={`Angeheftet ${stelle + 1} von ${liste.length}: ${text}. Antippen springt zur Nachricht.`}
      >
        <span className="msg-angeheftet-titel">
          📌 Angeheftet{liste.length > 1 ? ` · ${stelle + 1}/${liste.length}` : ''} ·{' '}
          {senderName(conversation, aktuell.senderId)}
        </span>
        <span className="msg-angeheftet-text truncate">{text}</span>
      </button>
    </div>
  );
}
