import { create } from 'zustand';
import {
  TYPING_TTL_MS,
  uuidv7,
  type CalendarEventDto,
  type ConversationDto,
  type MessageDto,
  type MessageMetadata,
  type MessageType,
  type ReactionDto,
} from '@initiative/shared';
import { ApiError, api } from '../lib/api.js';
import { realtime } from '../lib/realtime.js';
import {
  auf as aufTerminEreignisse,
  auffrischen as terminAuffrischen,
  connectTerminEreignisse,
  einmalPruefen as terminEinmalPruefen,
  neuer as neuerTermin,
  type EntferntGrund,
} from '../lib/terminEreignisse.js';
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

/**
 * A message plus client-only delivery state.
 *
 * `terminGrund` gilt nur für Termin-Karten: Warum der Termin nicht mehr zu sehen
 * ist, solange die Sitzung läuft („Du bist nicht mehr eingeladen“). Nach dem
 * Neuladen kennt der Server den Grund der Karte nicht mehr – dann steht dort das
 * neutrale „Termin nicht verfügbar“, darum wird er nicht zwischengespeichert.
 */
export type ChatMessage = MessageDto & {
  pending?: boolean;
  failed?: boolean;
  terminGrund?: EntferntGrund;
};

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
  /**
   * Ob die Chatliste wirklich schon vom Server kam. `initialised` gilt schon,
   * wenn der lokale Zwischenspeicher gelesen ist – bei einem kalten Start (neues
   * Gerät, frische Anmeldung) ist die Liste dann noch leer, obwohl sie gleich
   * kommt. Wer daraus „du hast keine Kontakte“ schließt, irrt.
   */
  conversationsLoaded: boolean;
  /** Das Laden der Chatliste ist gescheitert – bis zum nächsten Erfolg. */
  conversationsFailed: boolean;
  hydrate: () => Promise<void>;
  loadConversations: () => Promise<void>;
  ensureConversation: (conversationId: string) => Promise<ConversationDto | null>;
  loadMessages: (conversationId: string, options?: { force?: boolean }) => Promise<void>;
  loadOlder: (conversationId: string) => Promise<void>;
  sendMessage: (conversationId: string, draft: Draft) => Promise<void>;
  retryFailed: (conversationId: string, clientId: string) => Promise<void>;
  discardFailed: (conversationId: string, clientId: string) => Promise<void>;
  flushOutbox: () => Promise<void>;
  deleteMessage: (message: MessageDto, scope?: 'me' | 'all') => Promise<void>;
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
  conversationsLoaded: false,
  conversationsFailed: false,

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
      set({ conversations: items, conversationsLoaded: true, conversationsFailed: false });
      void cacheConversations(items);
    } catch (error) {
      set({ conversationsFailed: true });
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
          [conversationId]: vereinen(cached, state.messages[conversationId]),
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
      // Nur die erste Seite kam frisch vom Server. Karten dahinter stammen aus
      // dem Zwischenspeicher und zeigen den Stand vom letzten Öffnen – ihre
      // Termine werden einmal je Sitzung nachgeprüft.
      const frisch = new Set(items.map((message) => message.id));
      terminEinmalPruefen(kartenKennungen(cached.filter((message) => !frisch.has(message.id))));
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

  async deleteMessage(message, scope = 'all') {
    await api.messages.remove(message.id, scope);
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

/**
 * Führt Zwischenspeicher und Speicher zusammen – je Kennung eine Nachricht, der
 * Speicher gewinnt (er ist neuer). Bloßes Aneinanderhängen ließ dieselbe
 * Nachricht zweimal im Speicher stehen; React behielt die Geisterzeilen wegen
 * doppelter Schlüssel, und der ganze Verlauf erschien doppelt.
 */
function vereinen(
  zwischenspeicher: ChatMessage[],
  aktuell: ChatMessage[] | undefined,
): ChatMessage[] {
  const nachId = new Map<string, ChatMessage>();
  for (const message of zwischenspeicher) nachId.set(message.id, message);
  for (const message of aktuell ?? []) nachId.set(message.id, message);
  return sortMessages([...nachId.values()]);
}

/** Die Termine, deren Karten in diesen Nachrichten stehen (nur sichtbare, nicht gelöschte). */
function kartenKennungen(messages: Iterable<ChatMessage>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'event' || message.deletedAt || message.terminGrund) continue;
    const id = message.event?.id ?? message.metadata.eventId;
    if (id) ids.add(id);
  }
  return [...ids];
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

/**
 * Was aus einer Nachricht in den Zwischenspeicher darf: ohne den Zustand, der
 * nur in dieser Sitzung gilt.
 */
function zumCache(message: ChatMessage): MessageDto {
  const { terminGrund: _grund, pending: _wartet, failed: _gescheitert, ...rest } = message;
  return rest;
}

function istKarteVon(message: ChatMessage, eventId: string): boolean {
  return (
    message.type === 'event' &&
    (message.metadata.eventId === eventId || message.event?.id === eventId)
  );
}

/**
 * Führt jede Karte eines Termins auf den neuen Stand nach – in ALLEN Chats.
 *
 * Die Karte hält keinen eigenen Stand: Sie zeigt den Termin, wie der Server ihn
 * dem Betrachter ausgeliefert hat, und der liegt in `message.event`. Bisher
 * wurde er nie berührt – `EventBubble` hörte selbst auf `event.updated`, aber
 * nur, solange sie eingehängt war. Eine Zusage in einem anderen Chat erreichte
 * eine nicht geöffnete Karte nie, und beim Zurückkehren stand dort der alte
 * Zähler.
 *
 * Nur betroffene Listen werden kopiert; alles andere behält seine Identität,
 * damit nicht jeder Chat neu zeichnet, weil ein Termin sich geändert hat.
 */
export function terminAbgleichen(event: CalendarEventDto): void {
  const geaendert: ChatMessage[] = [];
  const neuLaden: string[] = [];
  useChat.setState((state) => {
    let messages = state.messages;
    // Steht die Karte dieses Termins schon im Chat, zu dem er gehört – und
    // irgendwo? Dann stammen leere Karten dort von anderen Terminen.
    let imChat = false;
    let irgendwo = false;
    const chat = event.conversationId;
    for (const [conversationId, list] of Object.entries(state.messages)) {
      let neu: ChatMessage[] | null = null;
      list.forEach((message, index) => {
        if (!istKarteVon(message, event.id)) return;
        irgendwo = true;
        if (conversationId === chat) imChat = true;
        const fassung = message.event ? neuerTermin(message.event, event) : event;
        if (fassung === message.event && !message.terminGrund) return;
        neu ??= list.slice();
        const ersatz: ChatMessage = { ...message, event: fassung };
        delete ersatz.terminGrund;
        neu[index] = ersatz;
        geaendert.push(ersatz);
      });
      if (neu) {
        if (messages === state.messages) messages = { ...state.messages };
        messages[conversationId] = neu;
      }
    }

    // Eine Karte, die dem Betrachter bisher nichts zeigte (er war nicht
    // eingeladen), trägt weder `event` noch die Kennung – sie lässt sich nicht
    // zuordnen. Wird er eingeladen, muss sie neu geholt werden, damit sie sich
    // füllt: im Chat des Termins, wenn dort noch keine Karte dieses Termins
    // steht, und – kennt der Speicher den Termin sonst nirgends – in jedem
    // geladenen Chat mit einer leeren Karte (ein Termin kann in mehreren
    // Gruppenchats stehen).
    //
    // Der Chat wird gezielt neu geladen und nicht nur zum Neuladen vorgemerkt:
    // Ein vorgemerkter Chat, der geöffnet bleibt, füllte sich nie.
    for (const [conversationId, list] of Object.entries(state.messages)) {
      if (!state.loaded[conversationId]) continue;
      const betroffen =
        (conversationId === chat && !imChat) || !irgendwo
          ? list.some(
              (message) =>
                message.type === 'event' &&
                !message.event &&
                !message.metadata.eventId &&
                !message.deletedAt,
            )
          : false;
      if (betroffen) neuLaden.push(conversationId);
    }

    return messages === state.messages ? {} : { messages };
  });
  if (geaendert.length > 0) void cacheMessages(geaendert.map(zumCache));
  for (const conversationId of neuLaden) leereKarteNeuLaden(conversationId);
}

/** Wann zuletzt ein Chat wegen einer leeren Karte neu geladen wurde – höchstens alle 30 s. */
const leereKarteGeladen = new Map<string, number>();

function leereKarteNeuLaden(conversationId: string): void {
  const jetzt = Date.now();
  if (jetzt - (leereKarteGeladen.get(conversationId) ?? 0) < 30_000) return;
  leereKarteGeladen.set(conversationId, jetzt);
  void useChat.getState().loadMessages(conversationId, { force: true });
}

/**
 * Der Termin ist weg oder nicht mehr sichtbar: Die Karten zeigen es, statt
 * einen Stand von vorgestern zu behalten.
 */
export function terminEntfernt(eventId: string, grund?: EntferntGrund): void {
  const geaendert: ChatMessage[] = [];
  useChat.setState((state) => {
    let messages = state.messages;
    for (const [conversationId, list] of Object.entries(state.messages)) {
      let neu: ChatMessage[] | null = null;
      list.forEach((message, index) => {
        if (!istKarteVon(message, eventId)) return;
        if (!message.event && message.terminGrund === grund) return;
        neu ??= list.slice();
        const ersatz: ChatMessage = { ...message, event: undefined };
        if (grund) ersatz.terminGrund = grund;
        else delete ersatz.terminGrund;
        neu[index] = ersatz;
        geaendert.push(ersatz);
      });
      if (neu) {
        if (messages === state.messages) messages = { ...state.messages };
        messages[conversationId] = neu;
      }
    }
    return messages === state.messages ? {} : { messages };
  });
  if (geaendert.length > 0) void cacheMessages(geaendert.map(zumCache));
}

/**
 * Nach einer Lücke der Verbindung: Was die Karten zeigen, kann veraltet sein –
 * Zusagen, Absage, neue Zeit, Löschen in der Lücke kamen nie an. Jeder Termin,
 * dessen Karte im Speicher steht, wird neu geholt und läuft durch den Trichter,
 * der alle Karten und den Kalender nachführt. Chats, in denen eine Karte „nicht
 * verfügbar“ zeigt, werden neu geladen: Wer in der Lücke (wieder) eingeladen
 * wurde, bekäme sonst nie seine Karte.
 */
export function kartenNachholen(): void {
  const { messages, loaded } = useChat.getState();
  terminAuffrischen(kartenKennungen(Object.values(messages).flat()));
  for (const [conversationId, list] of Object.entries(messages)) {
    if (!loaded[conversationId]) continue;
    const verwehrt = list.some(
      (message) =>
        message.type === 'event' &&
        !message.deletedAt &&
        (message.terminGrund || (!message.event && !message.metadata.eventId)),
    );
    if (verwehrt) leereKarteNeuLaden(conversationId);
  }
}

/** Wire realtime events into the store exactly once. */
let wired = false;
export function connectChatRealtime(): void {
  if (wired) return;
  wired = true;

  // Termin-Karten stehen in vielen Chats, auch in nie geöffneten: Jede Änderung
  // des Termins führt sie alle nach – nicht nur die Karte, die gerade offen ist.
  connectTerminEreignisse();
  aufTerminEreignisse({
    aktualisiert: terminAbgleichen,
    entfernt: terminEntfernt,
    nachholen: kartenNachholen,
  });

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
  realtime.on('sync.hint', ({ conversationId, eventId }) => {
    if (conversationId) void useChat.getState().loadMessages(conversationId, { force: true });
    // Ein Hinweis auf einen Termin gehört dem Trichter (`terminEreignisse`); die
    // Chats müssen dafür nicht neu geladen werden.
    else if (!eventId) void useChat.getState().loadConversations();
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
