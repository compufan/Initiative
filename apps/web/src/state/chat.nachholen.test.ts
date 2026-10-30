import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // Ein Token, dessen `sub` die eigene Kennung ist (Kopf.Nutzlast.Signatur).
  getTokens: () => ({
    accessToken: `x.${Buffer.from(JSON.stringify({ sub: 'ich' })).toString('base64url')}.y`,
  }),
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

const aboAuffrischen = vi.fn(async () => null);
vi.mock('../lib/push.js', () => ({ aboAuffrischen: () => aboAuffrischen() }));

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

/**
 * iPhone: Die App kommt aus dem Hintergrund zurück, die Leitung ist ohne
 * `close` gestorben, ihr Zustand steht weiter auf „online“. Vorher holte
 * dann nichts nach – die Chatliste zeigte nicht, dass jemand geantwortet
 * hatte. Jetzt löst jedes Zurückkommen und jede eingetroffene Mitteilung
 * (Botschaft des Service Workers) das Nachholen aus, gedrosselt.
 */
describe('Nachholen beim Zurückkommen', () => {
  let fenster: EventTarget;
  let dokument: EventTarget & { visibilityState: string };
  let sw: EventTarget;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    handlers.clear();
    zustaende.length = 0;
    conversationsListMock.mockClear();
    listMock.mockClear();
    aboAuffrischen.mockClear();
    fenster = new EventTarget();
    dokument = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    sw = new EventTarget();
    vi.stubGlobal('window', fenster);
    vi.stubGlobal('document', dokument);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    chat = await import('./chat.js');
    chat.connectChatRealtime();
    chat.useChat.setState({ loaded: { offen: true } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holt beim Sichtbarwerden Liste und offene Chats nach', async () => {
    dokument.dispatchEvent(new Event('visibilitychange'));
    expect(conversationsListMock).not.toHaveBeenCalled();
    dokument.visibilityState = 'visible';
    dokument.dispatchEvent(new Event('visibilitychange'));
    await warten();
    expect(conversationsListMock).toHaveBeenCalledOnce();
    expect(listMock.mock.calls.map(([id]) => id)).toEqual(['offen']);
  });

  it('drosselt: sichtbar + pageshow + focus + Wiederverbinden = sofort und ein Nachzügler', async () => {
    dokument.visibilityState = 'visible';
    dokument.dispatchEvent(new Event('visibilitychange'));
    fenster.dispatchEvent(new Event('pageshow'));
    fenster.dispatchEvent(new Event('focus'));
    zustand('offline');
    zustand('online');
    await warten();
    expect(conversationsListMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(conversationsListMock).toHaveBeenCalledTimes(2);
  });

  it('eine eingetroffene Mitteilung holt die Liste nach', async () => {
    sw.dispatchEvent(
      Object.assign(new Event('message'), { data: { type: 'push', payload: { title: 'x' } } }),
    );
    await warten();
    expect(conversationsListMock).toHaveBeenCalledOnce();
  });

  it('ein ausgetauschtes Push-Abo wird neu angemeldet', async () => {
    expect(aboAuffrischen).toHaveBeenCalledOnce(); // beim Start
    sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'push-abo-geaendert' } }));
    expect(aboAuffrischen).toHaveBeenCalledTimes(2);
  });
});

describe('Ungelesen-Zähler live', () => {
  function nachricht(id: string, senderId: string | null) {
    return {
      id,
      conversationId: 'c1',
      senderId,
      type: 'text',
      body: 'hallo',
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
  }

  beforeEach(() => {
    chat.useChat.setState({
      conversations: [
        {
          id: 'c1',
          unreadCount: 1,
          lastMessage: nachricht('0001', 'du'),
        } as never,
      ],
      messages: {},
    });
  });

  function zaehler() {
    return chat.useChat.getState().conversations[0]!.unreadCount;
  }

  it('zählt eine fremde neue Nachricht mit – einmal, nicht bei der eigenen', () => {
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    expect(zaehler()).toBe(2);
    expect(chat.useChat.getState().conversations[0]!.lastMessage!.id).toBe('0002');
    // Dieselbe noch einmal (Nachholen und Leitung überschneiden sich).
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    expect(zaehler()).toBe(2);
    handlers.get('message.new')!({ message: nachricht('0003', 'ich') } as never);
    expect(zaehler()).toBe(2);
    // Systemzeilen zählt der Server auch.
    handlers.get('message.new')!({ message: nachricht('0004', null) } as never);
    expect(zaehler()).toBe(3);
  });

  it('holt die Liste, wenn der Chat darin noch fehlt', async () => {
    handlers.get('message.new')!({
      message: { ...nachricht('0005', 'du'), conversationId: 'neu' },
    } as never);
    await warten();
    expect(conversationsListMock).toHaveBeenCalledOnce();
  });
});
