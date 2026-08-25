import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests für die Wiederverbindung.
 *
 * Beide Fälle hier haben in der laufenden App echten Schaden angerichtet: Auf
 * dem Handy kamen Nachrichten erst nach dem Neuladen des Chats an, weil die
 * Verbindung still gestorben war beziehungsweise mit einem abgelaufenen Token
 * abgewiesen wurde.
 */

const HEARTBEAT = 25_000;

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Vom Server geschickter Frame. */
  receive(type: string): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type, ts: '', payload: {} }) });
  }
}

const tokenState = { access: 'gueltig-1', refreshed: 0 };

vi.mock('./api.js', () => ({
  API_BASE: 'https://api.example.com',
  getTokens: () => ({ accessToken: tokenState.access, refreshToken: 'r', expiresAt: Date.now() + 60_000 }),
  onTokenChange: () => () => {},
  validAccessToken: async () => tokenState.access,
  forceRefresh: async () => {
    tokenState.refreshed += 1;
    tokenState.access = `erneuert-${tokenState.refreshed}`;
    return { accessToken: tokenState.access, refreshToken: 'r', expiresAt: Date.now() + 60_000 };
  },
}));

let RealtimeClient: typeof import('./realtime.js').RealtimeClient;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  tokenState.access = 'gueltig-1';
  tokenState.refreshed = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  ({ RealtimeClient } = await import('./realtime.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Verbindet und wartet die Mikrotasks ab, die `validAccessToken` einschiebt. */
async function connected(client: InstanceType<typeof RealtimeClient>) {
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.instances.at(-1)!;
  socket.onopen?.();
  return socket;
}

describe('Wiederverbindung', () => {
  it('baut eine still gestorbene Verbindung neu auf', async () => {
    const client = new RealtimeClient();
    const first = await connected(client);
    expect(FakeSocket.instances).toHaveLength(1);

    // Der Server antwortet brav: Die Verbindung gilt als lebendig.
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    first.receive('pong');
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    first.receive('pong');
    expect(FakeSocket.instances).toHaveLength(1);

    // Jetzt schweigt der Server – der Socket steht formal weiter auf OPEN.
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 3);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it('holt nach Ablehnung mit 4401 ein neues Token und verbindet erneut', async () => {
    const client = new RealtimeClient();
    const first = await connected(client);
    expect(first.url).toContain('gueltig-1');

    // Der Server weist das abgelaufene Token ab.
    first.close(4401);
    await vi.advanceTimersByTimeAsync(0);

    expect(tokenState.refreshed).toBe(1);
    const second = FakeSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url).toContain('erneuert-1');
  });

  it('verbindet nach einem gewoehnlichen Abbruch mit Verzoegerung neu', async () => {
    const client = new RealtimeClient();
    const first = await connected(client);

    first.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    // Sofort passiert nichts – erst nach dem Backoff.
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(tokenState.refreshed).toBe(0);
  });
});
