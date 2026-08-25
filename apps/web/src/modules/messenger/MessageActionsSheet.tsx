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

  async function remove() {
    setBusy(true);
    try {
      if (isLocal && message.clientId) {
        await useChat.getState().discardFailed(message.conversationId, message.clientId);
      } else {
        await useChat.getState().deleteMessage(message);
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
        {canDelete && (
          <button
            type="button"
            className="list-row msg-action-danger"
            disabled={busy}
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
          >
            <span aria-hidden="true">🗑️</span>
            <span>
              {confirmDelete ? 'Wirklich?' : isLocal ? 'Verwerfen' : 'Löschen'}
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
