import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../lib/realtime.js';

/**
 * Nachholen, was über die Leitung verloren ging.
 *
 * Zwei Wege, auf denen Ereignisse ausfallen, ohne dass der Client es merkt:
 * Der Server schließt eine Leitung, deren Ausgangspuffer vollläuft, und sein
 * Rundruf-Bus kann abreißen (dann schickt er nach dem Wiederverbinden einen
 * Hinweis ohne Chat und Termin). In beiden Fällen müssen Chatliste und die
 * geladenen Chats neu kommen – vorher passierte beim Wiederverbinden nichts.
 */

const listMock = vi.fn();
const conversationsListMock = vi.fn();
const handlers = new Map<string, (payload: never) => void>();
const zustaende: ((state: ConnectionState) => void)[] = [];

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    isOffline = false;
    status = 0;
  },
  api: {
    messages: { list: (...args: unknown[]) => listMock(...args) },
    conversations: { list: (...args: unknown[]) => conversationsListMock(...args) },
    calendar: { byId: vi.fn() },
  },
}));

vi.mock('../lib/realtime.js', () => ({
  realtime: {
    on: (type: string, handler: (payload: never) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    send: () => true,
    connect: () => {},
    onStateChange: (handler: (state: ConnectionState) => void) => {
      zustaende.push(handler);
      return () => {};
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  cacheConversations: vi.fn(),
  cacheMessages: vi.fn(),
  dropCachedMessage: vi.fn(),
  enqueueOutbox: vi.fn(),
  readCachedConversations: vi.fn().mockResolvedValue([]),
  readCachedMessages: vi.fn().mockResolvedValue([]),
  readOutbox: vi.fn().mockResolvedValue([]),
  removeCachedConversation: vi.fn(),
  removeOutbox: vi.fn(),
  trimMessageCache: vi.fn(),
  updateOutbox: vi.fn(),
}));

vi.mock('../lib/upload.js', () => ({ uploadBlob: vi.fn() }));

let chat: typeof import('./chat.js');

async function warten() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function zustand(state: ConnectionState) {
  for (const handler of zustaende) handler(state);
}

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  zustaende.length = 0;
  listMock.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  conversationsListMock.mockReset().mockResolvedValue({ items: [] });
  chat = await import('./chat.js');
  chat.connectChatRealtime();
  chat.useChat.setState({ loaded: { offen: true, zu: false } });
});

describe('Nachholen', () => {
  it('holt nach einem allgemeinen Hinweis Liste und geladene Chats', async () => {
    handlers.get('sync.hint')!({ scope: 'realtime', conversationId: null } as never);
    await warten();
    expect(conversationsListMock).toHaveBeenCalledOnce();
    expect(listMock.mock.calls.map(([id]) => id)).toEqual(['offen']);
  });

  it('holt nach dem Wiederverbinden nach – nicht schon beim ersten Verbinden', async () => {
    zustand('connecting');
    zustand('online');
    await warten();
    expect(conversationsListMock).not.toHaveBeenCalled();

    zustand('offline');
    zustand('connecting');
    zustand('online');
    await warten();
    expect(conversationsListMock).toHaveBeenCalledOnce();
    expect(listMock.mock.calls.map(([id]) => id)).toEqual(['offen']);
  });

  it('lässt einen Termin-Hinweis dem Trichter', async () => {
    handlers.get('sync.hint')!({ scope: 'event.updated', eventId: 't1' } as never);
    await warten();
    expect(conversationsListMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });
});
