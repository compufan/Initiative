import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const meta = new Map<string, unknown>();
const setzenMock = vi.fn();
const listeMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    isOffline = false;
    status = 0;
  },
  api: {
    messages: {
      entwurfSetzen: (...args: unknown[]) => setzenMock(...args),
      entwuerfe: () => listeMock(),
    },
  },
}));
vi.mock('../lib/db.js', () => ({
  readMeta: async (key: string) => meta.get(key) ?? null,
  writeMeta: async (key: string, value: unknown) => void meta.set(key, structuredClone(value)),
}));

let e: typeof import('./entwuerfe.js');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  meta.clear();
  setzenMock.mockReset();
  listeMock.mockReset();
  e = await import('./entwuerfe.js');
});

afterEach(() => vi.useRealTimers());

describe('Entwürfe', () => {
  it('neuester gewinnt, bei Gleichstand der Server', () => {
    const lokal = { text: 'a', replyToId: null, stand: 10, synchron: false };
    const server = { text: 'b', replyToId: null, stand: 20, synchron: true };
    expect(e.zusammenfuehren(lokal, server)).toBe(server);
    expect(e.zusammenfuehren({ ...lokal, stand: 30 }, server)?.text).toBe('a');
    expect(e.zusammenfuehren({ ...lokal, stand: 20 }, server)).toBe(server);
    expect(e.zusammenfuehren(undefined, server)).toBe(server);
  });

  it('tippen: sofort lokal, gedrosselt EINE Anfrage mit dem letzten Stand und dem Antwortbezug', async () => {
    setzenMock.mockImplementation(async (conversationId: string, body: { text: string; replyToId: string; stand: string }) => ({
      entwurf: { conversationId, text: body.text, replyToId: body.replyToId, updatedAt: body.stand },
      uebernommen: true,
    }));
    e.entwurfSetzen('c1', 'H', 'm1');
    e.entwurfSetzen('c1', 'Ha', 'm1');
    e.entwurfSetzen('c1', 'Hallo', 'm1');
    expect(e.useEntwuerfe.getState().entwuerfe.c1.text).toBe('Hallo');
    expect(setzenMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(e.SYNC_MS + 10);
    expect(setzenMock).toHaveBeenCalledTimes(1);
    expect(setzenMock.mock.calls[0][1]).toMatchObject({ text: 'Hallo', replyToId: 'm1' });
    expect(e.useEntwuerfe.getState().entwuerfe.c1.synchron).toBe(true);
    // Lokal gesichert.
    await vi.advanceTimersByTimeAsync(300);
    expect((meta.get('chatentwuerfe') as Record<string, { text: string }>).c1.text).toBe('Hallo');
  });

  it('ein neuerer Entwurf eines anderen Geräts überschreibt, ein älterer nicht', () => {
    e.entwurfSetzen('c1', 'hier', null);
    const hier = e.useEntwuerfe.getState().entwuerfe.c1.stand;
    e.entwurfVomServer({ conversationId: 'c1', text: 'alt', replyToId: null, updatedAt: new Date(hier - 5000).toISOString() });
    expect(e.useEntwuerfe.getState().entwuerfe.c1.text).toBe('hier');
    e.entwurfVomServer({ conversationId: 'c1', text: 'dort', replyToId: 'm9', updatedAt: new Date(hier + 5000).toISOString() });
    expect(e.useEntwuerfe.getState().entwuerfe.c1).toMatchObject({ text: 'dort', replyToId: 'm9' });
  });

  it('verliert der eigene Stand beim Server, gilt danach der gewinnende', async () => {
    setzenMock.mockResolvedValue({
      entwurf: { conversationId: 'c1', text: 'anderes Gerät', replyToId: null, updatedAt: new Date(Date.now() + 60_000).toISOString() },
      uebernommen: false,
    });
    e.entwurfSetzen('c1', 'meins', null);
    await vi.advanceTimersByTimeAsync(e.SYNC_MS + 10);
    expect(e.useEntwuerfe.getState().entwuerfe.c1.text).toBe('anderes Gerät');
  });

  it('nach dem Senden ist der Entwurf leer, mit neuem Stand', () => {
    e.entwurfSetzen('c1', 'gleich weg', 'm1');
    e.entwurfErledigt('c1');
    expect(e.useEntwuerfe.getState().entwuerfe.c1).toMatchObject({ text: '', replyToId: null });
  });

  it('beim Laden: Server-Entwürfe übernehmen, lokale nicht gesendete hochladen', async () => {
    meta.set('chatentwuerfe', {
      offline: { text: 'offline getippt', replyToId: null, stand: 5, synchron: false },
    });
    listeMock.mockResolvedValue({
      items: [{ conversationId: 'c2', text: 'vom Laptop', replyToId: null, updatedAt: '2026-01-01T00:00:00Z' }],
    });
    setzenMock.mockResolvedValue({
      entwurf: { conversationId: 'offline', text: 'offline getippt', replyToId: null, updatedAt: '2026-01-01T00:00:01Z' },
      uebernommen: true,
    });
    await e.entwuerfeLaden();
    expect(e.useEntwuerfe.getState().entwuerfe.c2.text).toBe('vom Laptop');
    await vi.advanceTimersByTimeAsync(10);
    expect(setzenMock).toHaveBeenCalledWith('offline', expect.objectContaining({ text: 'offline getippt' }));
  });
});
