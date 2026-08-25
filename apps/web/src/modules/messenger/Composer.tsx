import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { messagePreview, type ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { composerActions } from '../registry.js';
import type { ComposerAction } from '../types.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import { senderName } from './helpers.js';

const TYPING_THROTTLE_MS = 2500;
const TYPING_IDLE_MS = 3000;
const MAX_ROWS = 6;

interface ComposerProps {
  conversationId: string;
  conversation: ConversationDto | null;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  onScrollToBottom: () => void;
}

export function Composer({
  conversationId,
  conversation,
  replyTo,
  onCancelReply,
  onScrollToBottom,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ComposerAction | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);
  const idleTimer = useRef<number | null>(null);

  const actions = useMemo(() => composerActions(), []);
  // Aktionen mit eigenem Knopf stehen zusätzlich in der Eingabezeile – im
  // Menü bleiben sie trotzdem, damit es genau einen vollständigen Ort gibt.
  const pinned = useMemo(() => actions.filter((action) => action.pinned), [actions]);
  const canSend = text.trim().length > 0;

  const stopTyping = () => {
    if (idleTimer.current != null) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (lastTypingAt.current !== 0) {
      lastTypingAt.current = 0;
      useChat.getState().setTyping(conversationId, false);
    }
  };

  // Leaving the chat (or switching to another one) must not leave a stale
  // "tippt …" indicator behind for everybody else.
  useEffect(() => stopTyping, [conversationId]);

  useEffect(() => {
    setText('');
    resize();
  }, [conversationId]);

  function resize() {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight) || 22;
    const padding = element.offsetHeight - element.clientHeight + 16;
    const max = lineHeight * MAX_ROWS + padding;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
  }

  function handleChange(value: string) {
    setText(value);
    resize();
    if (value.trim().length === 0) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTypingAt.current > TYPING_THROTTLE_MS) {
      lastTypingAt.current = now;
      useChat.getState().setTyping(conversationId, true);
    }
    if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  async function send() {
    const body = text.trim();
    if (body.length === 0) return;
    const replyToId = replyTo?.id ?? null;
    setText('');
    stopTyping();
    onCancelReply();
    window.requestAnimationFrame(resize);
    try {
      await useChat.getState().sendMessage(conversationId, { type: 'text', body, replyToId });
      onScrollToBottom();
    } catch {
      toast('Nachricht konnte nicht gesendet werden', 'error');
      setText(body);
      window.requestAnimationFrame(resize);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Physical keyboards send with Enter; on touch devices Enter stays a newline.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    void send();
  }

  const ActiveActionView = activeAction?.render;

  return (
    <div className="msg-composer">
      {replyTo && (
        <div className="msg-composer-reply">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="msg-quote-name">{senderName(conversation, replyTo.senderId)}</div>
            <div className="msg-quote-text truncate">{messagePreview(replyTo)}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Antwort verwerfen"
            onClick={onCancelReply}
          >
            ✕
          </button>
        </div>
      )}

      <div className="msg-composer-row">
        {/* „Anhang hinzufügen“ stand hier und war schlicht falsch: Hinter dem
            Knopf liegen auch Sticker, Termin, Umfrage und Spiel. */}
        {actions.length > 0 && (
          <button
            type="button"
            className="icon-btn msg-composer-plus"
            aria-label="Mehr hinzufügen"
            onClick={() => setActionsOpen(true)}
          >
            ＋
          </button>
        )}
        {/* Aktionen, die sich einen eigenen Platz gewünscht haben. */}
        {pinned.map((action) => (
          <button
            key={action.key}
            type="button"
            className="icon-btn msg-composer-pinned"
            aria-label={action.label}
            title={action.label}
            onClick={() => setActiveAction(action)}
          >
            <span aria-hidden="true">{action.icon}</span>
          </button>
        ))}
        <textarea
          ref={textareaRef}
          className="msg-composer-input"
          rows={1}
          placeholder="Nachricht schreiben"
          value={text}
          enterKeyHint="enter"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onScrollToBottom}
        />
        <button
          type="button"
          className="msg-send"
          aria-label="Senden"
          disabled={!canSend}
          onClick={() => void send()}
        >
          ➤
        </button>
      </div>

      <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)} title="Hinzufügen">
        <div className="msg-action-grid">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="msg-action-tile"
              onClick={() => {
                setActionsOpen(false);
                setActiveAction(action);
              }}
            >
              <span className="msg-action-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </Sheet>

      {ActiveActionView && (
        <ActiveActionView
          key={activeAction?.key}
          conversationId={conversationId}
          onClose={() => setActiveAction(null)}
        />
      )}
    </div>
  );
}
