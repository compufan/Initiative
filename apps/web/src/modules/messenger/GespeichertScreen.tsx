import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Screen } from '../../components/Screen.js';
import { messagePreview, type MessageDto } from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useSterne } from '../../state/sterne.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationTitle, formatListStamp, senderName } from './helpers.js';
import { FormatierterText } from './TextBubble.js';

/**
 * Gespeicherte Nachrichten („Sternchen“) über alle Chats.
 *
 * Der Server liefert nur, was man (noch) sehen darf: nicht gelöscht, nicht
 * für sich verborgen, nicht aus einem verlassenen Chat. Ein Tipp springt zum
 * Original im Chat (`?m=`).
 */
export function GespeichertScreen() {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  const sterne = useSterne((state) => state.ids);
  const [liste, setListe] = useState<MessageDto[] | null>(null);
  const [weiter, setWeiter] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async (before?: string) => {
    setLaeuft(true);
    try {
      const { items, nextCursor } = await api.messages.sterne(before);
      setListe((bisher) => (before ? [...(bisher ?? []), ...items] : items));
      setWeiter(nextCursor ?? null);
    } catch {
      toast('Gespeicherte Nachrichten liessen sich nicht laden', 'error');
      setListe((bisher) => bisher ?? []);
    } finally {
      setLaeuft(false);
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  // Auf einem anderen Gerät (oder im Chat) entfernt: hier auch weg.
  const sichtbar = (liste ?? []).filter((item) => sterne[item.id] || Object.keys(sterne).length === 0);

  async function entfernen(item: MessageDto) {
    try {
      await useChat.getState().toggleStern(item, false);
      setListe((bisher) => (bisher ?? []).filter((x) => x.id !== item.id));
    } catch {
      toast('Entfernen hat nicht geklappt', 'error');
    }
  }

  return (
    <Screen title="Gespeicherte Nachrichten" back>
      <div className="stack">
        {liste === null && <Spinner label="Wird geladen" />}
        {liste !== null && sichtbar.length === 0 && (
          <EmptyState
            emoji="⭐"
            title="Noch nichts gespeichert"
            description="Halte eine Nachricht gedrückt oder öffne ihr Menü und wähle „Speichern“ – sie erscheint dann hier."
          />
        )}
        <ul className="list">
          {sichtbar.map((item) => {
            const chat = conversations.find((c) => c.id === item.conversationId) ?? null;
            return (
              <li key={item.id} className="list-row gespeichert-zeile">
                <Link
                  className="gespeichert-link"
                  to={`/chats/${item.conversationId}?m=${item.id}`}
                  aria-label={`Im Chat zeigen: ${messagePreview(item)}`}
                >
                  <span className="gespeichert-kopf">
                    <strong className="truncate">
                      {item.senderId === myId ? 'Du' : senderName(chat, item.senderId)}
                    </strong>
                    <span className="faint">
                      {chat ? conversationTitle(chat, myId) : 'Chat'} ·{' '}
                      {formatListStamp(item.createdAt)}
                    </span>
                  </span>
                  <span className="gespeichert-text">
                    {item.type === 'text' && item.body ? (
                      <FormatierterText text={item.body} />
                    ) : (
                      messagePreview(item)
                    )}
                  </span>
                </Link>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Nicht mehr speichern"
                  title="Nicht mehr speichern"
                  onClick={() => void entfernen(item)}
                >
                  ☆
                </button>
              </li>
            );
          })}
        </ul>
        {weiter && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={laeuft}
            onClick={() => void laden(weiter)}
          >
            {laeuft ? 'Lädt …' : 'Ältere laden'}
          </button>
        )}
      </div>
    </Screen>
  );
}
