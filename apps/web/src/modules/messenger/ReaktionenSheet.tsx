import { useState } from 'react';
import type { ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { senderName } from './helpers.js';

/**
 * „Wer hat reagiert“ – mit Filter je Emoji. Die eigene Reaktion lässt sich
 * hier entfernen.
 */
export function ReaktionenSheet({
  message,
  conversation,
  onClose,
}: {
  message: ChatMessage | null;
  conversation: ConversationDto | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={message != null} onClose={onClose} title="Reaktionen">
      {message && <Liste message={message} conversation={conversation} onClose={onClose} />}
    </Sheet>
  );
}

function Liste({
  message,
  conversation,
  onClose,
}: {
  message: ChatMessage;
  conversation: ConversationDto | null;
  onClose: () => void;
}) {
  const myId = useMyId();
  // Die Reaktionen live aus dem Speicher, nicht vom Öffnen: Entfernt man die
  // eigene, verschwindet sie hier sofort.
  const reaktionen = useChat(
    (state) =>
      state.messages[message.conversationId]?.find((item) => item.id === message.id)?.reactions ??
      message.reactions,
  );
  const [filter, setFilter] = useState<string | null>(null);
  const gesamt = reaktionen.reduce((summe, r) => summe + r.userIds.length, 0);
  const zeilen = reaktionen
    .filter((r) => filter === null || r.emoji === filter)
    .flatMap((r) => r.userIds.map((userId) => ({ emoji: r.emoji, userId })));

  async function entfernen(emoji: string) {
    try {
      await useChat.getState().toggleReaction(message, emoji, true);
      if (reaktionen.reduce((s, r) => s + r.userIds.length, 0) <= 1) onClose();
    } catch {
      toast('Reaktion konnte nicht entfernt werden', 'error');
    }
  }

  if (gesamt === 0) return <p className="muted">Keine Reaktionen.</p>;

  return (
    <div className="stack">
      <div className="reaktion-filter" role="tablist" aria-label="Nach Emoji filtern">
        <button
          type="button"
          role="tab"
          aria-selected={filter === null}
          className={`chip ${filter === null ? 'is-aktiv' : ''}`}
          onClick={() => setFilter(null)}
        >
          Alle {gesamt}
        </button>
        {reaktionen.map((r) => (
          <button
            key={r.emoji}
            type="button"
            role="tab"
            aria-selected={filter === r.emoji}
            aria-label={`${r.emoji} ${r.userIds.length}`}
            className={`chip ${filter === r.emoji ? 'is-aktiv' : ''}`}
            onClick={() => setFilter(r.emoji)}
          >
            {r.emoji} {r.userIds.length}
          </button>
        ))}
      </div>
      <ul className="list">
        {zeilen.map(({ emoji, userId }) => {
          const ich = userId === myId;
          return (
            <li key={`${emoji}-${userId}`} className="list-row reaktion-zeile">
              <span aria-hidden="true" className="reaktion-emoji">
                {emoji}
              </span>
              <span className="truncate" style={{ flex: 1 }}>
                {ich ? 'Du' : senderName(conversation, userId)}
              </span>
              {ich && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void entfernen(emoji)}
                  aria-label={`Deine Reaktion ${emoji} entfernen`}
                >
                  Entfernen
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
