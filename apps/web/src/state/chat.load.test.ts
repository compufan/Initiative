import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstest: Verlauf verschwindet nach dem Neuladen.
 *
 * Der Chat-Zustand wird schon vor dem Öffnen eines Chats gefüllt – Realtime
 * verteilt neue Nachrichten an alle Mitglieder, und wartende Einträge aus der
 * Outbox landen ebenfalls dort. Früher galt „im Zustand liegt eine Nachricht“
 * als „Chat ist geladen“. Dadurch wurden der Cache und die erste Seite
 * übersprungen und `hasMore` nie gesetzt, sodass sich der Verlauf nicht einmal
 * mehr hochscrollen liess.
 */

const listMock = vi.fn();
const cachedMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    isOffline = false;
  },
  api: {
    messages: { list: (...args: unknown[]) => listMock(...args) },
    conversations: { list: vi.fn().mockResolvedValue({ items: [] }) },
  },
}));

vi.mock('../lib/realtime.js', () => ({
  realtime: { on: () => () => {}, send: () => true, connect: () => {}, onStateChange: () => () => {} },
}));

vi.mock('../lib/db.js', () => ({
  cacheConversations: vi.fn(),
  cacheMessages: vi.fn(),
  dropCachedMessage: vi.fn(),
  enqueueOutbox: vi.fn(),
  readCachedConversations: vi.fn().mockResolvedValue([]),
  readCachedMessages: (...args: unknown[]) => cachedMock(...args),
  readOutbox: vi.fn().mockResolvedValue([]),
  removeCachedConversation: vi.fn(),
  removeOutbox: vi.fn(),
  trimMessageCache: vi.fn(),
  updateOutbox: vi.fn(),
}));

vi.mock('../lib/upload.js', () => ({ uploadBlob: vi.fn() }));

const message = (id: string) => ({
  id,
  conversationId: 'c1',
  senderId: 'u1',
  type: 'text',
  body: id,
  reactions: [],
  attachments: [],
  createdAt: '2026-01-01T00:00:00Z',
});

let useChat: typeof import('./chat.js').useChat;

beforeEach(async () => {
  vi.resetModules();
  listMock.mockReset();
  cachedMock.mockReset();
  ({ useChat } = await import('./chat.js'));
});

describe('loadMessages', () => {
  it('holt Verlauf und setzt hasMore, auch wenn schon eine Nachricht im Zustand liegt', async () => {
    // So sieht es nach dem Neuladen aus: Realtime hat eine einzelne Nachricht
    // eingetragen, der Chat war aber nie geöffnet.
    useChat.setState({ messages: { c1: [message('03-live') as never] } });

    cachedMock.mockResolvedValue([message('01-alt'), message('02-alt')]);
    listMock.mockResolvedValue({ items: [message('03-live')], nextCursor: 'weiter' });

    await useChat.getState().loadMessages('c1');

    // Der Cache muss gelesen worden sein ...
    expect(cachedMock).toHaveBeenCalledWith('c1');
    // ... der Verlauf im Zustand stehen ...
    const ids = (useChat.getState().messages.c1 ?? []).map((m) => m.id);
    expect(ids).toContain('01-alt');
    expect(ids).toContain('02-alt');
    // ... und Hochscrollen möglich sein.
    expect(useChat.getState().hasMore.c1).toBe(true);
    expect(useChat.getState().loaded.c1).toBe(true);
  });

  it('holt beim zweiten Oeffnen nicht erneut die erste Seite', async () => {
    cachedMock.mockResolvedValue([]);
    listMock.mockResolvedValue({ items: [message('01')], nextCursor: null });

    await useChat.getState().loadMessages('c1');
    expect(listMock).toHaveBeenCalledTimes(1);

    // Zweiter Aufruf: nur noch das leichte Nachziehen, keine erste Seite.
    listMock.mockResolvedValue({ items: [] });
    await useChat.getState().loadMessages('c1');
    expect(cachedMock).toHaveBeenCalledTimes(1);
  });
});
