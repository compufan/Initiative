import { create } from 'zustand';
import {
  TYPING_TTL_MS,
  uuidv7,
  type ConversationDto,
  type MessageDto,
  type MessageMetadata,
  type MessageType,
  type ReactionDto,
} from '@initiative/shared';
import { ApiError, api } from '../lib/api.js';
import { realtime } from '../lib/realtime.js';
import {
  cacheConversations,
  cacheMessages,
  dropCachedMessage,
  enqueueOutbox,
  readCachedConversations,
  readCachedMessages,
  readOutbox,
  removeCachedConversation,
  removeOutbox,
  trimMessageCache,
  updateOutbox,
  type OutboxAttachment,
  type OutboxEntry,
} from '../lib/db.js';
import { uploadBlob } from '../lib/upload.js';

/** A message plus client-only delivery state. */
export type ChatMessage = MessageDto & { pending?: boolean; failed?: boolean };

export interface Draft {
  type?: MessageType;
  body?: string | null;
  replyToId?: string | null;
  metadata?: MessageMetadata;
  attachmentIds?: string[];
  /** Files that still have to be uploaded (works offline). */
  attachments?: OutboxAttachment[];
}

interface TypingEntry {
  userId: string;
  until: number;
}

interface ChatState {
  conversations: ConversationDto[];
  messages: Record<string, ChatMessage[]>;
  hasMore: Record<string, boolean>;
  loading: Record<string, boolean>;
  /**
   * Ob die erste Seite dieses Chats wirklich schon vom Server geholt wurde.
   *
   * Vorher wurde dafür geprüft, ob im Zustand irgendeine Nachricht liegt. Das
   * war falsch: Realtime-Ereignisse tragen für JEDE Konversation Nachrichten
   * ein, auch für nie geöffnete, und die Outbox tut es ebenfalls. Dadurch
   * wurden Cache und erste Seite übersprungen und `hasMore` nie gesetzt – der
   * Verlauf war weg und liess sich nicht einmal hochscrollen.
   */
  loaded: Record<string, boolean>;
  typing: Record<string, TypingEntry[]>;
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
  initialised: boolean;
  hydrate: () => Promise<void>;
  loadConversations: () => Promise<void>;
  ensureConversation: (conversationId: string) => Promise<ConversationDto | null>;
  loadMessages: (conversationId: string, options?: { force?: boolean }) => Promise<void>;
  loadOlder: (conversationId: string) => Promise<void>;
  sendMessage: (conversationId: string, draft: Draft) => Promise<void>;
  retryFailed: (conversationId: string, clientId: string) => Promise<void>;
  discardFailed: (conversationId: string, clientId: string) => Promise<void>;
  flushOutbox: () => Promise<void>;
  deleteMessage: (message: MessageDto) => Promise<void>;
  toggleReaction: (message: MessageDto, emoji: string, mine: boolean) => Promise<void>;
  markRead: (conversationId: string) => void;
  setTyping: (conversationId: string, typing: boolean) => void;
  upsertConversation: (conversation: ConversationDto) => void;
  removeConversation: (conversationId: string) => void;
  applyMessage: (message: MessageDto) => void;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function mergeMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const byClientId = message.clientId
    ? list.findIndex((item) => item.clientId === message.clientId)
    : -1;
  const index = byClientId >= 0 ? byClientId : list.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const next = list.slice();
    next[index] = { ...list[index], ...message, pending: false, failed: false };
    return sortMessages(next);
  }
  return sortMessages([...list, message]);
}

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  messages: {},
  hasMore: {},
  loading: {},
  loaded: {},
  typing: {},
  presence: {},
  initialised: false,

  async hydrate() {
    const [conversations, outbox] = await Promise.all([readCachedConversations(), readOutbox()]);
    if (conversations.length > 0) set({ conversations });
    if (outbox.length > 0) {
      const grouped: Record<string, ChatMessage[]> = {};
      for (const entry of outbox) {
        (grouped[entry.conversationId] ??= []).push(outboxToMessage(entry));
      }
      set((state) => {
        const messages = { ...state.messages };
        for (const [conversationId, pending] of Object.entries(grouped)) {
          messages[conversationId] = sortMessages([
            ...(messages[conversationId] ?? []),
            ...pending,
          ]);
        }
        return { messages };
      });
    }
    set({ initialised: true });
    void get().loadConversations();
    void get().flushOutbox();
  },

  async loadConversations() {
    try {
      const { items } = await api.conversations.list();
      set({ conversations: items });
      void cacheConversations(items);
    } catch (error) {
      if (!(error instanceof ApiError && error.isOffline)) throw error;
    }
  },

  async ensureConversation(conversationId) {
    const existing = get().conversations.find((item) => item.id === conversationId);
    if (existing) return existing;
    try {
      const conversation = await api.conversations.byId(conversationId);
      get().upsertConversation(conversation);
      return conversation;
    } catch {
      return null;
    }
  },

  async loadMessages(conversationId, options) {
    if (get().loading[conversationId]) return;
    if (!options?.force && get().loaded[conversationId]) {
      void refreshMessages(conversationId, set, get);
      return;
    }

    set((state) => ({ loading: { ...state.loading, [conversationId]: true } }));
    const cached = await readCachedMessages(conversationId);
    if (cached.length > 0) {
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: sortMessages([...cached, ...(state.messages[conversationId] ?? [])]),
        },
      }));
    }
    try {
      const { items, nextCursor } = await api.messages.list(conversationId);
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: mergeList(state.messages[conversationId], items),
        },
        hasMore: { ...state.hasMore, [conversationId]: Boolean(nextCursor) },
        loaded: { ...state.loaded, [conversationId]: true },
      }));
      void cacheMessages(items);
      void trimMessageCache(conversationId);
    } catch (error) {
      if (!(error instanceof ApiError && error.isOffline)) throw error;
    } finally {
      set((state) => ({ loading: { ...state.loading, [conversationId]: false } }));
    }
  },

  async loadOlder(conversationId) {
    const list = get().messages[conversationId] ?? [];
    const oldest = list.find((message) => !message.pending);
    if (!oldest || get().loading[conversationId]) return;
    set((state) => ({ loading: { ...state.loading, [conversationId]: true } }));
    try {
      const { items, nextCursor } = await api.messages.list(conversationId, { before: oldest.id });
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: mergeList(state.messages[conversationId], items),
        },
        hasMore: { ...state.hasMore, [conversationId]: Boolean(nextCursor) && items.length > 0 },
      }));
      void cacheMessages(items);
    } catch {
      /* keep what we have */
    } finally {
      set((state) => ({ loading: { ...state.loading, [conversationId]: false } }));
    }
  },

  async sendMessage(conversationId, draft) {
    const clientId = uuidv7();
    const entry: OutboxEntry = {
      clientId,
      conversationId,
      type: draft.type ?? 'text',
      body: draft.body?.trim() ? draft.body.trim() : null,
      replyToId: draft.replyToId ?? null,
      metadata: draft.metadata ?? {},
      attachmentIds: draft.attachmentIds ?? [],
      pendingAttachments: draft.attachments ?? [],
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
    };

    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: sortMessages([
          ...(state.messages[conversationId] ?? []),
          outboxToMessage(entry),
        ]),
      },
    }));
    await enqueueOutbox(entry);
    await get().flushOutbox();
  },

  async retryFailed(conversationId, clientId) {
    const entries = await readOutbox(conversationId);
    const entry = entries.find((item) => item.clientId === clientId);
    if (!entry) return;
    entry.attempts = 0;
    entry.lastError = null;
    await updateOutbox(entry);
    markPending(set, conversationId, clientId);
    await get().flushOutbox();
  },

  /**
   * Wirft eine nicht zustellbare Nachricht weg.
   *
   * Sie existiert nur lokal in der Outbox – der Server hat sie nie gesehen.
   * Deshalb reicht es, den Eintrag zu löschen und die Blase zu entfernen.
   */
  async discardFailed(conversationId, clientId) {
    await removeOutbox(clientId);
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).filter(
          (message) => message.clientId !== clientId,
        ),
      },
    }));
  },

  async flushOutbox() {
    if (flushing) return;
    flushing = true;
    try {
      const entries = await readOutbox();
      for (const entry of entries) {
        try {
          const attachmentIds = [...entry.attachmentIds];
          for (const attachment of entry.pendingAttachments) {
            const uploaded = await uploadBlob(attachment);
            attachmentIds.push(uploaded.id);
          }
          const message = await api.messages.send(entry.conversationId, {
            type: entry.type,
            body: entry.body,
            replyToId: entry.replyToId,
            metadata: entry.metadata,
            attachmentIds,
            clientId: entry.clientId,
          });
          await removeOutbox(entry.clientId);
          get().applyMessage(message);
        } catch (error) {
          const offline = error instanceof ApiError && error.isOffline;
          entry.attempts += 1;
          entry.lastError = error instanceof Error ? error.message : 'Senden fehlgeschlagen';
          await updateOutbox(entry);
          if (offline) break;
          if (entry.attempts >= 3) markFailed(set, entry);
        }
      }
    } finally {
      flushing = false;
    }
  },

  async deleteMessage(message) {
    await api.messages.remove(message.id);
    void dropCachedMessage(message.id);
    set((state) => ({
      messages: {
        ...state.messages,
        [message.conversationId]: (state.messages[message.conversationId] ?? []).filter(
          (item) => item.id !== message.id,
        ),
      },
    }));
  },

  async toggleReaction(message, emoji, mine) {
    const result = mine
      ? await api.messages.unreact(message.id, emoji)
      : await api.messages.react(message.id, emoji);
    applyReactions(set, message.conversationId, message.id, result.reactions);
  },

  markRead(conversationId) {
    const list = get().messages[conversationId] ?? [];
    const last = [...list].reverse().find((message) => !message.pending);
    if (!last) return;
    const conversation = get().conversations.find((item) => item.id === conversationId);
    if (conversation && conversation.unreadCount === 0) return;
    set((state) => ({
      conversations: state.conversations.map((item) =>
        item.id === conversationId ? { ...item, unreadCount: 0 } : item,
      ),
    }));
    if (!realtime.send({ type: 'read', payload: { conversationId, messageId: last.id } })) {
      void api.conversations.markRead(conversationId, last.id).catch(() => {});
    }
  },

  setTyping(conversationId, typing) {
    realtime.send({ type: 'typing', payload: { conversationId, typing } });
  },

  upsertConversation(conversation) {
    set((state) => {
      const index = state.conversations.findIndex((item) => item.id === conversation.id);
      const conversations =
        index >= 0
          ? state.conversations.map((item) => (item.id === conversation.id ? conversation : item))
          : [conversation, ...state.conversations];
      return {
        conversations: conversations.sort(
          (a, b) =>
            new Date(b.lastMessage?.createdAt ?? b.updatedAt).getTime() -
            new Date(a.lastMessage?.createdAt ?? a.updatedAt).getTime(),
        ),
      };
    });
    void cacheConversations([conversation]);
  },

  removeConversation(conversationId) {
    set((state) => ({
      conversations: state.conversations.filter((item) => item.id !== conversationId),
      messages: { ...state.messages, [conversationId]: [] },
    }));
    void removeCachedConversation(conversationId);
  },

  applyMessage(message) {
    set((state) => ({
      messages: {
        ...state.messages,
        [message.conversationId]: mergeMessage(
          state.messages[message.conversationId] ?? [],
          message,
        ),
      },
      conversations: state.conversations.map((conversation) =>
        conversation.id === message.conversationId
          ? { ...conversation, lastMessage: message }
          : conversation,
      ),
    }));
    void cacheMessages([message]);
  },
}));

let flushing = false;

function mergeList(existing: ChatMessage[] | undefined, incoming: MessageDto[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const message of existing ?? []) map.set(message.id, message);
  for (const message of incoming) {
    const previous = message.clientId
      ? [...map.values()].find((item) => item.pending && item.clientId === message.clientId)
      : undefined;
    if (previous) map.delete(previous.id);
    map.set(message.id, { ...message, pending: false, failed: false });
  }
  return sortMessages([...map.values()]);
}

function outboxToMessage(entry: OutboxEntry): ChatMessage {
  return {
    id: `local:${entry.clientId}`,
    conversationId: entry.conversationId,
    senderId: null,
    type: entry.type,
    body: entry.body,
    attachments: [],
    replyToId: entry.replyToId,
    replyTo: null,
    metadata: entry.metadata,
    reactions: [],
    clientId: entry.clientId,
    createdAt: new Date(entry.createdAt).toISOString(),
    editedAt: null,
    deletedAt: null,
    pending: true,
    failed: entry.attempts >= 3,
  };
}

function markFailed(
  set: (updater: (state: ChatState) => Partial<ChatState>) => void,
  entry: OutboxEntry,
): void {
  set((state) => ({
    messages: {
      ...state.messages,
      [entry.conversationId]: (state.messages[entry.conversationId] ?? []).map((message) =>
        message.clientId === entry.clientId
          ? { ...message, failed: true, pending: false }
          : message,
      ),
    },
  }));
}

function markPending(
  set: (updater: (state: ChatState) => Partial<ChatState>) => void,
  conversationId: string,
  clientId: string,
): void {
  set((state) => ({
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
        message.clientId === clientId ? { ...message, failed: false, pending: true } : message,
      ),
    },
  }));
}

function applyReactions(
  set: (updater: (state: ChatState) => Partial<ChatState>) => void,
  conversationId: string,
  messageId: string,
  reactions: ReactionDto[],
): void {
  set((state) => ({
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
        message.id === messageId ? { ...message, reactions } : message,
      ),
    },
  }));
}

async function refreshMessages(
  conversationId: string,
  set: (updater: (state: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
): Promise<void> {
  const list = get().messages[conversationId] ?? [];
  const newest = [...list].reverse().find((message) => !message.pending);
  try {
    const { items } = await api.messages.list(conversationId, newest ? { after: newest.id } : {});
    if (items.length === 0) return;
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: mergeList(state.messages[conversationId], items),
      },
    }));
    void cacheMessages(items);
  } catch {
    /* offline – the cache stays */
  }
}

/** Wire realtime events into the store exactly once. */
let wired = false;
export function connectChatRealtime(): void {
  if (wired) return;
  wired = true;

  realtime.on('message.new', ({ message }) => useChat.getState().applyMessage(message));
  realtime.on('message.updated', ({ message }) => useChat.getState().applyMessage(message));
  realtime.on('message.deleted', ({ conversationId, messageId }) => {
    void dropCachedMessage(messageId);
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).filter(
          (item) => item.id !== messageId,
        ),
      },
    }));
  });
  realtime.on('message.reactions', ({ conversationId, messageId, reactions }) => {
    applyReactions(useChat.setState, conversationId, messageId, reactions);
  });
  realtime.on('conversation.updated', ({ conversation }) =>
    useChat.getState().upsertConversation(conversation),
  );
  realtime.on('conversation.removed', ({ conversationId }) =>
    useChat.getState().removeConversation(conversationId),
  );
  realtime.on('typing', ({ conversationId, userId, until }) => {
    const expires = new Date(until).getTime();
    useChat.setState((state) => {
      const current = (state.typing[conversationId] ?? []).filter(
        (entry) => entry.userId !== userId && entry.until > Date.now(),
      );
      if (expires > Date.now()) current.push({ userId, until: expires });
      return { typing: { ...state.typing, [conversationId]: current } };
    });
  });
  realtime.on('presence', ({ userId, online, lastSeenAt }) => {
    useChat.setState((state) => ({
      presence: { ...state.presence, [userId]: { online, lastSeenAt } },
    }));
  });
  realtime.on('read.updated', ({ conversationId, userId, lastReadMessageId }) => {
    useChat.setState((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              members: conversation.members.map((member) =>
                member.userId === userId ? { ...member, lastReadMessageId } : member,
              ),
            }
          : conversation,
      ),
    }));
  });
  realtime.on('sync.hint', ({ conversationId }) => {
    if (conversationId) void useChat.getState().loadMessages(conversationId, { force: true });
    else void useChat.getState().loadConversations();
  });
  realtime.onStateChange((state) => {
    if (state === 'online') void useChat.getState().flushOutbox();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void useChat.getState().flushOutbox());
  }

  // Typing indicators expire on their own.
  setInterval(() => {
    const now = Date.now();
    useChat.setState((state) => {
      let changed = false;
      const typing: Record<string, TypingEntry[]> = {};
      for (const [conversationId, entries] of Object.entries(state.typing)) {
        const active = entries.filter((entry) => entry.until > now);
        if (active.length !== entries.length) changed = true;
        typing[conversationId] = active;
      }
      return changed ? { typing } : {};
    });
  }, TYPING_TTL_MS / 2);
}
