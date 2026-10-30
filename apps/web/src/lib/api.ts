import type { GrenzenAntwort } from './uploadGrenzen.js';
import type {
  ApiErrorBody,
  AttachmentDto,
  AuthSession,
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
  PressenFilter,
  PressenLaeufeAbfrage,
  PressenLaeufeSeite,
  PressenLaufDto,
  PressenStatistikDto,
  MessageDto,
  ExpenseDto,
  PaymentProfileDto,
  PaymentProfileInput,
  PollDto,
  SelfUserDto,
  Prioritaet,
  StickerPackDto,
  TerminAntwort,
  UpdateCollectionInput,
  UpdateCollectionItemInput,
  UserDto,
  VerlaufsantragDto,
  ZustellungStandDto,
  ErinnernStandDto,
} from '@initiative/shared';
import type { OrtTreffer } from './ortSuche.js';
import type { StueckStand } from './stueckUpload.js';
import {
  API_PREFIX,
  pressenLaeufeSeiteSchema,
  pressenLaufSchema,
  pressenStatistikSchema,
} from '@initiative/shared';

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

/**
 * Was der Client von einer Sitzung aufhebt: NUR das kurzlebige Zugriffstoken.
 *
 * Der Erneuerungs-Token lag früher hier mit drin – in `localStorage`, wo ihn
 * jedes Skript der Seite lesen kann. Ein eingeschleuster Schnipsel nahm ihn
 * mit und hatte sechzig Tage lang eine rotierende Sitzung. Jetzt steht er in
 * einem `HttpOnly`-Keks, den nur der Browser kennt und nur an
 * `/auth/refresh` schickt (siehe `apps/api/src/auth/erneuerungskeks.rs`).
 *
 * Das Zugriffstoken bleibt wie bisher im gemeinsamen Speicher der Tabs: Es
 * gilt eine Viertelstunde, und so erneuert nicht jeder Tab für sich. Dass ein
 * Eintrag hier steht, heisst zugleich „es gibt eine Sitzung“ – auch wenn das
 * Token darin abgelaufen ist; dann holt der Keks ein neues.
 */
export interface StoredTokens {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

type TokenListener = (tokens: StoredTokens | null) => void;

const TOKEN_KEY = 'initiative.tokens';

/**
 * Der Kopf, mit dem der Client sagt „ich führe die Sitzung über den Keks“.
 *
 * Beim Anmelden heisst das: Erneuerungs-Token nicht in den Rumpf. Beim
 * Erneuern und Abmelden ist er der CSRF-Nachweis – ein Formular oder ein
 * Querverweis einer fremden Seite kann ihn nicht setzen.
 */
export const SITZUNG_KOPF = 'x-initiative-sitzung';

/** Base URL of the API. Empty string keeps everything same-origin (dev proxy,
 *  single-domain deployments); set VITE_API_URL when API and PWA are split. */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

interface Gespeichert extends StoredTokens {
  /** Nur in Einträgen von vor der Umstellung – siehe `altToken`. */
  refreshToken?: string;
}

function readRaw(): Gespeichert | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Gespeichert;
    if (!parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readTokens(): StoredTokens | null {
  const roh = readRaw();
  return roh ? { accessToken: roh.accessToken, expiresAt: roh.expiresAt } : null;
}

/**
 * Ein Erneuerungs-Token, den der Server im Rumpf geschickt hat, weil er keinen
 * Keks setzen konnte (App und API auf fremden Stellen ohne TLS). Er bleibt
 * nur im Speicher dieses Tabs – nach dem Neuladen ist die Sitzung dann weg,
 * aber er steht nirgends, wo ein Skript ihn später noch fände.
 */
let fluechtigerToken: string | null = null;

/**
 * Der Erneuerungs-Token aus einem Eintrag von vor der Umstellung.
 *
 * Er wird beim nächsten Erneuern ein letztes Mal im Rumpf vorgelegt; der
 * Server setzt dafür den Keks, und `setTokens` schreibt den Eintrag ohne ihn
 * neu. Bis dahin bleibt er stehen: Wer ihn vorher löscht und dann offline
 * ist, wäre abgemeldet.
 */
function altToken(): string | null {
  return readRaw()?.refreshToken ?? fluechtigerToken;
}

let tokens: StoredTokens | null = readTokens();
const listeners = new Set<TokenListener>();

export function getTokens(): StoredTokens | null {
  return tokens;
}

export function setTokens(
  next: { accessToken: string; expiresIn: number; refreshToken?: string } | null,
): StoredTokens | null {
  tokens = next
    ? {
        accessToken: next.accessToken,
        expiresAt: Date.now() + next.expiresIn * 1000,
      }
    : null;
  // Kam der Erneuerungs-Token trotz Keks-Wunsch im Rumpf, gibt es keinen Keks
  // – dann nur im Speicher dieses Tabs (siehe `fluechtigerToken`).
  fluechtigerToken = next?.refreshToken ?? null;
  try {
    // Ohne `refreshToken`: Auch ein alter Eintrag verliert ihn hier.
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

function frisch(eintrag: StoredTokens | null): boolean {
  return !!eintrag && eintrag.expiresAt - Date.now() >= 30_000;
}

/**
 * Übernimmt eine Erneuerung, die ein anderer Tab vorgenommen hat.
 *
 * Erneuert ein Tab, legt er das neue Zugriffstoken in den gemeinsamen
 * Speicher. Die anderen nehmen es von dort, statt selbst zu erneuern.
 */
function adoptStoredTokens(): StoredTokens | null {
  const stored = readTokens();
  if (stored && stored.accessToken !== tokens?.accessToken) {
    tokens = stored;
    for (const listener of listeners) listener(tokens);
  }
  return tokens;
}

if (typeof window !== 'undefined') {
  // Ein anderer Tab hat erneuert oder sich abgemeldet.
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_KEY) return;
    const next = readTokens();
    if (next?.accessToken === tokens?.accessToken) return;
    tokens = next;
    for (const listener of listeners) listener(tokens);
  });
}

let refreshInFlight: Promise<StoredTokens | null> | null = null;

/** Name der Sperre, unter der genau EIN Tab zur Zeit erneuert. */
const ERNEUERN_SPERRE = 'initiative.tokens.erneuern';

/**
 * Antworten auf `/auth/refresh`, die wirklich „diese Sitzung gibt es nicht
 * mehr“ heissen. Alles andere – 429 von der Drossel, 5xx bei einem Neustart des
 * Servers – ist vorübergehend.
 *
 * Bisher beendete JEDE Ablehnung die Sitzung. Die Drossel erlaubt 30
 * Erneuerungen in zehn Minuten je Absender; ein Haushalt hinter einer Adresse
 * mit mehreren Geräten und Tabs kam dort hin, und jeder kassierte statt eines
 * „warte kurz“ eine Abmeldung. Ebenso jeder, der während eines Updates der API
 * zurück in die App kam.
 */
function sitzungAbgelehnt(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/**
 * Führt `arbeit` unter einer Sperre aus, die für alle Tabs dieser Herkunft gilt.
 *
 * Der Server verbrennt beim Erneuern den alten Token. Den Keks teilen sich
 * zwar alle Tabs, aber zwei gleichzeitige Erneuerungen schicken denselben
 * (der Browser setzt den neuen erst, wenn die erste Antwort da ist). Das fängt
 * die Nachfrist des Servers ab (30 s) – sicherer ist, es gar nicht erst zu
 * tun: Unter der Sperre erneuert einer, die anderen übernehmen sein Ergebnis
 * aus dem Speicher. `refreshInFlight` bündelt nur innerhalb EINES Tabs.
 *
 * Ohne Web Locks (sehr alte Browser) läuft die Arbeit wie bisher ohne Sperre.
 */
async function tabuebergreifend<T>(arbeit: () => Promise<T>): Promise<T> {
  const sperren =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (!sperren?.request) return arbeit();
  let gestartet = false;
  try {
    return await sperren.request(ERNEUERN_SPERRE, () => {
      gestartet = true;
      return arbeit();
    });
  } catch (error) {
    // Die Sperre selbst kann scheitern (etwa in einem undurchsichtigen
    // Rahmen). Dann lieber ohne Sperre als gar nicht – aber nie zweimal.
    if (gestartet) throw error;
    return arbeit();
  }
}

/**
 * Die Erneuerung selbst: mit Keks (`credentials: 'include'`, damit er auch bei
 * getrennter API mitgeht) und dem Sitzungskopf. Ein Token im Rumpf nur, wenn
 * es noch einen alten oder flüchtigen gibt (`altToken`).
 */
function erneuerungAnfragen(): Promise<Response> {
  const alt = altToken();
  return fetch(`${API_BASE}${API_PREFIX}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', [SITZUNG_KOPF]: 'keks' },
    body: JSON.stringify(alt ? { refreshToken: alt } : {}),
    // Ohne Zeitlimit hielte eine hängende Erneuerung die Sperre – und
    // damit jede Anfrage aller Tabs – unbegrenzt fest.
    signal: withTimeout(),
  });
}

async function refreshTokens(): Promise<StoredTokens | null> {
  // Erst nachsehen, ob ein anderer Tab schon erneuert hat.
  const vorher = adoptStoredTokens();
  if (!vorher) return null;
  if (!refreshInFlight) {
    refreshInFlight = tabuebergreifend(async () => {
      // Unter der Sperre noch einmal lesen: Wer vor uns dran war, hat
      // erneuert und das frische Token hinterlegt.
      const gespeichert = readTokens();
      if (gespeichert && gespeichert.accessToken !== vorher.accessToken && frisch(gespeichert)) {
        tokens = gespeichert;
        for (const listener of listeners) listener(tokens);
        return tokens;
      }
      const current = tokens ?? vorher;
      try {
        const response = await erneuerungAnfragen();
        if (!response.ok) {
          // Abgelehnt heißt nicht zwangsläufig „abgemeldet“: Zwischen Lesen und
          // Senden kann ein anderer Tab erneuert haben. Nur wegwerfen, wenn im
          // Speicher wirklich nichts Neueres steht.
          const stored = readTokens();
          if (stored && stored.accessToken !== current.accessToken && frisch(stored)) {
            tokens = stored;
            for (const listener of listeners) listener(tokens);
            return tokens;
          }
          if (!sitzungAbgelehnt(response.status)) return current;
          setTokens(null);
          return null;
        }
        const session = (await response.json()) as AuthSession;
        return setTokens(session);
      } catch {
        // Netzwerkfehler: Die Sitzung bleibt bestehen, es wird später erneut versucht.
        return current;
      }
    }).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Braucht es vor der nächsten Anfrage eine Erneuerung? Auch, um einen alten
 *  Eintrag aus `localStorage` gleich in den Keks umzuziehen. */
function mussErneuern(current: StoredTokens | null): boolean {
  return !!current && (!frisch(current) || !!readRaw()?.refreshToken);
}

/** Gültiges Zugriffstoken, notfalls frisch geholt. Für den WebSocket. */
export async function validAccessToken(): Promise<string | null> {
  const current = adoptStoredTokens();
  if (!current) return null;
  if (!mussErneuern(current)) return current.accessToken;
  return (await refreshTokens())?.accessToken ?? null;
}

/** Erzwingt eine Erneuerung, etwa wenn der WebSocket mit 4401 abgewiesen wurde. */
export async function forceRefresh(): Promise<StoredTokens | null> {
  return refreshTokens();
}

/**
 * Abmelden: den Keks beim Server widerrufen und löschen lassen, dann lokal
 * vergessen.
 *
 * `DELETE /auth/refresh`, weil der Keks nur an diesen Pfad geht. Gibt es noch
 * einen alten oder flüchtigen Token, wird er zusätzlich über den alten Weg
 * widerrufen. Fehler werden geschluckt – abgemeldet wird lokal in jedem Fall.
 */
export async function abmelden(): Promise<void> {
  const alt = altToken();
  await Promise.all([
    fetch(`${API_BASE}${API_PREFIX}/auth/refresh`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { [SITZUNG_KOPF]: 'keks' },
      signal: withTimeout(),
    }).catch(() => undefined),
    alt
      ? fetch(`${API_BASE}${API_PREFIX}/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: alt }),
          signal: withTimeout(),
        }).catch(() => undefined)
      : undefined,
  ]);
  setTokens(null);
}

/**
 * Was der WebSocket in seine Adresse schreibt: ein Einmal-Ticket.
 *
 * Das Zugriffstoken stand früher als `?token=` in der Adresse und damit in
 * jedem Protokoll eines Zwischenknotens. Das Ticket (`POST /realtime/ticket`)
 * gilt 30 Sekunden und genau einen Aufbau; der Server nimmt es auch unter dem
 * alten Feldnamen `token` an, damit `lib/realtime.ts` nur diesen Aufruf
 * tauschen musste.
 *
 * - `null`, wenn es keine Sitzung gibt oder der Server die Sitzung ablehnt –
 *   wie `validAccessToken`.
 * - Ohne Netz (oder bei einem Serverfehler) das Zugriffstoken selbst, wie
 *   bisher: Die Leitung scheitert dann ohnehin und versucht es mit Pause
 *   erneut, statt stehen zu bleiben. Der Server nimmt das alte Verfahren
 *   übergangsweise noch an.
 */
export async function echtzeitZugang(): Promise<string | null> {
  const token = await validAccessToken();
  if (!token) return null;
  try {
    return (await api.realtime.ticket()).ticket;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
    return token;
  }
}

/**
 * Nach dieser Zeit gilt eine Anfrage als gescheitert.
 *
 * Ohne Zeitlimit haengt ein `fetch` potenziell unbegrenzt. Antwortete die API
 * nicht mehr, lud die App deshalb ewig, statt auf den Zwischenspeicher
 * zurueckzufallen und "nicht erreichbar" zu melden.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Wie lange ein Upload ueber die API dauern darf.
 *
 * Zwanzig Sekunden reichen fuer eine Antwort, nicht fuer 200 MB Video auf
 * einer Mobilverbindung. Derselbe Wert wie beim Weg ueber den Objektspeicher
 * (lib/upload.ts) – der Unterschied lag nur daran, dass dieser Weg bisher nie
 * benutzt wurde.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** Verbindet das eigene Zeitlimit mit einem ggf. uebergebenen Abbruchsignal. */
export function withTimeout(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  // `any` gibt es noch nicht ueberall (Safari vor 17.4). Das Zeitlimit allein
  // zu nehmen hiesse, den Abbruch des Aufrufers zu verschlucken: Die Ortssuche
  // bricht jede ueberholte Anfrage ab, und ihre langsame Antwort kaeme sonst
  // nach der neueren an und ueberschriebe deren Vorschlaege.
  const gemeinsam = new AbortController();
  for (const quelle of [signal, timeout]) {
    if (quelle.aborted) {
      gemeinsam.abort(quelle.reason);
      break;
    }
    quelle.addEventListener('abort', () => gemeinsam.abort(quelle.reason), { once: true });
  }
  return gemeinsam.signal;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Eigenes Zeitlimit, wenn die Vorgabe zu knapp ist (Uploads). */
  timeoutMs?: number;
  /** Zusätzliche Kopfzeilen (etwa `content-range` beim Hochladen in Stücken). */
  kopfzeilen?: Record<string, string>;
  /** Skip the Authorization header (login, register, public key …). */
  anonymous?: boolean;
  raw?: boolean;
  /** Pfad liegt auf der Wurzel, nicht unter `/api/v1` (etwa `/healthz`). */
  root?: boolean;
  /**
   * Anmelden/Registrieren: Sitzung über den Keks. Schickt `SITZUNG_KOPF` und
   * `credentials: 'include'` – sonst nähme der Browser den Keks einer
   * getrennten API nicht an, und der Server legte den Token in den Rumpf.
   */
  sitzung?: boolean;
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
    // Ein Blob geht roh hinaus – ein Stück einer Datei ist kein JSON.
    const roh = options.body instanceof FormData || options.body instanceof Blob;
    const headers: Record<string, string> = { ...options.kopfzeilen };
    if (options.body !== undefined && !roh) {
      headers['content-type'] = 'application/json';
    }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (options.sitzung) headers[SITZUNG_KOPF] = 'keks';
    return fetch(buildUrl(path, options.query, options.root), {
      method,
      headers,
      ...(options.sitzung ? { credentials: 'include' as const } : {}),
      signal: withTimeout(options.signal, options.timeoutMs),
      body:
        options.body === undefined
          ? undefined
          : roh
            ? (options.body as FormData | Blob)
            : JSON.stringify(options.body),
    });
  };

  let accessToken: string | null = null;
  if (!options.anonymous) {
    let current = adoptStoredTokens();
    if (mussErneuern(current)) current = await refreshTokens();
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
    }) => post<AuthSession>('/auth/register', body, { anonymous: true, sitzung: true }),
    login: (body: { username: string; password: string }) =>
      post<AuthSession>('/auth/login', body, { anonymous: true, sitzung: true }),
    /** Widerruft die Sitzung (Keks und ggf. alten Token) und vergisst sie lokal. */
    logout: () => abmelden(),
    me: () => get<SelfUserDto>('/auth/me'),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      post<void>('/auth/password', body),
    rotateCalendarToken: () => post<{ calendarToken: string }>('/auth/calendar-token/rotate'),
  },
  orte: {
    /** Vorschläge für Adressen und Orte; `quelle` ist die Namensnennung, die angezeigt werden muss. */
    suche: (q: string, signal?: AbortSignal) =>
      get<{ items: OrtTreffer[]; quelle: string }>('/orte/suche', { query: { q }, signal }),
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
  /**
   * Der Verlauf vor dem eigenen Beitritt – beantragen und freigeben.
   *
   * Die Antworten enthalten bewusst keine Nachrichten: Freigegeben wird der
   * Behaelter, nicht sein Inhalt. Faellt die Grenze, holt der Client den
   * Verlauf ueber die gewohnten Wege nach.
   */
  verlauf: {
    offene: (conversationId: string) =>
      get<ListResult<VerlaufsantragDto>>(`/conversations/${conversationId}/verlauf`),
    stellen: (conversationId: string) =>
      post<VerlaufsantragDto>(`/conversations/${conversationId}/verlauf`, {}),
    abstimmen: (conversationId: string, antragId: string, zustimmung: boolean) =>
      post<VerlaufsantragDto>(`/conversations/${conversationId}/verlauf/${antragId}`, {
        zustimmung,
      }),
    zurueckziehen: (conversationId: string, antragId: string) =>
      del<void>(`/conversations/${conversationId}/verlauf/${antragId}`),
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
      // Ohne eigenes Zeitlimit braecht der Upload nach zwanzig Sekunden ab –
      // auf einem eigenen Server, wo dieser Weg der einzige ist, also bei
      // jedem groesseren Video.
      return post<AttachmentDto>(`/media/uploads/${id}/data`, form, {
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
    },
    /**
     * Hochladen in Stücken – siehe `lib/stueckUpload.ts` und
     * `apps/api/src/modules/stuecke.rs`.
     */
    stueckeAnlegen: (body: {
      kind: string;
      mime: string;
      size: number;
      fileName?: string;
      sha256?: string;
    }) => post<StueckStand>('/media/stuecke', body),
    stueckeStand: (sitzungId: string) => get<StueckStand>(`/media/stuecke/${sitzungId}`),
    stueckSenden: (
      sitzungId: string,
      start: number,
      stueck: Blob,
      gesamt: number,
      signal?: AbortSignal,
    ) =>
      request<StueckStand>('PUT', `/media/stuecke/${sitzungId}`, {
        body: stueck,
        signal,
        // 8 MiB auf einer zähen Mobilverbindung (≈ 100 kB/s) sind gut eine
        // Minute. Zwei Minuten lassen Luft, ohne einen hängenden Versuch
        // ewig stehen zu lassen – die Wiederholung übernimmt dann.
        timeoutMs: UPLOAD_TIMEOUT_MS,
        kopfzeilen: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${start + stueck.size - 1}/${gesamt}`,
        },
      }),
    stueckeAbschliessen: (sitzungId: string, body: Record<string, unknown>) =>
      post<AttachmentDto>(`/media/stuecke/${sitzungId}/abschliessen`, body, {
        // Der Server prüft, verschlüsselt und legt ab – bei Gigabytes dauert
        // das. Wer hier nach zwanzig Sekunden aufgibt, fragt nur nochmal.
        timeoutMs: 15 * 60_000,
      }),
    stueckeAbbrechen: (sitzungId: string) => del<void>(`/media/stuecke/${sitzungId}`),
    /** Die vom Server wirklich geltenden Upload-Grenzen (`UPLOAD_MAX_BYTES` & Co.). */
    grenzen: () => get<GrenzenAntwort>('/media/grenzen'),
    url: (attachmentId: string) => `${API_BASE}${API_PREFIX}/media/${attachmentId}`,
    /**
     * Eine Adresse, die ein Fernseher selbst abrufen kann.
     *
     * Das Gerät im Zimmer holt die Datei SELBST und schickt dabei weder Kopf
     * noch Keks – der Ausweis muss also in der Adresse stehen. Die Karte
     * entsteht erst auf Knopfdruck und gilt ein paar Stunden; die lange
     * Begründung steht auf der Serverseite in `auth::fernsehticket`.
     */
    fernsehticket: (attachmentId: string) =>
      post<{
        /** Die fertige Adresse des Originals. */
        url: string;
        /** Die Karte allein – für eine ANDERE Adresse derselben Datei. */
        karte: string;
        /** Wie der Abfrageteil heisst, in dem die Karte steht. */
        feld: string;
        /** Die Adresse ohne Abfrageteil, zum Anhängen von `/miniatur` & Co. */
        basis: string;
        mime: string;
        art: string;
        breite: number | null;
        hoehe: number | null;
        name: string | null;
        gueltigSekunden: number;
      }>(`/media/${attachmentId}/fernsehticket`),
    /**
     * Die Priorität mehrerer Dateien auf einmal setzen.
     *
     * `abgelehnt` nennt die, bei denen das Recht fehlte. Eine Liste und kein
     * Fehler für alles: Wer zwanzig Dateien auswählt und bei einer das Recht
     * nicht hat, soll die neunzehn trotzdem bekommen.
     */
    prioritaet: (ids: string[], prioritaet: Prioritaet) =>
      patch<{ geaendert: number; abgelehnt: string[] }>('/media/prioritaet', { ids, prioritaet }),
    /**
     * Dateien in einen Chat weitergeben.
     *
     * Es entsteht eine neue Nachricht, aber kein zweites Byte: Die
     * weitergegebene Fassung zeigt auf dieselbe Datei.
     */
    teilen: (ids: string[], conversationId: string, body?: string) =>
      post<MessageDto>('/media/teilen', { ids, conversationId, body }),
  },
  /**
   * Der Fernseher als zweiter Bildschirm.
   *
   * Der Code entsteht AM FERNSEHER, nicht hier: Sonst müsste ihn jemand mit
   * einer Fernbedienung abtippen – acht Zeichen auf einer Bildschirmtastatur,
   * bei der man mit Pfeiltasten von Buchstabe zu Buchstabe fährt. So herum
   * tippt man auf dem Telefon, und der Fernseher zeigt nur an.
   */
  tv: {
    /** Verbinden und einstellen in einem Schritt – siehe `fernsehen.rs`. */
    einstellen: (
      code: string,
      body: {
        collectionId?: string;
        attachmentIds?: string[];
        /** Oder ein Gespräch – dann zeigt der Fernseher den Verlauf. */
        conversationId?: string;
        modus?: 'linear' | 'zufall';
        sekunden?: number;
      },
    ) =>
      post<{
        code: string;
        stueckzahl: number;
        art?: 'diashow' | 'chat';
        modus?: string;
        sekunden?: number;
      }>(`/tv/sitzungen/${encodeURIComponent(code)}/programm`, body),
    /** Die Fernbedienung: weiter, zurück, Pause, Reihenfolge, Tempo. */
    steuern: (
      code: string,
      body: {
        stelle?: number;
        /** „Eins weiter" (1) oder „eins zurück" (-1) – von der Stelle, die der Server kennt. */
        schritt?: number;
        pausiert?: boolean;
        modus?: 'linear' | 'zufall';
        sekunden?: number;
      },
    ) =>
      patch<{ stelle: number; modus: string }>(`/tv/sitzungen/${encodeURIComponent(code)}`, body),
    beenden: (code: string) => del<void>(`/tv/sitzungen/${encodeURIComponent(code)}`),
    /**
     * Was gerade auf einem Fernseher läuft – für diese Person.
     *
     * Die Fernbedienung lebte einmal allein im Blatt: zumachen hiess, den
     * Code zu verlieren, und am Fernseher stand er auch nicht mehr, weil dort
     * ja die Diashow lief. Der Server weiss es ohnehin; hier wird er gefragt.
     */
    meine: () =>
      get<{
        items: {
          code: string;
          /** `diashow` oder `chat` – die Fernbedienung sieht dann anders aus. */
          art?: 'diashow' | 'chat';
          gespraechId?: string | null;
          stueckzahl: number;
          stelle: number;
          pausiert: boolean;
          modus: 'linear' | 'zufall';
          sekunden: number;
          /** Wie lange der Fernseher sich nicht gemeldet hat. */
          gesehenVorSekunden: number;
        }[];
      }>('/tv/meine'),
  },
  stickers: {
    packs: () => get<ListResult<StickerPackDto>>('/stickers/packs'),
    createPack: (body: { name: string; isPublic?: boolean }) =>
      post<StickerPackDto>('/stickers/packs', body),
    updatePack: (id: string, body: Record<string, unknown>) =>
      patch<StickerPackDto>(`/stickers/packs/${id}`, body),
    deletePack: (id: string) => del<void>(`/stickers/packs/${id}`),
    addSticker: (
      packId: string,
      body: {
        attachmentId: string;
        emoji?: string | null;
        tonAttachmentId?: string;
        tonDauerMs?: number;
      },
    ) => post<StickerPackDto>(`/stickers/packs/${packId}/stickers`, body),
    /** Ton an einen vorhandenen Sticker haengen – oder einen anderen daraufsetzen. */
    setzeTon: (
      packId: string,
      stickerId: string,
      body: { attachmentId: string; dauerMs?: number },
    ) => put<StickerPackDto>(`/stickers/packs/${packId}/stickers/${stickerId}/ton`, body),
    entferneTon: (packId: string, stickerId: string) =>
      del<StickerPackDto>(`/stickers/packs/${packId}/stickers/${stickerId}/ton`),
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
    /**
     * Anlegen und Ändern liefern den Termin auf oberster Ebene, dazu – wenn
     * `zustellung` oder `attendeeIds` gesendet wurde – was daraus geworden ist
     * (Karten, neue Einzelchats, Ausgelassenes). Ältere Server kennen das Feld
     * nicht; dann fehlt es einfach.
     */
    create: (body: Record<string, unknown>) => post<TerminAntwort>('/calendar/events', body),
    update: (id: string, body: Record<string, unknown>) =>
      patch<TerminAntwort>(`/calendar/events/${id}`, body),
    remove: (id: string) => del<void>(`/calendar/events/${id}`),
    rsvp: (id: string, status: 'yes' | 'no' | 'maybe' | 'pending') =>
      post<CalendarEventDto>(`/calendar/events/${id}/rsvp`, { status }),
    /**
     * Nachträglich einladen.
     *
     * `attendeeIds` ist der SOLLZUSTAND, nicht ein Nachtrag – deshalb müssen
     * die schon Eingeladenen mitgeschickt werden. Vorher war das Feld auf dem
     * Server ergänzend, und genau daraus wurde ein Fehler: Der Termin-Editor
     * schickt die vollständige Liste (er füllt die Kästchen mit den aktuellen
     * Teilnehmern vor), und wer dort jemanden abwählte, bekam „gespeichert"
     * zu sehen – ausgeladen war niemand.
     *
     * Ein Feld, zwei Bedeutungen, je nach Aufrufer. Jetzt hat es eine.
     *
     * Die Neuen bekommen eine Karte im Einzelchat und eine Benachrichtigung;
     * wer schon dabei war, nichts davon. Der Ersteller gehört nicht in die
     * Liste – er ist immer dabei.
     */
    invite: (id: string, bisher: string[], neue: string[], ersteller?: string) =>
      patch<TerminAntwort>(`/calendar/events/${id}`, {
        attendeeIds: [...new Set([...bisher, ...neue])].filter((person) => person !== ersteller),
        zustellung: { senden: true, einzelchats: true },
      }),
    /**
     * Und wieder ausladen: der Ersteller jede Person (ihre Einzelkarte wird
     * gelöscht), jede eingeladene Person sich selbst.
     */
    uninvite: (id: string, userId: string) =>
      del<TerminAntwort>(`/calendar/events/${id}/attendees/${userId}`),
    /** Absagen lässt den Termin und seine Karten stehen („Abgesagt“), Zusagen sind dann gesperrt. */
    absagen: (id: string) =>
      patch<TerminAntwort>(`/calendar/events/${id}`, { status: 'cancelled' }),
    /** Nimmt einen abgesagten Termin wieder auf. */
    wiederaufnehmen: (id: string) =>
      patch<TerminAntwort>(`/calendar/events/${id}`, { status: 'confirmed' }),
    /**
     * Wo der Termin als Karte steht – nur der Ersteller. Der Editor braucht
     * das, bevor er `gruppenChatIds` schicken darf: Ohne diese Antwort wählte
     * er bestehende Gruppenkarten versehentlich ab.
     */
    zustellung: (id: string) => get<ZustellungStandDto>(`/calendar/events/${id}/zustellung`),
    /** Legt Karten nach, die beim Anlegen nicht zugestellt werden konnten. */
    nachliefern: (id: string) =>
      post<TerminAntwort>(`/calendar/events/${id}/zustellung/nachliefern`),
    /** Wie weit das Erinnern eines Termins ist – nur für den Ersteller. */
    erinnerungen: (id: string) => get<ErinnernStandDto>(`/calendar/events/${id}/erinnerungen`),
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
    updateNote: (
      id: string,
      noteId: string,
      body: Partial<EventNoteInput> & { position?: number },
    ) => patch<EventNoteDto>(`/calendar/events/${id}/notes/${noteId}`, body),
    removeNote: (id: string, noteId: string) => del<void>(`/calendar/events/${id}/notes/${noteId}`),

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
      body: {
        text: string;
        requiredChecks?: number;
        requiredAll?: boolean;
        assigneeIds?: string[];
      },
    ) => post<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items`, body),
    updateNoteItem: (
      eventId: string,
      noteId: string,
      itemId: string,
      body: {
        text?: string;
        requiredChecks?: number;
        requiredAll?: boolean;
        position?: number;
        /** Leere Liste nimmt die Zuweisung zurück – dann gilt wieder die Zahl. */
        assigneeIds?: string[];
      },
    ) => patch<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items/${itemId}`, body),
    removeNoteItem: (eventId: string, noteId: string, itemId: string) =>
      del<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items/${itemId}`),
    /** Abhaken oder den Haken wegnehmen. Ohne `checked` wird umgeschaltet. */
    checkNoteItem: (eventId: string, noteId: string, itemId: string, checked?: boolean) =>
      post<EventNoteDto>(`/calendar/events/${eventId}/notes/${noteId}/items/${itemId}/check`, {
        checked,
      }),

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
    update: (id: string, body: Record<string, unknown>) =>
      patch<ExpenseDto>(`/expenses/${id}`, body),
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
    create: (body: { conversationId?: string | null; gameKey: string; opponentIds?: string[] }) =>
      post<GameSessionDto>('/games/sessions', body),
    byId: (id: string) => get<GameSessionDto>(`/games/sessions/${id}`),
    join: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/join`),
    move: (id: string, move: unknown, version?: number) =>
      post<GameSessionDto>(`/games/sessions/${id}/moves`, { move, version }),
    abort: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/abort`),
    rematch: (id: string) => post<GameSessionDto>(`/games/sessions/${id}/rematch`),
    /**
     * Pressen-Statistik: nur die eigenen Läufe. Die Antworten werden gegen das
     * gemeinsame Schema geprüft – eine abweichende Form ist ein Fehler, den man
     * sieht, nicht eine Seite voller `NaN`.
     */
    pressenStatistik: async (
      filter: PressenFilter = {},
      signal?: AbortSignal,
    ): Promise<PressenStatistikDto> =>
      pressenStatistikSchema.parse(
        await get<unknown>('/games/pressen/statistik', { query: filter, signal }),
      ),
    pressenLaeufe: async (
      abfrage: PressenLaeufeAbfrage = {},
      signal?: AbortSignal,
    ): Promise<PressenLaeufeSeite> =>
      pressenLaeufeSeiteSchema.parse(
        await get<unknown>('/games/pressen/laeufe', { query: abfrage, signal }),
      ),
    pressenLauf: async (id: string, signal?: AbortSignal): Promise<PressenLaufDto> =>
      pressenLaufSchema.parse(await get<unknown>(`/games/pressen/laeufe/${id}`, { signal })),
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
  realtime: {
    /**
     * Ein Einmal-Ticket für den Aufbau der Echtzeit-Leitung: 30 Sekunden
     * gültig, genau ein Aufbau. Statt des Zugriffstokens in der Adresse –
     * siehe `echtzeitZugang`.
     */
    ticket: () => post<{ ticket: string; expiresIn: number }>('/realtime/ticket'),
  },
  passkeys: {
    list: () => get<PasskeyDto[]>('/passkeys'),
    remove: (id: string) => del<{ removed: boolean }>(`/passkeys/${id}`),
    registerStart: () => post<PasskeyStart>('/passkeys/register/start'),
    registerFinish: (body: unknown) => post<PasskeyDto>('/passkeys/register/finish', body),
    loginStart: (username: string) =>
      post<PasskeyStart>('/passkeys/login/start', { username }, { anonymous: true }),
    loginFinish: (body: unknown) =>
      post<AuthSession>('/passkeys/login/finish', body, { anonymous: true, sitzung: true }),
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
