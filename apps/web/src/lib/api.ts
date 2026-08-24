import type {
  ApiErrorBody,
  AttachmentDto,
  AuthSession,
  AuthTokens,
  CalendarEventDto,
  ConversationDto,
  CreateUploadResult,
  GameInfoDto,
  GameSessionDto,
  MessageDto,
  PollDto,
  SelfUserDto,
  StickerPackDto,
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

let refreshInFlight: Promise<StoredTokens | null> | null = null;

async function refreshTokens(): Promise<StoredTokens | null> {
  const current = tokens;
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
          setTokens(null);
          return null;
        }
        const session = (await response.json()) as AuthSession;
        return setTokens(session);
      } catch {
        return current;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the Authorization header (login, register, public key …). */
  anonymous?: boolean;
  raw?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path.startsWith('/api') ? '' : API_PREFIX}${path}`;
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
    return fetch(buildUrl(path, options.query), {
      method,
      headers,
      signal: options.signal,
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
    let current = tokens;
    if (current && current.expiresAt - Date.now() < 30_000) current = await refreshTokens();
    accessToken = current?.accessToken ?? null;
  }

  let response: Response;
  try {
    response = await send(accessToken);
  } catch (error) {
    throw new ApiError(0, 'offline', 'Keine Verbindung zum Server', error);
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
    updateMe: (body: Record<string, unknown>) => patch<SelfUserDto>('/users/me', body),
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
    remove: (id: string) => del<void>(`/messages/${id}`),
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
  calendar: {
    events: (query: { from?: string; to?: string; conversationId?: string } = {}) =>
      get<ListResult<CalendarEventDto>>('/calendar/events', { query }),
    create: (body: Record<string, unknown>) => post<CalendarEventDto>('/calendar/events', body),
    update: (id: string, body: Record<string, unknown>) =>
      patch<CalendarEventDto>(`/calendar/events/${id}`, body),
    remove: (id: string) => del<void>(`/calendar/events/${id}`),
    rsvp: (id: string, status: 'yes' | 'no' | 'maybe' | 'pending') =>
      post<CalendarEventDto>(`/calendar/events/${id}/rsvp`, { status }),
    byId: (id: string) => get<CalendarEventDto>(`/calendar/events/${id}`),
    icsUrl: (calendarToken: string) =>
      `${API_BASE}${API_PREFIX}/calendar/${calendarToken}/feed.ics`,
    eventIcsUrl: (id: string) => `${API_BASE}${API_PREFIX}/calendar/events/${id}/event.ics`,
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
};

export type Api = typeof api;
