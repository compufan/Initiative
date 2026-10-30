import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  envelope,
  parseEnvelope,
  type ClientEvent,
  type ServerEvent,
  type ServerEventType,
} from '@initiative/shared';
import { API_BASE, echtzeitZugang, forceRefresh, getTokens, onTokenChange } from './api.js';
import { beiRueckkehr } from './wiederaufnahme.js';

/** Der Server schließt mit diesem Code, wenn das Token abgelaufen ist. */
const CLOSE_TOKEN_EXPIRED = 4401;
/**
 * So lange darf nach dem Zurückkommen die Antwort auf ein `ping` brauchen.
 * Eine lebende Leitung antwortet in Millisekunden; vier Sekunden lassen einem
 * schwachen Mobilnetz Luft und sind trotzdem kurz genug, dass niemand vor
 * einer veralteten Chatliste sitzt.
 */
const PONG_FRIST_MS = 4_000;
/**
 * War so lange nichts auf der Leitung, gilt sie beim Zurückkommen als tot,
 * ohne erst zu fragen: Der Server schickt mindestens auf jedes `ping` (alle
 * 25 s) ein `pong`. Länger Stille heisst, die App war eingefroren.
 */
const STILLE_MS = HEARTBEAT_INTERVAL_MS + 5_000;

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
  /**
   * Zählt jeden Verbindungsversuch und jedes Trennen. Ein `open`, das beim
   * Warten auf das Token überholt wurde (`reconnect` mittendrin), baut danach
   * keine zweite Leitung mehr auf.
   */
  private lauf = 0;
  /** Läuft, solange nach dem Zurückkommen auf ein Lebenszeichen gewartet wird. */
  private pongFrist: ReturnType<typeof setTimeout> | null = null;

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

    const lauf = ++this.lauf;
    this.setState('connecting');
    const token = await echtzeitZugang(); // Einmal-Ticket statt Zugriffstoken in der Adresse
    // Während des Wartens kann ein anderer Aufruf schon verbunden oder
    // getrennt haben.
    if (lauf !== this.lauf || this.socket || this.closedByUser) return;
    if (!token) {
      this.setState('idle');
      return;
    }

    const socket = new WebSocket(this.url(token));
    this.socket = socket;

    /*
     * Jeder Behandler prüft, ob er noch zur AKTUELLEN Verbindung gehört.
     *
     * `reconnect` (nach jeder Tokenrotation, also etwa alle Viertelstunde)
     * schliesst die alte Verbindung und öffnet sofort eine neue. Das `close`
     * der alten kommt aber erst danach an – und setzte bisher `this.socket`
     * auf `null`, obwohl dort schon die neue stand, und plante eine weitere
     * Verbindung. Die neue lief verwaist weiter: Zwei Leitungen, jedes
     * Ereignis doppelt, und beim nächsten `close` begann es von vorn.
     */
    const aktuell = () => this.socket === socket;

    socket.onopen = () => {
      if (!aktuell()) return;
      this.attempts = 0;
      this.setState('online');
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      if (!aktuell()) return;
      this.lastFrameAt = Date.now();
      const frame = parseEnvelope(typeof event.data === 'string' ? event.data : '');
      if (!frame) return;
      this.emit(frame.type, frame.payload);
    };

    socket.onclose = (event) => {
      if (!aktuell()) return;
      this.stopHeartbeat();
      this.socket = null;
      this.setState('offline');
      if (this.closedByUser) return;

      if (event.code === CLOSE_TOKEN_EXPIRED) {
        // Neues Token holen und sofort erneut verbinden, statt endlos mit dem
        // abgelaufenen abgewiesen zu werden.
        void forceRefresh().then((next) => {
          if (this.closedByUser) return;
          if (!next) this.setState('idle');
          // Kein neues Token bekommen (Drossel, Server im Neustart, kein
          // Netz): Sofort wieder zu verbinden hiesse, sofort wieder mit 4401
          // abgewiesen zu werden – eine Schleife ohne Pause gegen den Server.
          else if (next.accessToken === token) this.scheduleReconnect();
          else this.connect();
        });
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (!aktuell()) return;
      try {
        socket.close();
      } catch {
        /* handled by onclose */
      }
    };
  }

  disconnect(): void {
    this.lauf += 1;
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
   *
   * Hier stand: „Kommt der Ping nicht durch, neu aufbauen“ – geprüft am
   * Rückgabewert von `send`. Der ist aber immer wahr, solange `readyState`
   * OPEN sagt; ein toter Socket nimmt Daten klaglos in seinen Puffer. Die
   * Prüfung griff also nie, und auf dem iPhone blieb die Leitung nach dem
   * Aufwachen stumm, bis der Wachhund 25 bis 60 Sekunden später zuschlug.
   * Jetzt zählt nur, was ANKOMMT: lange Stille → sofort neu; sonst ein `ping`
   * mit kurzer Frist für die Antwort.
   */
  ensureFresh(): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastFrameAt > STILLE_MS) {
        this.leitungTot();
        return;
      }
      if (this.pongFrist) return;
      const stand = this.lastFrameAt;
      this.send({ type: 'ping', payload: {} });
      this.pongFrist = setTimeout(() => {
        this.pongFrist = null;
        if (this.socket === socket && this.lastFrameAt === stand) this.leitungTot();
      }, PONG_FRIST_MS);
      return;
    }
    if (socket?.readyState === WebSocket.CONNECTING) return;
    // Ein geplanter Neuversuch kann im Hintergrund auf 30 s angewachsen sein –
    // wer zurückkommt, soll nicht so lange warten.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  /**
   * Die Leitung ist tot, ohne dass sie es gemeldet hätte: neu aufbauen.
   *
   * Anders als `reconnect` meldet das den Zustand `offline` und nicht `idle` –
   * nur so wissen die Abnehmer (`connectChatRealtime`, `terminEreignisse`),
   * dass etwas verloren gegangen sein kann, und holen nach dem Wiederverbinden
   * nach. Vorher lief der Wachhund über `reconnect`, die Chats sahen nur
   * `idle → connecting → online` und holten nichts nach.
   */
  private leitungTot(): void {
    const alt = this.socket;
    this.lauf += 1;
    this.stopHeartbeat();
    this.socket = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      alt?.close();
    } catch {
      /* ist ohnehin tot */
    }
    this.setState('offline');
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
        this.leitungTot();
        return;
      }
      this.send({ type: 'ping', payload: {} });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.pongFrist) clearTimeout(this.pongFrist);
    this.pongFrist = null;
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
  // Beim Zurückkehren aus dem Hintergrund ist die Verbindung oft tot, ohne
  // dass ein `close` angekommen wäre – deshalb hier aktiv nachfassen. Alle
  // Signale des Zurückkommens (siehe `wiederaufnahme.ts`), nicht nur
  // `visibilitychange`: WebKit meldet die Rückkehr aus dem bfcache nur mit
  // `pageshow`.
  beiRueckkehr(() => {
    // Ohne Anmeldung gibt es nichts zu verbinden – auch nicht nach `online`.
    if (getTokens()) realtime.ensureFresh();
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
