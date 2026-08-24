import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { messagePreview, type ConversationDto, type MessageDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { NewChatSheet } from './NewChatSheet.js';
import {
  conversationAvatar,
  conversationTitle,
  counterpartOf,
  formatListStamp,
  mutedLabel,
  senderName,
} from './helpers.js';

function lastActivity(conversation: ConversationDto): number {
  const stamp = conversation.lastMessage?.createdAt ?? conversation.updatedAt;
  const time = new Date(stamp).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function ChatListScreen() {
  const navigate = useNavigate();
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  const presence = useChat((state) => state.presence);
  const typing = useChat((state) => state.typing);
  const initialised = useChat((state) => state.initialised);

  const [params, setParams] = useSearchParams();
  const [newChatOpen, setNewChatOpen] = useState(params.get('new') === '1');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MessageDto[]>([]);
  const [searching, setSearching] = useState(false);
  const requestId = useRef(0);

  // The PWA shortcut "Neuer Chat" opens /chats?new=1.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setNewChatOpen(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const current = ++requestId.current;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.messages.search(term);
        if (current !== requestId.current) return;
        setHits(items);
      } catch {
        if (current !== requestId.current) return;
        setHits([]);
        toast('Nachrichtensuche fehlgeschlagen', 'error');
      } finally {
        if (current === requestId.current) setSearching(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [term]);

  const visible = useMemo(() => {
    const list = conversations.filter((conversation) => !conversation.archived);
    const filtered =
      term.length === 0
        ? list
        : list.filter((conversation) =>
            conversationTitle(conversation, myId).toLowerCase().includes(term.toLowerCase()),
          );
    return filtered.slice().sort((a, b) => lastActivity(b) - lastActivity(a));
  }, [conversations, myId, term]);

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    setHits([]);
  }

  return (
    <Screen
      title="Chats"
      bare
      actions={
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label={searchOpen ? 'Suche schließen' : 'Chats durchsuchen'}
            aria-expanded={searchOpen}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            {searchOpen ? '✕' : '🔍'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Neuer Chat"
            onClick={() => setNewChatOpen(true)}
          >
            ✎
          </button>
        </>
      }
    >
      <div className="page">
        {searchOpen && (
          <div className="chat-search">
            <input
              className="input"
              type="search"
              inputMode="search"
              autoFocus
              placeholder="Chats und Nachrichten durchsuchen"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        {!initialised && conversations.length === 0 && (
          <div style={{ padding: 'var(--space-5)' }}>
            <Spinner label="Chats werden geladen" />
          </div>
        )}

        {initialised && conversations.length === 0 && (
          <EmptyState
            emoji="💬"
            title="Noch keine Chats"
            description="Starte ein Gespräch – such dir jemanden oder gründe direkt eine Gruppe."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setNewChatOpen(true)}>
                Neuen Chat starten
              </button>
            }
          />
        )}

        {conversations.length > 0 && visible.length === 0 && term.length > 0 && hits.length === 0 && !searching && (
          <EmptyState emoji="🔍" title="Nichts gefunden" description={`Keine Treffer für „${term}“.`} />
        )}

        {visible.length > 0 && (
          <div className="list">
            {visible.map((conversation) => (
              <ChatRow
                key={conversation.id}
                conversation={conversation}
                myId={myId}
                online={
                  conversation.type === 'direct'
                    ? (presence[counterpartOf(conversation, myId)?.userId ?? '']?.online ?? false)
                    : undefined
                }
                typing={(typing[conversation.id] ?? []).some((entry) => entry.userId !== myId)}
              />
            ))}
          </div>
        )}

        {term.length >= 2 && (
          <div className="chat-hits">
            <div className="msg-info-label" style={{ padding: '0 var(--space-4)' }}>
              Nachrichten
            </div>
            {searching && (
              <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
                <Spinner label="Suche läuft" />
              </div>
            )}
            {!searching && hits.length === 0 && (
              <p className="muted" style={{ padding: '0 var(--space-4)', fontSize: '0.88rem' }}>
                Keine passenden Nachrichten.
              </p>
            )}
            <div className="list">
              {hits.map((hit) => {
                const conversation = conversations.find((item) => item.id === hit.conversationId) ?? null;
                return (
                  <button
                    key={hit.id}
                    type="button"
                    className="list-row"
                    onClick={() => {
                      closeSearch();
                      navigate(`/chats/${hit.conversationId}`);
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>
                      💬
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                        {conversation ? conversationTitle(conversation, myId) : 'Chat'}
                      </span>
                      <span className="muted truncate" style={{ display: 'block', fontSize: '0.84rem' }}>
                        {senderName(conversation, hit.senderId)}: {messagePreview(hit)}
                      </span>
                    </span>
                    <span className="faint" style={{ fontSize: '0.75rem' }}>
                      {formatListStamp(hit.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <NewChatSheet open={newChatOpen} onClose={() => setNewChatOpen(false)} />
    </Screen>
  );
}

function ChatRow({
  conversation,
  myId,
  online,
  typing,
}: {
  conversation: ConversationDto;
  myId: string;
  online: boolean | undefined;
  typing: boolean;
}) {
  const avatar = conversationAvatar(conversation, myId);
  const last = conversation.lastMessage;
  const muted = mutedLabel(conversation.mutedUntil);

  let preview = 'Noch keine Nachrichten';
  if (typing) {
    preview = 'tippt …';
  } else if (last) {
    const prefix =
      last.type === 'system'
        ? ''
        : last.senderId === myId || last.senderId == null
          ? 'Du: '
          : conversation.type === 'group'
            ? `${senderName(conversation, last.senderId)}: `
            : '';
    preview = `${prefix}${messagePreview(last)}`;
  }

  return (
    <Link className="list-row chat-row" to={`/chats/${conversation.id}`}>
      <Avatar name={avatar.name} id={avatar.id} url={avatar.url} size={50} online={online} />
      <span className="chat-row-main">
        <span className="chat-row-line">
          <span className="chat-row-name truncate">{conversationTitle(conversation, myId)}</span>
          <span className="chat-row-time">
            {muted && (
              <span aria-label="stummgeschaltet" title="stummgeschaltet">
                🔕
              </span>
            )}
            {last ? formatListStamp(last.createdAt) : ''}
          </span>
        </span>
        <span className="chat-row-line">
          <span className={`chat-row-preview truncate ${typing ? 'chat-row-typing' : ''}`}>{preview}</span>
          {conversation.unreadCount > 0 && (
            <span className="chat-badge">
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
