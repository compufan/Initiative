import { create } from 'zustand';
import {
  LIMITS,
  TYPING_TTL_MS,
  uuidv7,
  type CalendarEventDto,
  type ClientMessageMetadata,
  type ConversationDto,
  type MessageDto,
  type MessageMetadata,
  type MessageType,
  type ReactionDto,
  type StandDto,
  type TippArt,
} from '@initiative/shared';
import { ApiError, api, getTokens } from '../lib/api.js';
import { aboAuffrischen } from '../lib/push.js';
import { realtime } from '../lib/realtime.js';
import {
  beiSichtbarkeitsaenderung,
  chatVorAugen,
  neuesSofortGesehen,
  sichtbarkeitVerdrahten,
} from './sichtbarkeit.js';
import { beiRueckkehr, gedrosselt } from '../lib/wiederaufnahme.js';
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
  dateiHinterlegen,
  dropCachedMessage,
  enqueueOutbox,
  outboxErledigt,
  readCachedConversations,
  readCachedMessages,
  readMeta,
  readOutbox,
  removeCachedConversation,
  removeOutbox,
  trimMessageCache,
  updateOutbox,
  writeMeta,
  type OutboxAttachment,
  type OutboxEntry,
} from '../lib/db.js';
import { uploadBlob } from '../lib/upload.js';
import { hochladeAbbruch, useHochladen } from './hochladen.js';
import { einreihen, ueberlagern, type Aktion, type AktionsEintrag } from './aktionen.js';
import { zustellungVormerken } from './zustellung.js';
import { sternSetzenLokal, sterneLaden } from './sterne.js';
import {
  entwurfErledigt,
  entwurfVomServer,
  entwuerfeAbgleichen,
  entwuerfeLaden,
} from './entwuerfe.js';

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
  /**
   * Eine grosse Datei dieser Nachricht ist nach einem Neustart nicht mehr
   * lesbar (sie lag nur im Speicher des Tabs, siehe `OUTBOX_BLOB_MAX`). Die
   * Blase bittet darum, sie noch einmal auszuwählen.
   */
  dateiFehlt?: { index: number; name: string; groesse: number };
};

export interface Draft {
  type?: MessageType;
  body?: string | null;
  replyToId?: string | null;
  /** Nur, was ein Client senden darf – den Rest setzt der Server selbst. */
  metadata?: ClientMessageMetadata;
  attachmentIds?: string[];
  /** Files that still have to be uploaded (works offline). */
  attachments?: OutboxAttachment[];
  /** „Ohne Ton senden“: die Mitteilung kommt leise. */
  silent?: boolean;
}

interface TypingEntry {
  userId: string;
  until: number;
  /** `audio`: nimmt gerade eine Sprachnachricht auf. */
  art: TippArt;
}

/** Gelesen-/Zustellstand je Mitglied eines Chats (siehe `staendeLaden`). */
export type Staende = Record<string, { gelesen: string | null; zugestellt: string | null }>;

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
  /** Je Chat die Gelesen- und Zustellstände der Mitglieder – für die Häkchen. */
  staende: Record<string, Staende>;
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
  /** Bricht einen laufenden Upload ab und verwirft die Nachricht. */
  uploadAbbrechen: (conversationId: string, clientId: string) => Promise<void>;
  /**
   * Hinterlegt eine neu ausgewählte Datei für einen liegengebliebenen grossen
   * Upload. `false`, wenn sie nicht dieselbe ist (andere Grösse).
   */
  dateiNachreichen: (
    conversationId: string,
    clientId: string,
    index: number,
    datei: Blob,
  ) => Promise<boolean>;
  flushOutbox: () => Promise<void>;
  deleteMessage: (message: MessageDto, scope?: 'me' | 'all') => Promise<void>;
  toggleReaction: (message: MessageDto, emoji: string, mine: boolean) => Promise<void>;
  /** Bearbeiten – sofort sichtbar, beim Server über die Aktionswarteschlange. */
  editMessage: (message: MessageDto, body: string, mentions?: string[]) => Promise<void>;
  /** Sternchen setzen oder entfernen. */
  toggleStern: (message: MessageDto, setzen: boolean) => Promise<void>;
  /** Die Häkchen-Stände eines Chats vom Server holen. */
  staendeLaden: (conversationId: string) => Promise<void>;
  /**
   * Holt, was zwischen der ältesten geladenen Nachricht und `messageId` liegt –
   * in einem Zug. Für Sprünge aus Suche, Sternchen und Datum. `false`, wenn die
   * Nachricht danach nicht im Verlauf steht.
   */
  ladenBis: (conversationId: string, messageId: string) => Promise<boolean>;
  markRead: (conversationId: string) => void;
  setTyping: (conversationId: string, typing: boolean, art?: TippArt) => void;
  upsertConversation: (conversation: ConversationDto) => void;
  removeConversation: (conversationId: string) => void;
  applyMessage: (message: MessageDto) => void;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  // Ausstehende Änderungen (offline bearbeitet, gelöscht, reagiert) liegen
  // über allem, was vom Server oder aus dem Zwischenspeicher kommt – bis der
  // Server sie bestätigt hat. Siehe `state/aktionen.ts`.
  return ueberlagern(
    messages.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ausstehendeAktionen,
  );
}

/** Was in der Aktionswarteschlange steht – im Speicher gespiegelt. */
let ausstehendeAktionen: AktionsEintrag[] = [];
const AKTIONEN_META = 'aktionen';

/**
 * Lokale Schatten einer gesendeten Nachricht entfernen.
 *
 * Eine Nachricht hat genau einen `clientId`. Steht sie schon vom Server da,
 * ist jede lokale Fassung mit demselben Schlüssel („wird gesendet“) ein
 * Schatten – etwa nach einem Absturz zwischen dem Commit beim Server und dem
 * Abschluss in der Outbox. Ohne das stand dieselbe Nachricht nach dem
 * Neuladen zweimal im Verlauf, bis der nächste Abgleich kam.
 */
function ohneSchatten(list: ChatMessage[]): ChatMessage[] {
  const gesendet = new Set(
    list
      .filter((item) => !item.pending && !item.failed && item.clientId)
      .map((item) => item.clientId),
  );
  if (gesendet.size === 0) return list;
  return list.filter(
    (item) => !(item.pending || item.failed) || !item.clientId || !gesendet.has(item.clientId),
  );
}

function mergeMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const byId = list.findIndex((item) => item.id === message.id);
  const byClientId = message.clientId
    ? list.findIndex((item) => item.clientId === message.clientId)
    : -1;
  const index = byId >= 0 ? byId : byClientId;
  if (index >= 0) {
    const next = list.slice();
    next[index] = { ...list[index], ...message, pending: false, failed: false };
    return sortMessages(ohneSchatten(next));
  }
  return sortMessages(ohneSchatten([...list, message]));
}

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  messages: {},
  hasMore: {},
  loading: {},
  loaded: {},
  typing: {},
  presence: {},
  staende: {},
  initialised: false,
  conversationsLoaded: false,
  conversationsFailed: false,

  async hydrate() {
    const [conversations, outbox, aktionen] = await Promise.all([
      readCachedConversations(),
      readOutbox(),
      // Ohne Speicher (privater Modus) gibt es eben keine ausstehenden Aktionen.
      Promise.resolve()
        .then(() => readMeta<AktionsEintrag[]>(AKTIONEN_META))
        .catch(() => null),
    ]);
    ausstehendeAktionen = aktionen ?? [];
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
    void aktionenAbarbeiten();
    void sterneLaden();
    void entwuerfeLaden();
  },

  async loadConversations() {
    try {
      const { items } = await api.conversations.list();
      const abgeglichen = items.map(ungelesenAbgleichen);
      set({ conversations: abgeglichen, conversationsLoaded: true, conversationsFailed: false });
      void cacheConversations(abgeglichen);
      // Was die Liste an neuen fremden Nachrichten zeigt, ist auf diesem Gerät
      // angekommen – auch in Chats, die nie geöffnet werden.
      for (const item of abgeglichen) zustellungMelden(item.lastMessage);
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
      zustellungMelden(neuesteFremde(items));
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
    // Gesendet ist der Entwurf erledigt – hier sofort, auf den anderen
    // Geräten über den Server (er leert ihn beim Senden).
    if (draft.type == null || draft.type === 'text') entwurfErledigt(conversationId);
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
      ...(draft.silent ? { silent: true } : {}),
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
    // Läuft für diese Nachricht noch ein grosser Upload, hält er hier an –
    // sonst käme die verworfene Nachricht ein paar Minuten später doch an.
    const laufend = hochladeAbbruch.get(clientId);
    if (laufend) {
      laufend.abort();
      hochladeAbbruch.delete(clientId);
      useHochladen.getState().entfernen(clientId);
    }
    const entry = (await readOutbox(conversationId)).find((item) => item.clientId === clientId);
    // Die halbfertigen Teile beim Server gleich mit wegräumen – sonst liegen
    // sie bis zum Aufräumdienst einen Tag lang auf der Platte.
    for (const anhang of entry?.pendingAttachments ?? []) {
      if (anhang.stueckSitzung) {
        void api.media.stueckeAbbrechen(anhang.stueckSitzung).catch(() => {});
      }
    }
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

  async uploadAbbrechen(conversationId, clientId) {
    await get().discardFailed(conversationId, clientId);
  },

  async dateiNachreichen(conversationId, clientId, index, datei) {
    const entry = (await readOutbox(conversationId)).find((item) => item.clientId === clientId);
    const anhang = entry?.pendingAttachments[index];
    if (!entry || !anhang?.grosseDatei) return false;
    if (datei.size !== anhang.grosseDatei.groesse) return false;
    dateiHinterlegen(clientId, index, datei);
    entry.attempts = 0;
    entry.lastError = null;
    await updateOutbox(entry);
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
          message.clientId === clientId
            ? { ...message, failed: false, pending: true, dateiFehlt: undefined }
            : message,
        ),
      },
    }));
    await get().flushOutbox();
    return true;
  },

  async flushOutbox() {
    if (flushing) {
      // Was während eines laufenden Durchgangs dazukommt, steht nicht in dessen
      // Liste (sie wurde vorher gelesen). Bisher blieb es liegen, bis zufällig
      // der nächste Anlass kam – eine zweite Nachricht, abgeschickt während die
      // erste noch ihr Foto hochlud, hing als „wird gesendet“ fest.
      flushNochmal = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushNochmal = false;
        if (!(await outboxDurchgang())) break;
      } while (flushNochmal);
    } finally {
      flushing = false;
    }
  },

  async deleteMessage(message, scope = 'all') {
    void dropCachedMessage(message.id);
    await aktionEinreihen({
      art: 'loeschen',
      messageId: message.id,
      conversationId: message.conversationId,
      scope,
    });
  },

  async toggleReaction(message, emoji, mine) {
    await aktionEinreihen({
      art: 'reaktion',
      messageId: message.id,
      conversationId: message.conversationId,
      emoji,
      setzen: !mine,
      ich: eigeneKennung() ?? '',
    });
  },

  async editMessage(message, body, mentions) {
    await aktionEinreihen({
      art: 'bearbeiten',
      messageId: message.id,
      conversationId: message.conversationId,
      body,
      am: new Date().toISOString(),
      ...(mentions ? { mentions } : {}),
    });
  },

  async toggleStern(message, setzen) {
    sternSetzenLokal(message.id, setzen);
    await aktionEinreihen({
      art: 'stern',
      messageId: message.id,
      conversationId: message.conversationId,
      setzen,
    });
  },

  async staendeLaden(conversationId) {
    try {
      const { items } = await api.messages.staende(conversationId);
      set((state) => ({
        staende: { ...state.staende, [conversationId]: staendeAus(items) },
      }));
    } catch {
      /* offline – die Häkchen bleiben, wie sie waren */
    }
  },

  async ladenBis(conversationId, messageId) {
    const liste = () => get().messages[conversationId] ?? [];
    if (liste().some((item) => item.id === messageId)) return true;
    const aelteste = liste().find((item) => !item.pending && !item.id.startsWith('local:'));
    // Neuer als alles Geladene: Der Chat ist noch gar nicht geladen, oder die
    // Nachricht kam eben erst. Die erste Seite reicht dann.
    if (aelteste && messageId > aelteste.id) {
      await get().loadMessages(conversationId, { force: true });
      return liste().some((item) => item.id === messageId);
    }
    try {
      const { items, nextCursor } = await api.messages.bis(
        conversationId,
        messageId,
        aelteste?.id,
      );
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: mergeList(state.messages[conversationId], items),
        },
        hasMore: { ...state.hasMore, [conversationId]: Boolean(nextCursor) && items.length > 0 },
        loaded: aelteste ? state.loaded : { ...state.loaded, [conversationId]: true },
      }));
      void cacheMessages(items);
    } catch {
      return false;
    }
    return liste().some((item) => item.id === messageId);
  },

  markRead(conversationId) {
    // Nur was man sieht, gilt als gelesen: Eine App im Hintergrund (Bildschirm
    // aus) hat die Nachricht nicht gesehen. `beiSichtbarkeitsaenderung` ruft
    // hier wieder an, sobald sie vorn ist.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const list = get().messages[conversationId] ?? [];
    const last = [...list].reverse().find((message) => !message.pending);
    if (!last) return;
    const conversation = get().conversations.find((item) => item.id === conversationId);
    const ungelesen = conversation?.unreadCount ?? 0;
    // Der Zähler allein sagt nicht, ob der Server das Lesen kennt: Kam die
    // Nachricht in den offenen Chat, wurde nie hochgezählt (siehe
    // `ungelesenMitzaehlen`) – gemeldet werden muss sie trotzdem. Eigene
    // Nachrichten als letzte brauchen keine Meldung, der Server zählt sie nie.
    const bekannt = gemeldet.get(conversationId);
    const neuerAlsGemeldet = !bekannt || bekannt < last.id;
    const fremd = last.senderId !== eigeneKennung();
    if (ungelesen === 0 && !(neuerAlsGemeldet && fremd)) return;
    if (ungelesen > 0) {
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversationId ? { ...item, unreadCount: 0, ungeleseneErwaehnungen: 0 } : item,
        ),
      }));
    }
    if (!neuerAlsGemeldet) return;
    gemeldet.set(conversationId, last.id);
    schliesseMitteilungen(conversationId);
    // Über REST statt Socket: Der Socket quittiert nichts, und eine halboffene
    // Leitung (iPhone) verschluckte die Lesemarke – die Liste zeigte die
    // Nachricht beim nächsten Laden wieder als neu. Scheitert die Anfrage,
    // wird beim nächsten Mal erneut gemeldet.
    void api.conversations.markRead(conversationId, last.id).catch(() => {
      if (gemeldet.get(conversationId) === last.id) gemeldet.delete(conversationId);
    });
  },

  setTyping(conversationId, typing, art = 'text') {
    realtime.send({ type: 'typing', payload: { conversationId, typing, art } });
  },

  upsertConversation(roh) {
    const conversation = ungelesenAbgleichen(roh);
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
/** Während eines Durchgangs kam etwas in die Outbox – danach noch einmal. */
let flushNochmal = false;

/**
 * Ein Durchgang durch die Outbox. `false`, wenn er wegen fehlender Verbindung
 * abgebrochen wurde – dann lohnt kein weiterer, bis die Leitung wieder steht.
 */
async function outboxDurchgang(): Promise<boolean> {
  const entries = await readOutbox();
  for (const entry of entries) {
    /*
     * Grosse Anhänge laufen nebenher.
     *
     * Ein Video von zwei Gigabyte braucht auf Mobilfunk eine halbe Stunde. Im
     * selben Durchgang hinge jede danach geschriebene Textnachricht so lange
     * dahinter. Also: grosse Uploads starten und weitergehen; sie melden sich
     * selbst, wenn sie fertig sind. Die Reihenfolge im Chat richtet sich
     * dann nach dem Eintreffen – das Video kommt nach dem Text, der danach
     * geschrieben wurde. Das ist die ehrlichere Wahl als ein Chat, der
     * stillsteht.
     */
    if (istGross(entry)) {
      grossAnstossen(entry);
      continue;
    }
    if ((await eintragSenden(entry)) === 'offline') return false;
  }
  return true;
}

/** Hat diese Nachricht einen Anhang, der in Stücken hochgeht? */
function istGross(entry: OutboxEntry): boolean {
  return entry.pendingAttachments.some(
    (anhang) => (anhang.grosseDatei?.groesse ?? anhang.blob.size) > LIMITS.stueckUploadAb,
  );
}

/** Die grossen Uploads, die gerade laufen – je Nachricht höchstens einer. */
const grossLaeuft = new Set<string>();

function grossAnstossen(entry: OutboxEntry): void {
  const fehlt = entry.pendingAttachments.findIndex((anhang) => anhang.blobFehlt);
  if (fehlt >= 0) {
    const anhang = entry.pendingAttachments[fehlt];
    dateiFehltZeigen(entry, {
      index: fehlt,
      name: anhang.fileName,
      groesse: anhang.grosseDatei?.groesse ?? 0,
    });
    return;
  }
  // Gescheitert (nicht bloss offline) – erst „Erneut senden" startet wieder.
  if (entry.attempts >= 3 || grossLaeuft.has(entry.clientId)) return;
  grossLaeuft.add(entry.clientId);
  void eintragSenden(entry)
    .then((ergebnis) => {
      // Netz weg oder Server nicht erreichbar: Der Upload steht beim Server,
      // wo er stand. In einer halben Minute noch einmal anklopfen – das
      // `online`-Ereignis kommt nicht, wenn das Netz nie ganz weg war.
      if (ergebnis === 'offline') {
        setTimeout(() => void useChat.getState().flushOutbox(), 30_000);
      }
    })
    .finally(() => grossLaeuft.delete(entry.clientId));
}

/**
 * Eine Nachricht der Outbox senden: Anhänge hochladen, dann die Nachricht.
 *
 * `abgebrochen` heisst: Der Mensch hat den Upload abgebrochen, der Eintrag
 * ist schon weg – dann darf er hier auch nicht wieder hineingeschrieben
 * werden.
 */
async function eintragSenden(
  entry: OutboxEntry,
): Promise<'ok' | 'offline' | 'fehler' | 'abgebrochen'> {
  const gross = istGross(entry);
  const abbruch = new AbortController();
  if (gross) hochladeAbbruch.set(entry.clientId, abbruch);
  try {
    const attachmentIds = [...entry.attachmentIds];
    for (const attachment of entry.pendingAttachments) {
      if (attachment.hochgeladenId) {
        attachmentIds.push(attachment.hochgeladenId);
        continue;
      }
      const uploaded = gross
        ? await uploadBlob(attachment, {
            signal: abbruch.signal,
            async onSitzung(sitzungId) {
              if (abbruch.signal.aborted) return;
              attachment.stueckSitzung = sitzungId;
              await updateOutbox(entry);
            },
            onFortschritt: (fortschritt) =>
              useHochladen.getState().setzen(entry.clientId, fortschritt),
          })
        : await uploadBlob(attachment);
      attachmentIds.push(uploaded.id);
      // Jeden fertigen Anhang merken, nicht nur grosse: Scheitert danach die
      // Nachricht selbst (Netz weg, App zu), geht beim Neuversuch nichts
      // noch einmal hoch – vorher entstand bei jedem Versuch ein weiterer
      // Anhang beim Server, von denen nur einer je in die Nachricht kam.
      attachment.hochgeladenId = uploaded.id;
      attachment.stueckSitzung = undefined;
      if (!abbruch.signal.aborted) await updateOutbox(entry);
    }
    if (abbruch.signal.aborted) return 'abgebrochen';
    const message = await api.messages.send(entry.conversationId, {
      type: entry.type,
      body: entry.body,
      replyToId: entry.replyToId,
      metadata: entry.metadata,
      attachmentIds,
      clientId: entry.clientId,
      ...(entry.silent ? { silent: true } : {}),
    });
    // Outbox und Verlauf in einem Zug (siehe `outboxErledigt`).
    await outboxErledigt(entry.clientId, message);
    useChat.getState().applyMessage(message);
    return 'ok';
  } catch (error) {
    if (abbruch.signal.aborted) return 'abgebrochen';
    if (error instanceof Error && error.name === 'DateiFehltError') return 'fehler';
    // Der Server nimmt einen gemerkten Anhang nicht (mehr) an – etwa weil er
    // inzwischen weggeräumt wurde. Dann beim nächsten Versuch neu hochladen,
    // statt dreimal an derselben Kennung zu scheitern. Grosse bleiben: Ihr
    // Neuversand kostet Gigabytes, und die Blase sagt, was los ist.
    if (error instanceof ApiError && error.status === 400 && !gross) {
      for (const anhang of entry.pendingAttachments) anhang.hochgeladenId = undefined;
    }
    const offline =
      error instanceof ApiError &&
      (error.isOffline || (gross && error.status >= 500 && error.status !== 507));
    // Ein grosser Upload, dem das Netz wegbricht, ist nicht gescheitert,
    // sondern unterbrochen – er zählt keinen Fehlversuch und landet nicht
    // nach dreimal Funkloch auf „Senden fehlgeschlagen".
    if (!(gross && offline)) entry.attempts += 1;
    entry.lastError = error instanceof Error ? error.message : 'Senden fehlgeschlagen';
    await updateOutbox(entry);
    if (offline) return 'offline';
    if (entry.attempts >= 3) markFailed(useChat.setState, entry);
    return 'fehler';
  } finally {
    if (gross) {
      if (hochladeAbbruch.get(entry.clientId) === abbruch) hochladeAbbruch.delete(entry.clientId);
      useHochladen.getState().entfernen(entry.clientId);
    }
  }
}

function dateiFehltZeigen(entry: OutboxEntry, fehlt: NonNullable<ChatMessage['dateiFehlt']>): void {
  useChat.setState((state) => ({
    messages: {
      ...state.messages,
      [entry.conversationId]: (state.messages[entry.conversationId] ?? []).map((message) =>
        message.clientId === entry.clientId ? { ...message, dateiFehlt: fehlt } : message,
      ),
    },
  }));
}

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
  return sortMessages(ohneSchatten([...map.values()]));
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
  return sortMessages(ohneSchatten([...nachId.values()]));
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
    dateiFehlt: dateiFehltVon(entry),
  };
}

function dateiFehltVon(entry: OutboxEntry): ChatMessage['dateiFehlt'] {
  const index = entry.pendingAttachments.findIndex((anhang) => anhang.blobFehlt);
  if (index < 0) return undefined;
  const anhang = entry.pendingAttachments[index];
  return { index, name: anhang.fileName, groesse: anhang.grosseDatei?.groesse ?? 0 };
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
    zustellungMelden(neuesteFremde(items));
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

/** Die eigene Kennung – aus dem Zugriffstoken (`sub`), ohne Umweg über die Sitzung. */
function eigeneKennung(): string | null {
  const token = getTokens()?.accessToken;
  const teil = token?.split('.')[1];
  if (!teil) return null;
  try {
    const json = atob(teil.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Bis zu welcher Nachricht hat DIESES Gerät das Lesen gemeldet – je Chat.
 *
 * Die Antwort des Servers auf die Chatliste kann der Meldung zuvorkommen
 * (Nachholen, Rückkehr in den Vordergrund): Sie zählte dann Nachrichten als
 * neu, die man längst auf dem Schirm hatte. `ungelesenAbgleichen` nimmt sie
 * deshalb zurück.
 */
const gemeldet = new Map<string, string>();

/** Mitteilungen dieses Chats vom Gerät nehmen: gelesen, also erledigt. */
function schliesseMitteilungen(conversationId: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) =>
      registration.getNotifications({ tag: `conversation:${conversationId}` }),
    )
    .then((liste) => {
      for (const mitteilung of liste) mitteilung.close();
    })
    .catch(() => {});
}

/**
 * Die Zählregel für Chats, die der Server schon gezählt hat – eine Stelle für
 * Liste, `conversation.updated` und Lesemarken.
 *
 * Gleich wie der Server (`load_conversation_dtos`): Eigene, gelöschte und
 * Nachrichten vor dem Beitritt zählen nicht. Dazu gilt hier, was nur der
 * Client weiss: Was er schon als gelesen gemeldet hat oder gerade vor Augen
 * hat, ist 0 – auch wenn die Antwort des Servers der Meldung zuvorkam.
 */
export function ungelesenAbgleichen(item: ConversationDto): ConversationDto {
  if (item.unreadCount === 0) return item;
  const letzte = item.lastMessage;
  const bekannt = gemeldet.get(item.id);
  const gesehen =
    !letzte || (bekannt !== undefined && bekannt >= letzte.id) || neuesSofortGesehen(item.id);
  return gesehen ? { ...item, unreadCount: 0 } : item;
}

/**
 * Zählt eine live eingetroffene fremde Nachricht als ungelesen.
 *
 * Vorher setzte `applyMessage` nur die Vorschau; der Zähler kam allein aus der
 * Chatliste des Servers. Wer die Liste offen hatte, sah die neue Antwort in
 * der Vorschau, aber keinen (oder einen veralteten) Ungelesen-Zähler – bis
 * zum nächsten Laden. Gezählt wird wie auf dem Server: alles, was nicht von
 * mir ist, auch Systemzeilen. Ist der Chat offen und unten, setzt
 * `markRead` den Zähler sofort zurück und meldet das Lesen – vorher blieb das
 * aus, weil der Zähler schon 0 war.
 */
function ungelesenMitzaehlen(message: MessageDto): void {
  const ich = eigeneKennung();
  if (!ich || message.senderId === ich || message.deletedAt) return;
  const { conversations, messages } = useChat.getState();
  const gespraech = conversations.find((item) => item.id === message.conversationId);
  if (!gespraech) return;
  // UUIDv7: lexikalisch = zeitlich. Schon Bekanntes zählt nicht doppelt.
  if (gespraech.lastMessage && gespraech.lastMessage.id >= message.id) return;
  if ((messages[message.conversationId] ?? []).some((item) => item.id === message.id)) return;
  // Chat offen, sichtbar und unten: die Nachricht ist schon gelesen. Kein
  // Hochzählen (die Liste hinter dem Chat soll gar nicht erst aufblitzen);
  // gemeldet wird sie von `markRead`, sobald der Chat sie zeigt.
  if (neuesSofortGesehen(message.conversationId)) return;
  // Erwähnt mich die Nachricht (oder alle), zählt sie auch für das „@“.
  const erwaehnt =
    message.metadata?.mentionsAlle === true || (message.metadata?.mentions ?? []).includes(ich);
  useChat.setState((state) => ({
    conversations: state.conversations.map((item) =>
      item.id === message.conversationId
        ? {
            ...item,
            unreadCount: item.unreadCount + 1,
            ...(erwaehnt ? { ungeleseneErwaehnungen: (item.ungeleseneErwaehnungen ?? 0) + 1 } : {}),
          }
        : item,
    ),
  }));
}

/* ---------- Häkchen: Stände ---------- */

function staendeAus(items: StandDto[]): Staende {
  const aus: Staende = {};
  for (const item of items) aus[item.userId] = { gelesen: item.gelesen, zugestellt: item.zugestellt };
  return aus;
}

/** Ein Stand rückt vor – nie zurück (UUIDv7, zeitlich sortiert). */
function standVorruecken(
  conversationId: string,
  userId: string,
  art: 'gelesen' | 'zugestellt',
  messageId: string,
): void {
  useChat.setState((state) => {
    const chat = state.staende[conversationId];
    // Nur Chats, deren Stände geladen sind: Ein einzelner Stand ohne die
    // übrigen liesse eine Gruppe „von allen gelesen“ aussehen.
    if (!chat) return {};
    const bisher = chat[userId] ?? { gelesen: null, zugestellt: null };
    if (bisher[art] && bisher[art] >= messageId) return {};
    return {
      staende: {
        ...state.staende,
        [conversationId]: { ...chat, [userId]: { ...bisher, [art]: messageId } },
      },
    };
  });
}

/**
 * Die eigene Kennung, ohne je zu werfen: Die Zustellmeldung ist eine
 * Nebensache und darf das Laden eines Chats nie aufhalten.
 */
function kennungOderNull(): string | null {
  try {
    return eigeneKennung();
  } catch {
    return null;
  }
}

/** Die neueste Nachricht, die nicht von mir ist. */
function neuesteFremde(items: readonly MessageDto[]): MessageDto | null {
  const ich = kennungOderNull();
  if (!ich) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.senderId && item.senderId !== ich) return item;
  }
  return null;
}

/** Eine fremde, angekommene Nachricht als „zugestellt“ vormerken. */
function zustellungMelden(message: MessageDto | null | undefined): void {
  if (!message || !message.senderId || message.deletedAt) return;
  const ich = kennungOderNull();
  if (!ich || message.senderId === ich) return;
  zustellungVormerken(message.conversationId, message.id);
}

/* ---------- Aktionswarteschlange (siehe `state/aktionen.ts`) ---------- */

let aktionenLaufen = false;
let aktionenNochmal = false;

function aktionenSpeichern(): void {
  try {
    void writeMeta(AKTIONEN_META, ausstehendeAktionen).catch(() => {});
  } catch {
    /* ohne Speicher: nur im Arbeitsspeicher */
  }
}

/** Die Listen der betroffenen Chats neu überlagern. */
function neuUeberlagern(conversationIds: Iterable<string>): void {
  useChat.setState((state) => {
    const messages = { ...state.messages };
    for (const id of conversationIds) {
      if (messages[id]) messages[id] = sortMessages(messages[id]);
    }
    return { messages };
  });
}

/**
 * Eine Änderung einreihen: sofort sichtbar, dann zum Server. Kehrt erst
 * zurück, wenn der Versuch gelaufen ist – Fehler, die nicht am Netz liegen,
 * kommen beim Aufrufer an (er zeigt sie).
 */
export async function aktionEinreihen(aktion: Aktion): Promise<void> {
  ausstehendeAktionen = einreihen(ausstehendeAktionen, aktion);
  aktionenSpeichern();
  neuUeberlagern([aktion.conversationId]);
  await aktionenAbarbeiten();
  const fehler = aktionsFehler.get(aktion.messageId);
  if (fehler) {
    aktionsFehler.delete(aktion.messageId);
    throw fehler;
  }
}

/** Gescheiterte (nicht offline) Aktionen je Nachricht, für den Aufrufer. */
const aktionsFehler = new Map<string, unknown>();

export async function aktionenAbarbeiten(): Promise<void> {
  if (aktionenLaufen) {
    aktionenNochmal = true;
    return;
  }
  aktionenLaufen = true;
  try {
    do {
      aktionenNochmal = false;
      for (const eintrag of [...ausstehendeAktionen]) {
        if (!ausstehendeAktionen.includes(eintrag)) continue;
        try {
          await aktionSenden(eintrag.aktion);
        } catch (error) {
          if (error instanceof ApiError && error.isOffline) return;
          // Der Server lehnt ab (kein Recht mehr, gelöscht …): nicht ewig
          // wiederholen. Die Ansicht holt den wahren Stand.
          aktionsFehler.set(eintrag.aktion.messageId, error);
          aktionEntfernen(eintrag);
          void useChat.getState().loadMessages(eintrag.aktion.conversationId, { force: true });
          if (eintrag.aktion.art === 'stern') void sterneLaden();
          continue;
        }
        aktionEntfernen(eintrag);
      }
    } while (aktionenNochmal);
  } finally {
    aktionenLaufen = false;
  }
}

function aktionEntfernen(eintrag: AktionsEintrag): void {
  ausstehendeAktionen = ausstehendeAktionen.filter((item) => item !== eintrag);
  aktionenSpeichern();
}

async function aktionSenden(aktion: Aktion): Promise<void> {
  switch (aktion.art) {
    case 'bearbeiten': {
      const neu = await api.messages.edit(aktion.messageId, aktion.body, aktion.mentions);
      // Erst aus der Warteschlange, dann anwenden – sonst überlagerte die
      // ausstehende Fassung die bestätigte.
      ausstehendeAktionen = ausstehendeAktionen.filter((item) => item.aktion !== aktion);
      useChat.getState().applyMessage(neu);
      return;
    }
    case 'loeschen':
      await api.messages.remove(aktion.messageId, aktion.scope);
      void dropCachedMessage(aktion.messageId);
      return;
    case 'reaktion': {
      const ergebnis = aktion.setzen
        ? await api.messages.react(aktion.messageId, aktion.emoji)
        : await api.messages.unreact(aktion.messageId, aktion.emoji);
      ausstehendeAktionen = ausstehendeAktionen.filter((item) => item.aktion !== aktion);
      applyReactions(useChat.setState, aktion.conversationId, aktion.messageId, ergebnis.reactions);
      return;
    }
    case 'stern':
      if (aktion.setzen) await api.messages.sternSetzen(aktion.messageId);
      else await api.messages.sternEntfernen(aktion.messageId);
      return;
  }
}

/** Nur für Tests: die Warteschlange leeren. */
export function aktionenZuruecksetzen(): void {
  ausstehendeAktionen = [];
  aktionsFehler.clear();
}

/** Nur für Tests: was gerade aussteht. */
export function ausstehend(): readonly AktionsEintrag[] {
  return ausstehendeAktionen;
}

/** Wire realtime events into the store exactly once. */
let wired = false;
/** Wie oft höchstens nachgeholt wird – siehe `gedrosselt`. */
const NACHHOL_FENSTER_MS = 2_000;
/**
 * Chatliste und jeden schon geladenen Chat auf den Stand des Servers bringen.
 *
 * Für Hinweise ohne Chat und Termin (der Server hat den Rundruf-Bus neu
 * verbunden und weiß nicht, was dazwischen verloren ging) und nach einer
 * abgerissenen Leitung. Je geladenem Chat die neueste Seite – wie bei einem
 * Hinweis mit Chat-Kennung –, damit auch Bearbeitungen und Löschungen
 * ankommen, nicht nur neue Nachrichten. Nie geöffnete Chats laden ohnehin
 * frisch, wenn man sie öffnet.
 */
export function chatsNachholen(): void {
  const state = useChat.getState();
  void state.loadConversations();
  void entwuerfeAbgleichen();
  void sterneLaden();
  void aktionenAbarbeiten();
  // Die Häkchen offener Chats: Lese- und Zustellmeldungen in der Lücke kamen
  // nie an.
  for (const conversationId of Object.keys(state.staende)) void state.staendeLaden(conversationId);
  for (const [conversationId, geladen] of Object.entries(state.loaded)) {
    if (geladen) void state.loadMessages(conversationId, { force: true });
  }
}

export function connectChatRealtime(): void {
  if (wired) return;
  wired = true;

  // Termin-Karten stehen in vielen Chats, auch in nie geöffneten: Jede Änderung
  // des Termins führt sie alle nach – nicht nur die Karte, die gerade offen ist.
  connectTerminEreignisse();
  sichtbarkeitVerdrahten();
  // Zurück im Vordergrund oder Chat gewechselt: Was jetzt vor Augen liegt, gilt
  // als gelesen (`markRead` prüft selbst, ob die App sichtbar ist).
  beiSichtbarkeitsaenderung(() => {
    const offen = chatVorAugen();
    if (offen && neuesSofortGesehen(offen)) useChat.getState().markRead(offen);
  });
  aufTerminEreignisse({
    aktualisiert: terminAbgleichen,
    entfernt: terminEntfernt,
    nachholen: kartenNachholen,
  });

  /*
   * Alle Wege des Nachholens laufen durch EINE Drossel: Zurückkommen,
   * Wiederverbinden und eine eingetroffene Mitteilung fallen auf dem iPhone
   * fast immer zusammen. Ohne Drossel lüde die Liste dreimal; mit ihr einmal
   * sofort und einmal am Ende des Fensters (für das, was zwischen erstem
   * Laden und neuer Leitung geschah).
   */
  const nachholen = gedrosselt(() => {
    if (getTokens()) chatsNachholen();
  }, NACHHOL_FENSTER_MS);

  realtime.on('message.new', ({ message }) => {
    ungelesenMitzaehlen(message);
    zustellungMelden(message);
    useChat.getState().applyMessage(message);
    // Eine Nachricht in einem Chat, den die Liste noch nicht kennt (gerade
    // erst angelegt, in der Lücke dazugekommen): ohne Nachholen erschiene er
    // erst beim nächsten Neuladen.
    if (!useChat.getState().conversations.some((item) => item.id === message.conversationId)) {
      nachholen();
    }
  });
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
  realtime.on('typing', ({ conversationId, userId, until, art }) => {
    const expires = new Date(until).getTime();
    useChat.setState((state) => {
      const current = (state.typing[conversationId] ?? []).filter(
        (entry) => entry.userId !== userId && entry.until > Date.now(),
      );
      if (expires > Date.now()) {
        current.push({ userId, until: expires, art: art === 'audio' ? 'audio' : 'text' });
      }
      return { typing: { ...state.typing, [conversationId]: current } };
    });
  });
  realtime.on('presence', ({ userId, online, lastSeenAt }) => {
    useChat.setState((state) => ({
      presence: { ...state.presence, [userId]: { online, lastSeenAt } },
    }));
  });
  realtime.on('read.updated', ({ conversationId, userId, lastReadMessageId }) => {
    const ich = eigeneKennung();
    // Ich selbst habe gelesen – auf diesem oder einem anderen Gerät: Dann ist
    // hier alles bis dahin erledigt, der Zähler fällt, und die Mitteilung zu
    // diesem Chat verschwindet.
    const selbst = ich !== null && userId === ich;
    standVorruecken(conversationId, userId, 'gelesen', lastReadMessageId);
    useChat.setState((state) => ({
      conversations: state.conversations.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        const naechste = {
          ...conversation,
          members: conversation.members.map((member) =>
            member.userId === userId ? { ...member, lastReadMessageId } : member,
          ),
        };
        if (
          selbst &&
          (!conversation.lastMessage || conversation.lastMessage.id <= lastReadMessageId)
        ) {
          return { ...naechste, unreadCount: 0 };
        }
        return naechste;
      }),
    }));
    if (selbst) {
      const bekannt = gemeldet.get(conversationId);
      if (!bekannt || bekannt < lastReadMessageId) gemeldet.set(conversationId, lastReadMessageId);
      const gespraech = useChat.getState().conversations.find((item) => item.id === conversationId);
      if (!gespraech?.lastMessage || gespraech.lastMessage.id <= lastReadMessageId) {
        schliesseMitteilungen(conversationId);
      } else if (gespraech.unreadCount > 0) {
        // Gelesen bis mitten im Chat: wie viel noch offen ist, weiss der Server.
        nachholen();
      }
    }
  });
  realtime.on('delivery.updated', ({ conversationId, userId, deliveredMessageId }) => {
    standVorruecken(conversationId, userId, 'zugestellt', deliveredMessageId);
  });
  realtime.on('star.updated', ({ messageId, starred }) => sternSetzenLokal(messageId, starred));
  realtime.on('draft.updated', ({ draft }) => entwurfVomServer(draft));
  realtime.on('sync.hint', ({ conversationId, eventId }) => {
    if (conversationId) void useChat.getState().loadMessages(conversationId, { force: true });
    // Ein Hinweis auf einen Termin gehört dem Trichter (`terminEreignisse`); die
    // Chats müssen dafür nicht neu geladen werden.
    else if (!eventId) chatsNachholen();
  });
  // Reißt die Leitung ab – Funkloch, oder der Server schließt sie, weil sein
  // Ausgangspuffer voll war –, gehen die Ereignisse dazwischen verloren. Beim
  // Wiederverbinden wird nachgeholt, wie es `terminEreignisse` für Termine tut.
  let warWeg = false;
  realtime.onStateChange((state) => {
    if (state === 'offline') warWeg = true;
    if (state !== 'online') return;
    void useChat.getState().flushOutbox();
    void aktionenAbarbeiten();
    if (warWeg) {
      warWeg = false;
      nachholen();
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void useChat.getState().flushOutbox();
      void aktionenAbarbeiten();
    });

    /*
     * Zurück im Vordergrund: Chatliste und offene Chats nachholen – unabhängig
     * davon, ob die Leitung überlebt hat.
     *
     * Vorher hing das Nachholen allein am Zustandswechsel der Leitung. Auf
     * dem iPhone stirbt sie beim Einfrieren aber ohne `close`, der Zustand
     * blieb „online“, und die Chatliste zeigte nach der Rückkehr nicht, dass
     * jemand geantwortet hatte – bis zum nächsten Neuladen.
     */
    beiRueckkehr(nachholen);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        const art = (event.data as { type?: string } | undefined)?.type;
        // Eine Mitteilung ist eingetroffen: Es gibt Neues, und die Leitung hat
        // es womöglich nicht gebracht (eingefroren, oder gerade erst wach).
        if (art === 'push') nachholen();
        // Der Browser hat das Push-Abo ausgetauscht; der Service Worker kann
        // es ohne Zugriffstoken nicht selbst anmelden.
        if (art === 'push-abo-geaendert') void aboAuffrischen();
      });
      // Einmal je Sitzung: ein Abo, das an einen alten Server-Schlüssel gebunden
      // ist oder dem Server verloren ging, wieder in Ordnung bringen.
      void aboAuffrischen();
    }
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
