import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstest: Nach `reconnect` liefen zwei Verbindungen.
 *
 * `reconnect` (bei jeder Tokenrotation) schliesst die alte Leitung und öffnet
 * sofort eine neue. Das `close` der alten kam danach an, setzte die neue als
 * „weg“ und plante eine dritte. Die neue lief verwaist weiter – jedes
 * Ereignis kam doppelt an.
 */

let token = 'a1';
vi.mock('./api.js', () => ({
  API_BASE: 'http://localhost',
  forceRefresh: vi.fn(async () => ({ accessToken: token })),
  getTokens: () => ({ accessToken: token }),
  onTokenChange: () => () => {},
  validAccessToken: vi.fn(async () => token),
  echtzeitZugang: vi.fn(async () => token),
}));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static alle: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.alle.push(this);
  }
  oeffnen() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** Wie im Browser: `close` meldet sich erst später. */
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSING;
  }
  geschlossenMelden(code = 1000) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  send() {}
  static offen() {
    return FakeSocket.alle.filter((s) => s.readyState === FakeSocket.OPEN);
  }
}

const warten = () => new Promise((fertig) => setTimeout(fertig, 0));

beforeEach(() => {
  vi.resetModules();
  FakeSocket.alle = [];
  token = 'a1';
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reconnect', () => {
  it('hält genau eine Verbindung, wenn das alte close später ankommt', async () => {
    const { RealtimeClient } = await import('./realtime.js');
    const client = new RealtimeClient();
    const empfangen: unknown[] = [];
    client.on('presence', (payload) => empfangen.push(payload));

    client.connect();
    await warten();
    const erste = FakeSocket.alle[0]!;
    erste.oeffnen();

    vi.useFakeTimers();
    token = 'a2';
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    const zweite = FakeSocket.alle[1]!;
    zweite.oeffnen();

    // Jetzt erst meldet die alte Leitung ihr Ende.
    erste.geschlossenMelden(1000);
    expect(client.state).toBe('online');

    // Kein geplanter Neuaufbau, der eine dritte Leitung öffnet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.alle).toHaveLength(2);

    // Ein Ereignis über die aktuelle Leitung kommt genau einmal an.
    const frame = JSON.stringify({
      v: 1,
      type: 'presence',
      payload: { userId: 'u', online: true, lastSeenAt: null },
    });
    zweite.onmessage?.({ data: frame });
    erste.onmessage?.({ data: frame });
    expect(empfangen).toHaveLength(1);
    client.disconnect();
  });

  it('verbindet nach einem überholten Versuch mit dem NEUEN Token', async () => {
    const { RealtimeClient } = await import('./realtime.js');
    const client = new RealtimeClient();
    client.connect();
    // Mitten im Warten auf das Token rotiert es (Anmeldung, anderer Tab).
    token = 'a2';
    client.reconnect();
    await warten();
    expect(FakeSocket.alle).toHaveLength(1);
    expect(FakeSocket.alle[0]!.url).toContain('token=a2');
    client.disconnect();
  });

  it('verbindet nach 4401 ohne neues Token nicht sofort wieder', async () => {
    const { RealtimeClient } = await import('./realtime.js');
    const client = new RealtimeClient();
    client.connect();
    await warten();
    FakeSocket.alle[0]!.oeffnen();

    vi.useFakeTimers();
    // Die Erneuerung liefert dasselbe Token (etwa 429 der Drossel).
    FakeSocket.alle[0]!.geschlossenMelden(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.alle).toHaveLength(1);
    // Mit Pause dann doch.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeSocket.alle).toHaveLength(2);
    client.disconnect();
  });
});
