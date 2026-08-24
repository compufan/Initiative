import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  envelope,
  parseEnvelope,
  type ClientEvent,
  type ServerEvent,
  type ServerEventType,
} from '@initiative/shared';
import { API_BASE, getTokens } from './api.js';

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

  get state(): ConnectionState {
    return this.currentState;
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private url(): string | null {
    const token = getTokens()?.accessToken;
    if (!token) return null;
    const base = API_BASE || window.location.origin;
    const url = new URL(REALTIME_PATH, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    return url.toString();
  }

  connect(): void {
    this.closedByUser = false;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = this.url();
    if (!url) return;

    this.setState('connecting');
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setState('online');
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      const frame = parseEnvelope(typeof event.data === 'string' ? event.data : '');
      if (!frame) return;
      this.emit(frame.type, frame.payload);
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.socket = null;
      this.setState('offline');
      if (!this.closedByUser) this.scheduleReconnect();
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
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
    if (document.visibilityState === 'visible') realtime.connect();
  });
}
