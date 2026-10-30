import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../lib/realtime.js';

/**
 * Ungelesen-Zähler: eigene und gelesene Nachrichten zählen nie.
 *
 * Gemeldet: Gelesene Nachrichten blieben in der Chatliste hervorgehoben, auch
 * eigene. Geprüft werden die Rennen: Nachricht kommt in den offenen Chat; die
 * Antwort der Liste kommt der Lesemeldung zuvor; ein anderes Gerät liest.
 */

const listMock = vi.fn();
const markReadMock = vi.fn();
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
    conversations: {
      list: (...args: unknown[]) => conversationsListMock(...args),
      markRead: (...args: unknown[]) => markReadMock(...args),
    },
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

async function warten() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

let chat: typeof import('./chat.js');
let sicht: typeof import('./sichtbarkeit.js');

function nachricht(id: string, senderId: string | null, extra: object = {}) {
  return {
    id,
    conversationId: 'c1',
    senderId,
    type: 'text',
    body: 'hallo',
    createdAt: new Date().toISOString(),
    deletedAt: null,
    ...extra,
  };
}

function chatEintrag(unreadCount: number, letzte: string) {
  return {
    id: 'c1',
    unreadCount,
    members: [{ userId: 'ich', lastReadMessageId: null }],
    lastMessage: nachricht(letzte, 'du'),
  } as never;
}

function zaehler() {
  return chat.useChat.getState().conversations[0]!.unreadCount;
}

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  markReadMock.mockReset().mockResolvedValue({ ok: true });
  conversationsListMock.mockReset().mockResolvedValue({ items: [] });
  listMock.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  chat = await import('./chat.js');
  sicht = await import('./sichtbarkeit.js');
  chat.connectChatRealtime();
  chat.useChat.setState({ conversations: [chatEintrag(0, '0001')], messages: {} });
});

describe('Chat offen', () => {
  it('zählt nicht hoch, was in den offenen, sichtbaren Chat kommt', () => {
    sicht.chatOffenSetzen('c1');
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    expect(zaehler()).toBe(0);
  });

  it('zählt hoch, wenn der Chat offen ist, aber nach oben gescrollt', () => {
    sicht.chatOffenSetzen('c1');
    sicht.untenSetzen(false);
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    expect(zaehler()).toBe(1);
  });

  it('zählt hoch, wenn der Chat nicht offen ist', () => {
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    expect(zaehler()).toBe(1);
  });

  it('eigene Nachrichten zählen nie – auch nicht vom eigenen anderen Gerät', () => {
    handlers.get('message.new')!({ message: nachricht('0002', 'ich') } as never);
    handlers.get('message.new')!({ message: nachricht('0003', 'ich', { clientId: 'x' }) } as never);
    expect(zaehler()).toBe(0);
  });

  it('meldet das Lesen auch dann, wenn der Zähler nie hochging', async () => {
    sicht.chatOffenSetzen('c1');
    handlers.get('message.new')!({ message: nachricht('0002', 'du') } as never);
    chat.useChat.getState().markRead('c1');
    expect(markReadMock).toHaveBeenCalledWith('c1', '0002');
    // Nicht zweimal dieselbe Meldung.
    chat.useChat.getState().markRead('c1');
    expect(markReadMock).toHaveBeenCalledOnce();
    // Eine weitere Nachricht: wieder melden.
    handlers.get('message.new')!({ message: nachricht('0003', 'du') } as never);
    chat.useChat.getState().markRead('c1');
    expect(markReadMock).toHaveBeenLastCalledWith('c1', '0003');
  });

  it('meldet nichts für eine eigene letzte Nachricht', () => {
    chat.useChat.setState({
      messages: { c1: [nachricht('0002', 'ich') as never] },
    });
    chat.useChat.getState().markRead('c1');
    expect(markReadMock).not.toHaveBeenCalled();
  });

  it('versucht es erneut, wenn die Meldung scheitert', async () => {
    markReadMock.mockRejectedValueOnce(new Error('offline'));
    chat.useChat.setState({ messages: { c1: [nachricht('0002', 'du') as never] } });
    chat.useChat.getState().markRead('c1');
    await warten();
    chat.useChat.getState().markRead('c1');
    expect(markReadMock).toHaveBeenCalledTimes(2);
  });
});

describe('Antwort des Servers kommt der Lesemeldung zuvor', () => {
  it('die Liste setzt den offenen Chat auf 0, auch wenn der Server noch 1 zählt', async () => {
    sicht.chatOffenSetzen('c1');
    conversationsListMock.mockResolvedValue({ items: [chatEintrag(1, '0002')] });
    await chat.useChat.getState().loadConversations();
    expect(zaehler()).toBe(0);
  });

  it('die Liste setzt einen schon gemeldeten Chat auf 0, auch wenn er nicht mehr offen ist', async () => {
    chat.useChat.setState({ messages: { c1: [nachricht('0002', 'du') as never] } });
    chat.useChat.getState().markRead('c1');
    conversationsListMock.mockResolvedValue({ items: [chatEintrag(1, '0002')] });
    await chat.useChat.getState().loadConversations();
    expect(zaehler()).toBe(0);
    // Eine neuere Nachricht ist dagegen neu.
    conversationsListMock.mockResolvedValue({ items: [chatEintrag(1, '0003')] });
    await chat.useChat.getState().loadConversations();
    expect(zaehler()).toBe(1);
  });
});

describe('Zweites Gerät', () => {
  it('Lesen auf dem anderen Gerät setzt den Zähler hier auf 0', () => {
    chat.useChat.setState({ conversations: [chatEintrag(2, '0003')] });
    handlers.get('read.updated')!({
      conversationId: 'c1',
      userId: 'ich',
      lastReadMessageId: '0003',
    } as never);
    expect(zaehler()).toBe(0);
  });

  it('Lesen eines anderen Mitglieds ändert meinen Zähler nicht', () => {
    chat.useChat.setState({ conversations: [chatEintrag(2, '0003')] });
    handlers.get('read.updated')!({
      conversationId: 'c1',
      userId: 'du',
      lastReadMessageId: '0003',
    } as never);
    expect(zaehler()).toBe(2);
  });

  it('Lesen bis mitten im Chat lässt den Zähler stehen (holt nach)', () => {
    chat.useChat.setState({ conversations: [chatEintrag(2, '0003')] });
    handlers.get('read.updated')!({
      conversationId: 'c1',
      userId: 'ich',
      lastReadMessageId: '0002',
    } as never);
    expect(zaehler()).toBe(2);
  });
});
