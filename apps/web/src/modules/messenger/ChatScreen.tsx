import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast, useHideNav } from '../../state/ui.js';
import { ChatInfoSheet } from './ChatInfoSheet.js';
import { Composer } from './Composer.js';
import { MessageActionsSheet } from './MessageActionsSheet.js';
import { MessageBubble } from './MessageBubble.js';
import {
  conversationAvatar,
  conversationTitle,
  counterpartOf,
  dayKey,
  formatDayLabel,
  formatLastSeen,
  isGrouped,
  memberCountLabel,
  memberName,
  typingLabel,
} from './helpers.js';

const NO_MESSAGES: ChatMessage[] = [];
const NO_TYPING: { userId: string; until: number }[] = [];

type RenderItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | {
      kind: 'message';
      key: string;
      message: ChatMessage;
      showSender: boolean;
      showAvatar: boolean;
    };

/** Keeps the composer above the on-screen keyboard on iOS (100dvh stays put). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(overlap > 60 ? Math.round(overlap) : 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

export function ChatScreen() {
  useHideNav();
  const navigate = useNavigate();
  const myId = useMyId();
  const params = useParams();
  const conversationId = params.conversationId ?? '';
  const keyboardInset = useKeyboardInset();

  const conversation = useChat(
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null,
  );
  const messages = useChat((state) => state.messages[conversationId] ?? NO_MESSAGES);
  const loading = useChat((state) => state.loading[conversationId] ?? false);
  const hasMore = useChat((state) => state.hasMore[conversationId] ?? false);
  const typingEntries = useChat((state) => state.typing[conversationId] ?? NO_TYPING);
  const presence = useChat((state) => state.presence);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const didInitialScroll = useRef(false);
  const unreadAnchor = useRef<{
    conversationId: string;
    enabled: boolean;
    lastReadId: string | null;
  }>({
    conversationId: '',
    enabled: false,
    lastReadId: null,
  });

  const [showJump, setShowJump] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (!conversationId) return;
    didInitialScroll.current = false;
    atBottom.current = true;
    restore.current = null;
    setShowJump(false);
    setReplyTo(null);
    setActionsFor(null);
    setInfoOpen(false);
    void useChat.getState().ensureConversation(conversationId);
    useChat
      .getState()
      .loadMessages(conversationId)
      .catch(() => toast('Nachrichten konnten nicht geladen werden', 'error'));
  }, [conversationId]);

  // Freeze the read marker when the chat opens so the divider does not jump
  // away the moment the messages are marked as read.
  if (conversation && unreadAnchor.current.conversationId !== conversationId) {
    const me = conversation.members.find((member) => member.userId === myId);
    unreadAnchor.current = {
      conversationId,
      enabled: conversation.unreadCount > 0,
      lastReadId: me?.lastReadMessageId ?? null,
    };
  }

  const items = useMemo<RenderItem[]>(() => {
    const out: RenderItem[] = [];
    const anchor = unreadAnchor.current;
    let previous: ChatMessage | undefined;
    let dividerPlaced = false;

    for (const message of messages) {
      let breakGroup = false;
      if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
        out.push({
          kind: 'day',
          key: `day-${dayKey(message.createdAt)}`,
          label: formatDayLabel(message.createdAt),
        });
        breakGroup = true;
      }
      const isTheirs = message.senderId != null && message.senderId !== myId;
      const afterRead = anchor.lastReadId == null || message.id > anchor.lastReadId;
      if (anchor.enabled && !dividerPlaced && isTheirs && afterRead) {
        out.push({ kind: 'unread', key: 'unread-divider' });
        dividerPlaced = true;
        breakGroup = true;
      }
      const grouped = !breakGroup && isGrouped(previous, message);
      out.push({
        kind: 'message',
        key: message.id,
        message,
        showSender: !grouped,
        showAvatar: !grouped,
      });
      previous = message;
    }
    return out;
  }, [messages, myId, conversationId, conversation]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (restore.current) {
      const { height, top } = restore.current;
      restore.current = null;
      element.scrollTop = element.scrollHeight - height + top;
      return;
    }
    if (!didInitialScroll.current) {
      if (messages.length === 0) return;
      didInitialScroll.current = true;
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [items, messages.length, loading]);

  // Late-loading media must not push the newest message out of sight.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId]);

  useEffect(() => {
    if (messages.length > 0 && atBottom.current) useChat.getState().markRead(conversationId);
  }, [messages, conversationId]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const bottom = distance < 80;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      setShowJump(!bottom);
      if (bottom) useChat.getState().markRead(conversationId);
    }
    if (element.scrollTop < 260 && hasMore && !loading && !restore.current) {
      restore.current = { height: element.scrollHeight, top: element.scrollTop };
      void useChat.getState().loadOlder(conversationId);
    }
  }

  function scrollToBottom(smooth = false) {
    const element = scrollRef.current;
    if (!element) return;
    atBottom.current = true;
    setShowJump(false);
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function jumpTo(messageId: string) {
    const selector =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? `[data-message-id="${CSS.escape(messageId)}"]`
        : `[data-message-id="${messageId}"]`;
    const target = scrollRef.current?.querySelector(selector);
    if (!target) {
      toast('Die Nachricht ist noch nicht geladen', 'info');
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('msg-row-flash');
    window.setTimeout(() => target.classList.remove('msg-row-flash'), 1400);
  }

  const avatar = conversation ? conversationAvatar(conversation, myId) : null;
  const counterpart = conversation ? counterpartOf(conversation, myId) : null;
  const online = counterpart ? (presence[counterpart.userId]?.online ?? false) : false;
  const typingNames = typingEntries
    .filter((entry) => entry.userId !== myId)
    .map((entry) => {
      const member = conversation?.members.find((item) => item.userId === entry.userId);
      return member ? memberName(member) : 'Jemand';
    });

  let status = 'Chat wird geladen …';
  if (typingNames.length > 0) {
    status = typingLabel(typingNames);
  } else if (conversation?.type === 'group') {
    status = memberCountLabel(conversation);
  } else if (counterpart) {
    status = online
      ? 'online'
      : formatLastSeen(presence[counterpart.userId]?.lastSeenAt ?? counterpart.user.lastSeenAt);
  }

  return (
    <div className="app-main msg-screen" style={{ paddingBottom: keyboardInset }}>
      <header className="app-header msg-header">
        <button
          type="button"
          className="icon-btn"
          aria-label="Zurück zu den Chats"
          onClick={() => navigate('/chats')}
        >
          ‹
        </button>
        <button
          type="button"
          className="msg-header-main"
          onClick={() => setInfoOpen(true)}
          aria-label="Chat-Info öffnen"
        >
          {avatar ? (
            <Avatar
              name={avatar.name}
              id={avatar.id}
              url={avatar.url}
              size={38}
              online={conversation?.type === 'direct' ? online : undefined}
            />
          ) : (
            <span className="skeleton" style={{ width: 38, height: 38, borderRadius: '50%' }} />
          )}
          <span style={{ minWidth: 0 }}>
            <span className="msg-header-title truncate">
              {conversation ? conversationTitle(conversation, myId) : 'Chat'}
            </span>
            <span
              className={`msg-header-status truncate ${typingNames.length > 0 ? 'is-typing' : ''}`}
            >
              {status}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Chat-Info"
          onClick={() => setInfoOpen(true)}
        >
          ⋮
        </button>
      </header>

      <div className="msg-body">
        <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="msg-content" ref={contentRef}>
            {hasMore && (
              <div className="msg-loader">
                {loading ? <Spinner label="Ältere Nachrichten" /> : '…'}
              </div>
            )}

            {messages.length === 0 && loading && (
              <div className="msg-loader">
                <Spinner label="Nachrichten werden geladen" />
              </div>
            )}

            {messages.length === 0 && !loading && (
              <EmptyState
                emoji="👋"
                title="Noch keine Nachrichten"
                description="Schreib die erste Nachricht – sie landet sofort bei allen Mitgliedern."
              />
            )}

            {items.map((item) => {
              if (item.kind === 'day') {
                return (
                  <div key={item.key} className="msg-day">
                    <span>{item.label}</span>
                  </div>
                );
              }
              if (item.kind === 'unread') {
                return (
                  <div key={item.key} className="msg-unread">
                    <span>Neue Nachrichten</span>
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={item.key}
                  message={item.message}
                  conversation={conversation}
                  showSender={item.showSender}
                  showAvatar={item.showAvatar}
                  onOpenActions={setActionsFor}
                  onJumpTo={jumpTo}
                />
              );
            })}
          </div>
        </div>

        {showJump && (
          <button
            type="button"
            className="msg-jump"
            aria-label="Zu den neuesten Nachrichten"
            onClick={() => scrollToBottom(true)}
          >
            ↓
            {conversation && conversation.unreadCount > 0 && (
              <span className="chat-badge">{conversation.unreadCount}</span>
            )}
          </button>
        )}
      </div>

      <Composer
        conversationId={conversationId}
        conversation={conversation}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onScrollToBottom={() => scrollToBottom()}
      />

      <MessageActionsSheet
        message={actionsFor}
        conversation={conversation}
        onClose={() => setActionsFor(null)}
        onReply={setReplyTo}
      />

      <ChatInfoSheet
        open={infoOpen}
        conversation={conversation}
        onClose={() => setInfoOpen(false)}
      />
    </div>
  );
}
