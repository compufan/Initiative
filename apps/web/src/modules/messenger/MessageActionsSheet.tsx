import { createElement, useMemo, useState } from 'react';
import { REACTION_EMOJIS, type ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { messageActions } from '../registry.js';
import { api } from '../../lib/api.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';

interface MessageActionsSheetProps {
  message: ChatMessage | null;
  conversation: ConversationDto | null;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
}

export function MessageActionsSheet({
  message,
  conversation,
  onClose,
  onReply,
}: MessageActionsSheetProps) {
  return (
    <Sheet open={message != null} onClose={onClose} title="Nachricht">
      {message && (
        <Actions
          key={message.id}
          message={message}
          conversation={conversation}
          onClose={onClose}
          onReply={onReply}
        />
      )}
    </Sheet>
  );
}

function Actions({
  message,
  conversation,
  onClose,
  onReply,
}: {
  message: ChatMessage;
  conversation: ConversationDto | null;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
}) {
  const myId = useMyId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const isMine = message.senderId == null || message.senderId === myId;
  const isLocal = Boolean(message.pending || message.failed);
  const canReply = !isLocal && !message.deletedAt;
  const canEdit = isMine && !isLocal && message.type === 'text' && !message.deletedAt;
  // Lokale Nachrichten haben den Server nie erreicht; sie werden nicht
  // geloescht, sondern aus der Outbox verworfen. Ohne das blieb ein
  // haengender Bild-Upload dauerhaft im Chat stehen.
  //
  // Die beiden Arten zu loeschen haben verschiedene Voraussetzungen, und das
  // ist der ganze Punkt: Den eigenen Verlauf darf jeder raeumen, auch von
  // fremden Nachrichten. Bei ANDEREN etwas verschwinden zu lassen, steht nur
  // dem zu, der es geschrieben hat.
  const kannFuerMich = !isLocal && !message.deletedAt;
  const canDelete = isMine;
  const canCopy = Boolean(message.body?.trim());

  // Was andere Bereiche der App an dieser Nachricht anbieten – etwa „Zur
  // Sammlung hinzufügen“. Der Messenger muss davon nichts wissen.
  const [offen, setOffen] = useState<string | null>(null);
  const weitere = useMemo(
    () =>
      isLocal ? [] : messageActions().filter((action) => action.applies(message, conversation)),
    [isLocal, message, conversation],
  );
  const offeneAktion = weitere.find((action) => action.key === offen);

  async function react(emoji: string) {
    const mine = message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.userIds.includes(myId),
    );
    try {
      await useChat.getState().toggleReaction(message, emoji, mine);
      onClose();
    } catch {
      toast('Reaktion konnte nicht gespeichert werden', 'error');
    }
  }

  async function copy() {
    const text = message.body ?? '';
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast('Text kopiert', 'success');
      onClose();
    } catch {
      toast('Kopieren wird von diesem Browser nicht unterstützt', 'error');
    }
  }

  async function saveEdit() {
    const body = draft.trim();
    if (body.length === 0 || body === message.body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await api.messages.edit(message.id, body);
      useChat.getState().applyMessage(updated);
      onClose();
    } catch {
      toast('Nachricht konnte nicht bearbeitet werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(scope: 'me' | 'all') {
    setBusy(true);
    try {
      if (isLocal && message.clientId) {
        await useChat.getState().discardFailed(message.conversationId, message.clientId);
      } else {
        await useChat.getState().deleteMessage(message, scope);
      }
      onClose();
    } catch {
      toast('Nachricht konnte nicht gelöscht werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="stack">
        <div className="field">
          <label htmlFor="msg-edit">Nachricht bearbeiten</label>
          <textarea
            id="msg-edit"
            className="textarea"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={busy || draft.trim().length === 0}
            onClick={() => void saveEdit()}
          >
            Speichern
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="msg-reaction-picker">
        {REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="msg-reaction-choice"
            aria-label={`Mit ${emoji} reagieren`}
            onClick={() => void react(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="list msg-action-list">
        {canReply && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onReply(message);
              onClose();
            }}
          >
            <span aria-hidden="true">↩️</span>
            <span>Antworten</span>
          </button>
        )}
        {canCopy && (
          <button type="button" className="list-row" onClick={() => void copy()}>
            <span aria-hidden="true">📋</span>
            <span>Kopieren</span>
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              setDraft(message.body ?? '');
              setEditing(true);
            }}
          >
            <span aria-hidden="true">✏️</span>
            <span>Bearbeiten</span>
          </button>
        )}
        {weitere.map((action) => (
          <button
            key={action.key}
            type="button"
            className="list-row"
            onClick={() => setOffen(action.key)}
          >
            <span aria-hidden="true">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
        {/*
          Zwei Arten zu löschen, und sie bedeuten etwas ganz Verschiedenes.

          „Nur für mich“ räumt den eigenen Verlauf – ein Foto, das man nicht
          ständig sehen will. Bei allen anderen bleibt alles, wie es war, und
          deshalb geht das auch mit fremden Nachrichten.

          „Für alle“ nimmt sie überall zurück und ist deshalb auf eigene
          Nachrichten beschränkt (Gruppenverwalter dürfen mehr). Fremde Worte
          aus einem fremden Verlauf zu entfernen, steht niemandem zu.

          Der Sicherheitsschritt hängt nur an „für alle“: Nur dort ist das
          Löschen nicht mehr rückgängig zu machen.
        */}
        {kannFuerMich && (
          <button
            type="button"
            className="list-row"
            disabled={busy}
            onClick={() => void remove('me')}
          >
            <span aria-hidden="true">🙈</span>
            <span>
              Nur für mich löschen
              <small className="msg-action-hint">Die anderen sehen sie weiterhin</small>
            </span>
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="list-row msg-action-danger"
            disabled={busy}
            onClick={() =>
              isLocal
                ? void remove('all')
                : confirmDelete
                  ? void remove('all')
                  : setConfirmDelete(true)
            }
          >
            <span aria-hidden="true">🗑️</span>
            <span>
              {isLocal ? (
                'Verwerfen'
              ) : confirmDelete ? (
                'Wirklich für alle löschen?'
              ) : (
                <>
                  Für alle löschen
                  <small className="msg-action-hint">Verschwindet bei allen im Chat</small>
                </>
              )}
            </span>
          </button>
        )}
      </div>

      {offeneAktion &&
        createElement(offeneAktion.render, {
          message,
          conversation,
          onClose: () => {
            setOffen(null);
            onClose();
          },
        })}
    </div>
  );
}
