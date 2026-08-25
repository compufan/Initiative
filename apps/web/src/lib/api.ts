import type {
  ApiErrorBody,
  AttachmentDto,
  AuthSession,
  AuthTokens,
  AddCollectionItemInput,
  CalendarEventDto,
  CollectionDto,
  CollectionGrantDto,
  CollectionItemDto,
  ConversationDto,
  CreateCollectionInput,
  CreateExpenseInput,
  CreatePlanningInput,
  CreateUploadResult,
  BalanceDto,
  EventAttachmentDto,
  EventNoteDto,
  EventNoteInput,
  GameInfoDto,
  GameSessionDto,
  GrantCollectionInput,
  MessageDto,
  ExpenseDto,
  PaymentProfileDto,
  PaymentProfileInput,
  PollDto,
  SelfUserDto,
  StickerPackDto,
  UpdateCollectionInput,
  UpdateCollectionItemInput,
  UserDto,
} from '@initiative/shared';
import { API_PREFIX } from '@initiative/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

type TokenListener = (tokens: StoredTokens | null) => void;

const TOKEN_KEY = 'initiative.tokens';

/** Base URL of the API. Empty string keeps everything same-origin (dev proxy,
 *  single-domain deployments); set VITE_API_URL when API and PWA are split. */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

let tokens: StoredTokens | null = readTokens();
const listeners = new Set<TokenListener>();

export function getTokens(): StoredTokens | null {
  return tokens;
}

export function setTokens(next: AuthTokens | null): StoredTokens | null {
  tokens = next
    ? {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: Date.now() + next.expiresIn * 1000,
      }
    : null;
  try {
    if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode – tokens stay in memory */
  }
  for (const listener of listeners) listener(tokens);
  return tokens;
}

export function onTokenChange(listener: TokenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Übernimmt eine Rotation, die ein anderer Tab vorgenommen hat.
 *
 * Der Server verbrennt bei jedem Refresh den alten Token. Ohne diesen Abgleich
 * würde ein zweiter Tab weiter mit dem verbrannten Token arbeiten, eine 401
 * kassieren und die Sitzung wegwerfen – obwohl nebenan längst ein gültiger
 * Token liegt.
 */
function adoptStoredTokens(): StoredTokens | null {
  const stored = readTokens();
  if (stored && stored.refreshToken !== tokens?.refreshToken) {
    tokens = stored;
    for (const listener of listeners) listener(tokens);
  }
  return tokens;
}

if (typeof window !== 'undefined') {
  // Ein anderer Tab hat die Token erneuert oder sich abgemeldet.
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_KEY) return;
    const next = readTokens();
    if (next?.refreshToken === tokens?.refreshToken) return;
    tokens = next;
    for (const listener of listeners) listener(tokens);
  });
}

let refreshInFlight: Promise<StoredTokens | null> | null = null;

async function refreshTokens(): Promise<StoredTokens | null> {
  // Erst nachsehen, ob ein anderer Tab schon erneuert hat.
  const current = adoptStoredTokens();
  if (!current) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${API_BASE}${API_PREFIX}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        if (!response.ok) {
          // Abgelehnt heißt nicht zwangsläufig „abgemeldet“: Zwischen Lesen und
          // Senden kann ein anderer Tab rotiert haben. Nur wegwerfen, wenn im
          // Speicher wirklich nichts Neueres steht.
          const stored = readTokens();
          if (stored && stored.refreshToken !== current.refreshToken) {
            tokens = stored;
            for (const listener of listeners) listener(tokens);
            return tokens;
          }
          setTokens(null);
          return null;
        }
        const session = (await response.json()) as AuthSession;
        return setTokens(session);
      } catch {
        // Netzwerkfehler: Die Sitzung bleibt bestehen, es wird später erneut versucht.
        return current;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Gültiges Zugriffstoken, notfalls frisch geholt. Für den WebSocket. */
export async function validAccessToken(): Promise<string | null> {
  const current = adoptStoredTokens();
  if (!current) return null;
  if (current.expiresAt - Date.now() >= 30_000) return current.accessToken;
  return (await refreshTokens())?.accessToken ?? null;
}

/** Erzwingt eine Erneuerung, etwa wenn der WebSocket mit 4401 abgewiesen wurde. */
export async function forceRefresh(): Promise<StoredTokens | null> {
  return refreshTokens();
}

/**
 * Nach dieser Zeit gilt eine Anfrage als gescheitert.
 *
 * Ohne Zeitlimit haengt ein `fetch` potenziell unbegrenzt. Antwortete die API
 * nicht mehr, lud die App deshalb ewig, statt auf den Zwischenspeicher
 * zurueckzufallen und "nicht erreichbar" zu melden.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** Verbindet das eigene Zeitlimit mit einem ggf. uebergebenen Abbruchsignal. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  // `any` gibt es noch nicht ueberall; dann gilt das Zeitlimit allein.
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the Authorization header (login, register, public key …). */
  anonymous?: boolean;
  raw?: boolean;
  /** Pfad liegt auf der Wurzel, nicht unter `/api/v1` (etwa `/healthz`). */
  root?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query'], root = false): string {
  const url = `${API_BASE}${root || path.startsWith('/api') ? '' : API_PREFIX}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const send = async (accessToken: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['content-type'] = 'application/json';
    }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    return fetch(buildUrl(path, options.query, options.root), {
      method,
      headers,
      signal: withTimeout(options.signal),
      body:
        options.body === undefined
          ? undefined
          : options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
    });
  };

  let accessToken: string | null = null;
  if (!options.anonymous) {
    let current = adoptStoredTokens();
    if (current && current.expiresAt - Date.now() < 30_000) current = await refreshTokens();
    accessToken = current?.accessToken ?? null;
  }

  let response: Response;
  try {
    response = await send(accessToken);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw new ApiError(
      0,
      'offline',
      timedOut ? 'Der Server antwortet nicht' : 'Keine Verbindung zum Server',
      error,
    );
  }

  if (response.status === 401 && !options.anonymous && tokens) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      try {
        response = await send(refreshed.accessToken);
      } catch (error) {
        throw new ApiError(0, 'offline', 'Keine Verbindung zum Server', error);
      }
    }
  }

  if (!response.ok) {
    let payload: ApiErrorBody | null = null;
    try {
      payload = (await response.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'request_failed',
      payload?.error?.message ?? `Anfrage fehlgeschlagen (${response.status})`,
      payload?.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  if (options.raw) return (await response.blob()) as T;
  return (await response.json()) as T;
}

const get = <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options);
const post = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>('POST', path, { ...options, body });
const patch = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>('PATCH', path, { ...options, body });
const put = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>('PUT', path, { ...options, body });
const del = <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options);

interface ListResult<T> {
  items: T[];
  nextCursor?: string | null;
}

/**
 * Typed client for the whole API. Feature modules import `api` instead of
 * hand-rolling fetch calls, which keeps the contract in exactly one place.
 */
export const api = {
  /** Zustand der API samt Commit-Kennung des laufenden Stands. */
  health: () => request<HealthDto>('GET', '/healthz', { anonymous: true, root: true }),
  auth: {
    register: (body: {
      username: string;
      password: string;
      displayName: string;
      inviteCode?: string;
    }) => post<AuthSession>('/auth/register', body, { anonymous: true }),
    login: (body: { username: string; password: string }) =>
      post<AuthSession>('/auth/login', body, { anonymous: true }),
    logout: (refreshToken: string) => post<void>('/auth/logout', { refreshToken }),
    me: () => get<SelfUserDto>('/auth/me'),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      post<void>('/auth/password', body),
    rotateCalendarToken: () => post<{ calendarToken: string }>('/auth/calendar-token/rotate'),
  },
  users: {
    search: (q: string, limit = 20) => get<ListResult<UserDto>>('/users', { query: { q, limit } }),
    byId: (id: string) => get<UserDto>(`/users/${id}`),
    /**
     * Mehrere auf einmal. Eine Liste mit acht Beteiligten war vorher acht
     * Anfragen – siehe state/leute.ts.
     */
    batch: (ids: string[]) =>
      get<ListResult<UserDto>>('/users/batch', { query: { ids: ids.join(',') } }),
    updateMe: (body: Record<string, unknown>) => patch<SelfUserDto>('/users/me', body),
    /** Auskunft und Mitnahme (Art. 15 und 20 DSGVO). */
    export: () => get<Record<string, unknown>>('/users/me/export'),
    /** Das eigene Konto loeschen (Art. 17 DSGVO). Passwort als Gegenprobe. */
    remove: (password: string) => del<void>('/users/me', { body: { password } }),
  },
  conversations: {
    list: (archived = false) =>
      get<ListResult<ConversationDto>>('/conversations', { query: { archived } }),
    create: (body: { type: 'direct' | 'group'; memberIds: string[]; title?: string }) =>
      post<ConversationDto>('/conversations', body),
    byId: (id: string) => get<ConversationDto>(`/conversations/${id}`),
    update: (id: string, body: Record<string, unknown>) =>
      patch<ConversationDto>(`/conversations/${id}`, body),
    addMembers: (id: string, memberIds: string[]) =>
      post<ConversationDto>(`/conversations/${id}/members`, { memberIds }),
    updateMember: (id: string, userId: string, body: Record<string, unknown>) =>
      patch<ConversationDto>(`/conversations/${id}/members/${userId}`, body),
    removeMember: (id: string, userId: string) =>
      del<void>(`/conversations/${id}/members/${userId}`),
    markRead: (id: string, messageId: string) =>
      post<{ ok: boolean }>(`/conversations/${id}/read`, { messageId }),
  },
  messages: {
    list: (
      conversationId: string,
      query: { before?: string; after?: string; limit?: number } = {},
    ) => get<ListResult<MessageDto>>(`/conversations/${conversationId}/messages`, { query }),
    send: (conversationId: string, body: Record<string, unknown>) =>
      post<MessageDto>(`/conversations/${conversationId}/messages`, body),
    byId: (id: string) => get<MessageDto>(`/messages/${id}`),
    edit: (id: string, body: string) => patch<MessageDto>(`/messages/${id}`, { body }),
    /**
     * `me` nimmt die Nachricht nur aus dem eigenen Verlauf, `all` bei allen.
     * Fuer alle loeschen geht nur bei eigenen Nachrichten (oder als Verwalter).
     */
    remove: (id: string, scope: 'me' | 'all' = 'all') =>
      del<void>(`/messages/${id}`, { query: { scope } }),
    react: (id: string, emoji: string) =>
      put<{ reactions: MessageDto['reactions'] }>(`/messages/${id}/reactions`, { emoji }),
    unreact: (id: string, emoji: string) =>
      del<{ reactions: MessageDto['reactions'] }>(`/messages/${id}/reactions`, {
        query: { emoji },
      }),
    search: (q: string, conversationId?: string) =>
      get<ListResult<MessageDto>>('/search/messages', { query: { q, conversationId } }),
  },
  media: {
    createUpload: (body: { kind: string; mime: string; size: number; fileName?: string }) =>
      post<CreateUploadResult>('/media/uploads', body),
    completeUpload: (id: string, body: Record<string, unknown>) =>
      post<AttachmentDto>(`/media/uploads/${id}/complete`, body),
    uploadData: (id: string, file: Blob, fileName?: string) => {
      const form = new FormData();
      form.append('file', file, fileName ?? 'upload');
      return post<AttachmentDto>(`/media/uploads/${id}/data`, form);
    },
    url: (attachmentId: string) => `${API_BASE}${API_PREFIX}/media/${attachmentId}`,
  },
  stickers: {
    packs: () => get<ListResult<StickerPackDto>>('/stickers/packs'),
    createPack: (body: { name: string; isPublic?: boolean }) =>
      post<StickerPackDto>('/stickers/packs', body),
    updatePack: (id: string, body: Record<string, unknown>) =>
      patch<StickerPackDto>(`/stickers/packs/${id}`, body),
    deletePack: (id: string) => del<void>(`/stickers/packs/${id}`),
    addSticker: (packId: string, body: { attachmentId: string; emoji?: string | null }) =>
      post<StickerPackDto>(`/stickers/packs/${packId}/stickers`, body),
    removeSticker: (packId: string, stickerId: string) =>
      del<void>(`/stickers/packs/${packId}/stickers/${stickerId}`),
    install: (packId: string) => post<StickerPackDto>(`/stickers/packs/${packId}/install`),
    uninstall: (packId: string) => del<void>(`/stickers/packs/${packId}/install`),
    discover: (q?: string) =>
      get<ListResult<StickerPackDto>>('/stickers/discover', { query: { q } }),
  },
  collections: {
    /**
     * Alle Sammlungen, die ich mindestens ansehen darf – als flache Liste.
     * Den Baum baut `buildCollectionTree` daraus; so kommt jede Sammlung
     * genau einmal über die Leitung.
     */
    list: () => get<ListResult<CollectionDto>>('/collections'),
    byId: (id: string) => get<CollectionDto>(`/collections/${id}`),
    create: (body: CreateCollectionInput) => post<CollectionDto>('/collections', body),
    update: (id: string, body: UpdateCollectionInput) =>
      patch<CollectionDto>(`/collections/${id}`, body),
    remove: (id: string) => del<void>(`/collections/${id}`),

    items: (id: string) => get<ListResult<CollectionItemDto>>(`/collections/${id}/items`),
    addItem: (id: string, body: AddCollectionItemInput) =>
      post<CollectionItemDto>(`/collections/${id}/items`, body),
    updateItem: (id: string, itemId: string, body: UpdateCollectionItemInput) =>
      patch<void>(`/collections/${id}/items/${itemId}`, body),
    removeItem: (id: string, itemId: string) => del<void>(`/collections/${id}/items/${itemId}`),

    grants: (id: string) => get<ListResult<CollectionGrantDto>>(`/collections/${id}/grants`),
    grant: (id: string, body: GrantCollectionInput) =>
      post<CollectionGrantDto>(`/collections/${id}/grants`, body),
    revoke: (id: string, grantId: string) => del<void>(`/collections/${id}/grants/${grantId}`),
    grantItem: (itemId: string, body: GrantCollectionInput) =>
      post<CollectionGrantDto>(`/collections/items/${itemId}/grants`, body),
  },
  calendar: {
    events: (query: { from?: string; to?: string; conversationId?: string } = {}) =>
      get<ListResult<CalendarEventDto>>('/calendar/events', { query }),
    create: (body: Record<string, unknown>) => post<CalendarEventDto>('/calendar/events', body),
    update: (id: string, body: Record<string, unknown>) =>
      patch<CalendarEventDto>(`/calendar/events/${id}`, body),
    remove: (id: string) => del<void>(`/calendar/events/${id}`),
    rsvp: (id: string, status: 'yes' | 'no' | 'maybe' | 'pending') =>
      post<CalendarEventDto>(`/calendar/events/${id}/rsvp`, { status }),
    /** Nachtraeglich einladen – die Liste wird ergaenzt, nicht ersetzt. */
    invite: (id: string, attendeeIds: string[]) =>
      patch<CalendarEventDto>(`/calendar/events/${id}`, { attendeeIds }),
    /** Und wieder ausladen. Nur wer den Termin verwaltet. */
    uninvite: (id: string, userId: string) =>
      del<CalendarEventDto>(`/calendar/events/${id}/attendees/${userId}`),
    byId: (id: string) => get<CalendarEventDto>(`/calendar/events/${id}`),
    icsUrl: (calendarToken: string) =>
      `${API_BASE}${API_PREFIX}/calendar/${calendarToken}/feed.ics`,
    eventIcsUrl: (id: string) => `${API_BASE}${API_PREFIX}/calendar/events/${id}/event.ics`,

    /** Ein Termin, dessen Zeitpunkt noch abgestimmt wird. */
    plan: (body: CreatePlanningInput) => post<CalendarEventDto>('/calendar/planning', body),
    /**
     * Legt den Zeitpunkt fest. Ohne `optionId` gewinnt der beste Vorschlag.
     * Es entsteht kein zweiter Termin – der bestehende rückt an seinen Platz.
     */
    confirm: (id: string, body: { optionId?: string; closePoll?: boolean } = {}) =>
      post<CalendarEventDto>(`/calendar/events/${id}/confirm`, body),

    notes: (id: string) => get<ListResult<EventNoteDto>>(`/calendar/events/${id}/notes`),
    addNote: (id: string, body: EventNoteInput) =>
      post<EventNoteDto>(`/calendar/events/${id}/notes`, body),
    updateNote: (id: string, noteId: string, body: Partial<EventNoteInput> & { position?: number }) =>
      patch<EventNoteDto>(`/calendar/events/${id}/notes/${noteId}`, body),
    removeNote: (id: string, noteId: string) =>
      del<void>(`/calendar/events/${id}/notes/${noteId}`),

    documents: (id: string) =>
      get<ListResult<EventAttachmentDto>>(`/calendar/events/${id}/documents`),
    addDocument: (id: string, body: { attachmentId: string; title?: string }) =>
      post<EventAttachmentDto>(`/calendar/events/${id}/documents`, body),
    removeDocument: (id: string, documentId: string) =>
      del<void>(`/calendar/events/${id}/documents/${documentId}`),

    /** Hängt eine Sammlung an den Termin – `null` löst die Verknüpfung. */
    /* --- Listen in Notizen ------------------------------------------- */
    /** Einen Punkt zur Liste hinzufügen. */
    addNoteItem: (
      eventId: string,
      noteId: string,
      body: { text: string; requiredChecks?: number; requiredAll?: boolean },
    ) => post<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items`, body),
    updateNoteItem: (
      eventId: string,
      noteId: string,
      itemId: string,
      body: { text?: string; requiredChecks?: number; requiredAll?: boolean; position?: number },
    ) => patch<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items/${itemId}`, body),
    removeNoteItem: (eventId: string, noteId: string, itemId: string) =>
      del<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items/${itemId}`),
    /** Abhaken oder den Haken wegnehmen. Ohne `checked` wird umgeschaltet. */
    checkNoteItem: (eventId: string, noteId: string, itemId: string, checked?: boolean) =>
      post<EventNoteDto>(
        `/calendar/events/${eventId}/notes/${noteId}/items/${itemId}/check`,
        { checked },
      ),

    linkCollection: (id: string, collectionId: string | null) =>
      patch<CalendarEventDto>(`/calendar/events/${id}/collection`, { collectionId }),
  },
  polls: {
    create: (body: Record<string, unknown>) => post<PollDto>('/polls', body),
    byId: (id: string) => get<PollDto>(`/polls/${id}`),
    vote: (id: string, votes: { optionId: string; value?: 'yes' | 'no' | 'maybe' }[]) =>
      post<PollDto>(`/polls/${id}/vote`, { votes }),
    addOption: (id: string, body: { label?: string; startsAt?: string; endsAt?: string }) =>
      post<PollDto>(`/polls/${id}/options`, body),
    close: (id: string) => post<PollDto>(`/polls/${id}/close`),
    reopen: (id: string) => post<PollDto>(`/polls/${id}/reopen`),
    createEvent: (id: string, body: Record<string, unknown>) =>
      post<CalendarEventDto>(`/polls/${id}/event`, body),

    /** In welchen Chats dieselbe Umfrage steht – ein Ergebnis für alle. */
    placements: (id: string) =>
      get<{
        originConversationId: string;
        conversationIds: string[];
        items: {
          id: string;
          conversationId: string;
          messageId: string | null;
          createdBy: string | null;
          createdAt: string;
        }[];
      }>(`/polls/${id}/placements`),
    place: (id: string, conversationId: string) =>
      post<{ id?: string; conversationId?: string; alreadyThere?: boolean }>(
        `/polls/${id}/placements`,
        { conversationId },
      ),
    unplace: (id: string, placementId: string) =>
      del<void>(`/polls/${id}/placements/${placementId}`),
  },
  expenses: {
    list: (query: { conversationId?: string; eventId?: string; includeSettled?: boolean } = {}) =>
      get<ListResult<ExpenseDto>>('/expenses', { query }),
    byId: (id: string) => get<ExpenseDto>(`/expenses/${id}`),
    create: (body: CreateExpenseInput) => post<ExpenseDto>('/expenses', body),
    update: (id: string, body: Record<string, unknown>) => patch<ExpenseDto>(`/expenses/${id}`, body),
    remove: (id: string) => del<void>(`/expenses/${id}`),
    /** Einen Anteil abhaken. Ohne `userId`: den eigenen. */
    settle: (id: string, body: { userId?: string; settled?: boolean } = {}) =>
      post<ExpenseDto>(`/expenses/${id}/settle`, body),

    /**
     * Alles abhaken, was zwischen mir und einer Person offen ist – in beiden
     * Richtungen. Wer die angezeigte Summe überweist, will einmal bestätigen,
     * nicht an jeder Ausgabe einzeln.
     */
    settleUp: (userId: string, settled = true) =>
      post<{ count: number; amountCents: number }>('/expenses/settle-up', { userId, settled }),

    /** Wer schuldet mir was – und was schulde ich. */
    balances: (conversationId?: string) =>
      get<ListResult<BalanceDto>>('/expenses/balances', { query: { conversationId } }),

    /** Vor dieser Person verbergen – geht nur, wenn sie keinen Anteil trägt. */
    hide: (id: string, userId: string) => post<ExpenseDto>(`/expenses/${id}/hidden/${userId}`),
    unhide: (id: string, userId: string) => del<ExpenseDto>(`/expenses/${id}/hidden/${userId}`),

    myPaymentProfile: () => get<PaymentProfileDto>('/expenses/payment-profile'),
    savePaymentProfile: (body: PaymentProfileInput) =>
      put<PaymentProfileDto>('/expenses/payment-profile', body),
    /** Wie ich dieser Person Geld zurückgeben kann – mit fertigem PayPal-Link. */
    paymentProfileOf: (userId: string, amountCents?: number, currency = 'EUR') =>
      get<{ profile: PaymentProfileDto; paypalUrl: string | null }>(
        `/expenses/payment-profile/${userId}`,
        { query: { amountCents, currency } },
      ),
  },
  games: {
    catalog: () => get<ListResult<GameInfoDto>>('/games'),
    /** Laufende (oder gefilterte) Partien des angemeldeten Nutzers. */
    sessions: (query: { conversationId?: string; status?: string } = {}) =>
      get<ListResult<GameSessionDto>>('/games/sessions', { query }),
    create: (body: { conversationId: string; gameKey: string; opponentIds?: string[] }) =>
      post<GameSessionDto>('/games/sessions', body),
    byId: (id: string) => get<GameSessionDto>(`/games/sessions/${id}`),
    join: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/join`),
    move: (id: string, move: unknown, version?: number) =>
      post<GameSessionDto>(`/games/sessions/${id}/moves`, { move, version }),
    abort: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/abort`),
    rematch: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/rematch`),
  },
  push: {
    publicKey: () =>
      get<{ publicKey: string | null; enabled: boolean }>('/push/public-key', { anonymous: true }),
    subscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
      post<{ ok: boolean }>('/push/subscriptions', body),
    unsubscribe: (endpoint: string) =>
      request<void>('DELETE', '/push/subscriptions', { body: { endpoint } }),
    test: () => post<{ delivered: number }>('/push/test'),
  },
  admin: {
    status: () => get<AdminStatus>('/admin/status'),
    unlock: (password: string) => post<AdminStatus>('/admin/unlock', { password }),
    lock: () => post<AdminStatus>('/admin/lock'),
    invites: () => get<InviteDto[]>('/admin/invites'),
    createInvite: (body: { note?: string; maxUses?: number; expiresAt?: string }) =>
      post<InviteDto>('/admin/invites', body),
    revokeInvite: (code: string) =>
      del<{ revoked: boolean }>(`/admin/invites/${encodeURIComponent(code)}`),
    members: () => get<AdminMemberDto[]>('/admin/members'),
    removeMember: (id: string) => del<{ removed: boolean }>(`/admin/members/${id}`),
    storageCheck: () => get<StorageCheck>('/admin/storage-check'),
  },
  passkeys: {
    list: () => get<PasskeyDto[]>('/passkeys'),
    remove: (id: string) => del<{ removed: boolean }>(`/passkeys/${id}`),
    registerStart: () => post<PasskeyStart>('/passkeys/register/start'),
    registerFinish: (body: unknown) => post<PasskeyDto>('/passkeys/register/finish', body),
    loginStart: (username: string) =>
      post<PasskeyStart>('/passkeys/login/start', { username }, { anonymous: true }),
    loginFinish: (body: unknown) =>
      post<AuthSession>('/passkeys/login/finish', body, { anonymous: true }),
  },
};

export interface HealthDto {
  status: string;
  storage?: string;
  bus?: string;
  busConnected?: boolean;
  push?: boolean;
  connections?: number;
  version?: string;
}

export interface PasskeyDto {
  id: string;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PasskeyStart {
  requestId: string;
  options: unknown;
}

export interface StorageCheck {
  driver: string;
  endpoint: string | null;
  bucket: string | null;
  pathStyle: boolean | null;
  browserOrigin: string;
  verdict: string;
  steps: { name: string; ok: boolean; detail: string; hint: string | null }[];
}

export interface AdminStatus {
  /** Ob auf dem Server überhaupt ein Admin-Passwort hinterlegt ist. */
  available: boolean;
  isAdmin: boolean;
}

export interface InviteDto {
  code: string;
  note: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AdminMemberDto {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export type Api = typeof api;
