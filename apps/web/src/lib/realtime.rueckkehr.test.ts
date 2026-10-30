import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zurück aus dem Hintergrund (iPhone): Die Leitung ist eingefroren gestorben,
 * ohne `close`. Der Socket steht weiter auf OPEN, schluckt jedes `send` – und
 * bringt nichts mehr.
 *
 * Vorher prüfte `ensureFresh` nur den Rückgabewert von `send` (immer wahr),
 * und der Wachhund baute über `reconnect` neu auf, was als `idle` statt
 * `offline` gemeldet wurde – die Chats holten danach nichts nach.
 */

vi.mock('./api.js', () => ({
  API_BASE: 'http://localhost',
  forceRefresh: vi.fn(async () => ({ accessToken: 't' })),
  getTokens: () => ({ accessToken: 't' }),
  onTokenChange: () => () => {},
  validAccessToken: vi.fn(async () => 't'),
  echtzeitZugang: vi.fn(async () => 't'),
}));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static alle: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  gesendet: string[] = [];
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
  /** Eingefroren gestorben: kein close, kein Fehler – nur Stille. */
  close() {}
  send(daten: string) {
    this.gesendet.push(daten);
  }
  antworten() {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type: 'pong', payload: {} }) });
  }
}

async function verbunden() {
  const { RealtimeClient } = await import('./realtime.js');
  const client = new RealtimeClient();
  const zustaende: string[] = [];
  client.onStateChange((zustand) => zustaende.push(zustand));
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  FakeSocket.alle[0]!.oeffnen();
  return { client, zustaende };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeSocket.alle = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ensureFresh', () => {
  it('baut nach langer Stille sofort neu auf und meldet „offline“', async () => {
    const { client, zustaende } = await verbunden();
    // Eingefroren: Uhrzeit springt, Zeitgeber laufen nicht.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    client.ensureFresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.alle).toHaveLength(2);
    expect(zustaende).toContain('offline');
    FakeSocket.alle[1]!.oeffnen();
    expect(client.state).toBe('online');
    client.disconnect();
  });

  it('fragt bei kurzer Pause mit ping nach – ohne Antwort neu', async () => {
    const { client, zustaende } = await verbunden();
    await vi.advanceTimersByTimeAsync(3_000);
    client.ensureFresh();
    client.ensureFresh(); // doppelt (visibilitychange + focus): ein ping
    const pings = FakeSocket.alle[0]!.gesendet.filter((frame) => frame.includes('"ping"'));
    expect(pings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeSocket.alle).toHaveLength(2);
    expect(zustaende.slice(-2)).toEqual(['offline', 'connecting']);
    client.disconnect();
  });

  it('lässt eine lebende Leitung stehen', async () => {
    const { client } = await verbunden();
    await vi.advanceTimersByTimeAsync(3_000);
    client.ensureFresh();
    FakeSocket.alle[0]!.antworten();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.alle).toHaveLength(1);
    expect(client.state).toBe('online');
    client.disconnect();
  });

  it('der Wachhund meldet eine tote Leitung als „offline“, damit nachgeholt wird', async () => {
    const { client, zustaende } = await verbunden();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(FakeSocket.alle.length).toBeGreaterThanOrEqual(2);
    expect(zustaende).toContain('offline');
    expect(zustaende).not.toContain('idle');
    client.disconnect();
  });
});

describe('gedrosselt und beiRueckkehr', () => {
  it('ruft sofort, fasst Folgeanstösse zu einem Nachzügler zusammen', async () => {
    const { gedrosselt } = await import('./wiederaufnahme.js');
    const aufgabe = vi.fn();
    const los = gedrosselt(aufgabe, 2_000);
    los();
    los();
    los();
    expect(aufgabe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(aufgabe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aufgabe).toHaveBeenCalledTimes(2);
    los();
    expect(aufgabe).toHaveBeenCalledTimes(3);
  });

  it('hört auf sichtbar, pageshow, focus und online – nicht auf verborgen', async () => {
    const { beiRueckkehr } = await import('./wiederaufnahme.js');
    const fenster = new EventTarget();
    const dokument = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    const zurueck = vi.fn();
    const ab = beiRueckkehr(zurueck, {
      fenster: fenster as unknown as Window,
      dokument: dokument as unknown as Document,
    });
    dokument.dispatchEvent(new Event('visibilitychange'));
    expect(zurueck).not.toHaveBeenCalled();
    dokument.visibilityState = 'visible';
    dokument.dispatchEvent(new Event('visibilitychange'));
    for (const art of ['pageshow', 'focus', 'online']) fenster.dispatchEvent(new Event(art));
    expect(zurueck).toHaveBeenCalledTimes(4);
    ab();
    fenster.dispatchEvent(new Event('focus'));
    expect(zurueck).toHaveBeenCalledTimes(4);
  });
});
