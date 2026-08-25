import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  envelope,
  parseEnvelope,
  type ClientEvent,
  type ServerEvent,
  type ServerEventType,
} from '@initiative/shared';
import { API_BASE, forceRefresh, getTokens, onTokenChange, validAccessToken } from './api.js';

/** Der Server schließt mit diesem Code, wenn das Token abgelaufen ist. */
const CLOSE_TOKEN_EXPIRED = 4401;

type Handler = (payload: never) => void;
type AnyServerEvent = ServerEvent;

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'offline';

/**
 * Websocket client with exponential backoff, heartbeats and an offline-aware
 * reconnect. Feature modules subscribe to the events they care about; unknown
 * event types are ignored, so a newer server never breaks an older client.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private closedByUser = false;
  private currentState: ConnectionState = 'idle';
  /** Zeitpunkt des letzten empfangenen Frames – Grundlage des Wachhunds. */
  private lastFrameAt = 0;

  get state(): ConnectionState {
    return this.currentState;
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private url(token: string): string {
    const base = API_BASE || window.location.origin;
    const url = new URL(REALTIME_PATH, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    return url.toString();
  }

  connect(): void {
    void this.open();
  }

  /**
   * Öffnet die Verbindung mit einem *gültigen* Token.
   *
   * Wichtig: Nach einer Pause (Bildschirm aus, App im Hintergrund) ist das
   * Zugriffstoken meist abgelaufen. Früher wurde stur mit dem alten Token neu
   * verbunden – der Server wies das mit 4401 ab, und der Chat blieb bis zum
   * manuellen Neuladen stumm.
   */
  private async open(): Promise<void> {
    this.closedByUser = false;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.setState('connecting');
    const token = await validAccessToken();
    if (!token) {
      this.setState('idle');
      return;
    }
    // Während des Wartens kann ein anderer Aufruf schon verbunden haben.
    if (this.socket || this.closedByUser) return;

    const socket = new WebSocket(this.url(token));
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setState('online');
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      this.lastFrameAt = Date.now();
      const frame = parseEnvelope(typeof event.data === 'string' ? event.data : '');
      if (!frame) return;
      this.emit(frame.type, frame.payload);
    };

    socket.onclose = (event) => {
      this.stopHeartbeat();
      this.socket = null;
      this.setState('offline');
      if (this.closedByUser) return;

      if (event.code === CLOSE_TOKEN_EXPIRED) {
        // Neues Token holen und sofort erneut verbinden, statt endlos mit dem
        // abgelaufenen abgewiesen zu werden.
        void forceRefresh().then((next) => {
          if (this.closedByUser) return;
          if (next) this.connect();
          else this.setState('idle');
        });
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* handled by onclose */
      }
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempts = 0;
    try {
      this.socket?.close(1000, 'client');
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.setState('idle');
  }

  /** Re-open with a fresh token (after login or token rotation). */
  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  /**
   * Prüft beim Zurückkehren in den Vordergrund, ob die Verbindung wirklich noch
   * lebt. Ein im Hintergrund gestorbener Socket meldet sich oft nicht mit
   * `close`; er steht dann formal auf OPEN, überträgt aber nichts mehr.
   */
  ensureFresh(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      // Kommt der Ping nicht durch, ist die Leitung tot – neu aufbauen.
      if (!this.send({ type: 'ping', payload: {} })) this.reconnect();
      return;
    }
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Herzschlag mit Wachhund.
   *
   * Ein im Hintergrund eingefrorener Socket meldet oft kein `close`: Er steht
   * formal weiter auf OPEN, überträgt aber nichts mehr. Genau dann kam auf dem
   * Handy nichts mehr an, bis man den Chat neu geladen hat. Der Server
   * beantwortet jedes `ping` mit `pong` – bleibt diese Antwort aus, ist die
   * Leitung tot und wird neu aufgebaut.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastFrameAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > HEARTBEAT_INTERVAL_MS * 2.5) {
        this.reconnect();
        return;
      }
      this.send({ type: 'ping', payload: {} });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(event: ClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(envelope(event.type, event.payload)));
    return true;
  }

  on<T extends ServerEventType>(
    type: T,
    handler: (payload: Extract<AnyServerEvent, { type: T }>['payload']) => void,
  ): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private emit(type: string, payload: unknown): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (value: unknown) => void)(payload);
      } catch (error) {
        console.error('realtime handler failed', type, error);
      }
    }
  }
}

export const realtime = new RealtimeClient();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => realtime.connect());
  document.addEventListener('visibilitychange', () => {
    // Beim Zurückkehren aus dem Hintergrund ist die Verbindung meist tot, ohne
    // dass ein `close` angekommen wäre – deshalb hier aktiv nachfassen.
    if (document.visibilityState === 'visible') realtime.ensureFresh();
  });

  // Nach einem Tokenwechsel (Anmeldung, Rotation, auch in einem anderen Tab)
  // trägt die offene Verbindung noch das alte Token.
  let lastToken = getTokens()?.accessToken ?? null;
  onTokenChange((next) => {
    const token = next?.accessToken ?? null;
    if (token === lastToken) return;
    lastToken = token;
    if (token) realtime.reconnect();
    else realtime.disconnect();
  });
}
