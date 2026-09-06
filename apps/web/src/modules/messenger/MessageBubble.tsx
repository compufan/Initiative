import { useState, type ComponentType } from 'react';
import { messagePreview, type ConversationDto } from '@initiative/shared';
import { messageRenderers } from '../registry.js';
import type { MessageRendererProps } from '../types.js';
import { Avatar } from '../../components/Avatar.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { TextBubble } from './TextBubble.js';
import { formatTime, senderName } from './helpers.js';
import { useLongPress } from './useLongPress.js';
import { ConfirmDialog } from '../profile/ConfirmDialog.js';

let rendererCache: Record<string, ComponentType<MessageRendererProps>> | null = null;

/** Renderer lookup across all modules; unknown types fall back to plain text. */
function rendererFor(type: string): ComponentType<MessageRendererProps> {
  rendererCache ??= messageRenderers();
  return rendererCache[type] ?? TextBubble;
}

interface MessageBubbleProps {
  message: ChatMessage;
  conversation: ConversationDto | null;
  showSender: boolean;
  showAvatar: boolean;
  onOpenActions: (message: ChatMessage) => void;
  onJumpTo: (messageId: string) => void;
}

export function MessageBubble({
  message,
  conversation,
  showSender,
  showAvatar,
  onOpenActions,
  onJumpTo,
}: MessageBubbleProps) {
  const myId = useMyId();
  const isMine = message.senderId == null || message.senderId === myId;
  const Renderer = rendererFor(message.type);
  const longPress = useLongPress(() => onOpenActions(message));
  // Vor der frühen Rückkehr für Systemnachrichten: Ein Haken darf nicht
  // manchmal laufen und manchmal nicht.
  const [verwerfenFrage, setVerwerfenFrage] = useState(false);

  if (message.type === 'system') {
    return <Renderer message={message} conversation={conversation} isMine={isMine} />;
  }

  const isGroup = conversation?.type === 'group';
  const showName = showSender && isGroup && !isMine;

  async function retry() {
    if (!message.clientId) return;
    try {
      await useChat.getState().retryFailed(message.conversationId, message.clientId);
    } catch {
      toast('Erneutes Senden fehlgeschlagen', 'error');
    }
  }

  async function discard() {
    if (!message.clientId) return;
    try {
      await useChat.getState().discardFailed(message.conversationId, message.clientId);
      toast('Nachricht verworfen', 'success');
    } catch {
      toast('Verwerfen fehlgeschlagen', 'error');
    }
  }

  async function toggleReaction(emoji: string, mine: boolean) {
    try {
      await useChat.getState().toggleReaction(message, emoji, mine);
    } catch {
      toast('Reaktion konnte nicht gespeichert werden', 'error');
    }
  }

  return (
    <div
      className={`msg-row ${isMine ? 'msg-row-mine' : 'msg-row-theirs'}${showAvatar ? ' msg-row-start' : ''}`}
      data-message-id={message.id}
    >
      {!isMine && (
        <span className="msg-avatar-slot">
          {showAvatar && isGroup && (
            <Avatar
              name={senderName(conversation, message.senderId)}
              id={message.senderId ?? message.id}
              url={
                conversation?.members.find((member) => member.userId === message.senderId)?.user
                  .avatarUrl ?? null
              }
              size={30}
            />
          )}
        </span>
      )}

      <div className="msg-col" {...longPress}>
        {showName && (
          <span className="msg-sender">{senderName(conversation, message.senderId)}</span>
        )}

        {message.replyTo && (
          <button
            type="button"
            className="msg-quote"
            onClick={() => message.replyTo && onJumpTo(message.replyTo.id)}
          >
            <span className="msg-quote-name">
              {senderName(conversation, message.replyTo.senderId)}
            </span>
            <span className="msg-quote-text truncate">{messagePreview(message.replyTo)}</span>
          </button>
        )}

        <Renderer message={message} conversation={conversation} isMine={isMine} />

        <div className="msg-meta">
          {message.editedAt && <span>bearbeitet</span>}
          <span>{formatTime(message.createdAt)}</span>
          {isMine && message.pending && <span aria-label="wird gesendet">⏳</span>}
          {isMine && message.failed && (
            <>
              <button
                type="button"
                className="msg-retry"
                data-tipp="Schickt die Nachricht noch einmal – der Text bleibt erhalten"
                onClick={() => void retry()}
              >
                ⚠️ Erneut senden
              </button>
              {/*
                  Verwerfen fragt nach.

                  Ein Tipp löschte den Outbox-Eintrag sofort, und damit war der
                  getippte Text unwiederbringlich fort – bei einer Nachricht,
                  die man gerade deshalb noch sieht, weil sie NICHT abgeschickt
                  werden konnte. Der Knopf sass dabei sechs Pixel neben „Erneut
                  senden“, also genau da, wo man hin will. Für „Für alle
                  löschen“ gibt es diese Rückfrage längst.
              */}
              <button
                type="button"
                className="msg-retry msg-retry-verwerfen"
                data-tipp="Wirft die nicht gesendete Nachricht weg – der Text ist danach fort"
                onClick={() => setVerwerfenFrage(true)}
              >
                Verwerfen
              </button>
            </>
          )}
          {isMine && !message.pending && !message.failed && <span aria-label="gesendet">✓</span>}
        </div>

        {message.reactions.length > 0 && (
          <div className="msg-reactions">
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(myId);
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`msg-reaction ${mine ? 'msg-reaction-mine' : ''}`}
                  onClick={() => void toggleReaction(reaction.emoji, mine)}
                  /*
                   * Das Emoji ist `aria-hidden`, sichtbar bleibt nur eine
                   * Zahl. Eine Vorlesehilfe las hier also „3" und sonst
                   * nichts – und ein Sehender wusste nicht, dass ein Tipp
                   * die eigene Reaktion setzt oder zurücknimmt.
                   */
                  aria-label={
                    mine
                      ? `Deine Reaktion ${reaction.emoji} zurücknehmen (${reaction.userIds.length})`
                      : `Mit ${reaction.emoji} reagieren (${reaction.userIds.length})`
                  }
                  aria-pressed={mine}
                  data-tipp={
                    mine
                      ? 'Nimmt deine Reaktion wieder zurück'
                      : 'Du reagierst mit diesem Emoji – noch einmal tippen nimmt es zurück'
                  }
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span>{reaction.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        className="msg-more icon-btn"
        aria-label="Nachrichtenoptionen"
        onClick={() => onOpenActions(message)}
      >
        ⋯
      </button>

      {verwerfenFrage && (
        <ConfirmDialog
          open
          title="Nachricht verwerfen?"
          description="Der getippte Text ist danach fort. Sie wurde nie gesendet – niemand sonst hat sie gesehen."
          confirmLabel="Verwerfen"
          cancelLabel="Behalten"
          danger
          onCancel={() => setVerwerfenFrage(false)}
          onConfirm={() => {
            setVerwerfenFrage(false);
            void discard();
          }}
        />
      )}
    </div>
  );
}
