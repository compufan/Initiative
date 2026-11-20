import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Offline-Warteschlange für Bearbeiten, Löschen und Reaktionen: sofort
 * sichtbar, offline aufgehoben, bei Verbindung genau einmal gesendet.
 */

const meta = new Map<string, unknown>();
const editMock = vi.fn();
const reactMock = vi.fn();
const removeMock = vi.fn();
let offline = false;

class FakeApiError extends Error {
  isOffline: boolean;
  status: number;
  constructor(offlineFehler: boolean, status = 0) {
    super(offlineFehler ? 'offline' : 'abgelehnt');
    this.isOffline = offlineFehler;
    this.status = status;
  }
}

function netz<T>(fn: () => T): T {
  if (offline) throw new FakeApiError(true);
  return fn();
}

vi.mock('../lib/api.js', () => ({
  ApiError: FakeApiError,
  getTokens: () => null,
  api: {
    messages: {
      edit: async (id: string, body: string) => netz(() => editMock(id, body)),
      react: async (id: string, emoji: string) => netz(() => reactMock(id, emoji)),
      unreact: async (id: string, emoji: string) => netz(() => reactMock(id, emoji, 'weg')),
      remove: async (id: string, scope: string) => netz(() => removeMock(id, scope)),
      list: vi.fn().mockResolvedValue({ items: [] }),
      sternKennungen: vi.fn().mockResolvedValue({ items: [] }),
      entwuerfe: vi.fn().mockResolvedValue({ items: [] }),
    },
    conversations: { list: vi.fn().mockResolvedValue({ items: [] }) },
  },
}));

vi.mock('../lib/realtime.js', () => ({
  realtime: { on: () => () => {}, send: () => true, onStateChange: () => () => {} },
}));

vi.mock('../lib/db.js', () => ({
  cacheConversations: vi.fn(),
  cacheMessages: vi.fn(),
  dropCachedMessage: vi.fn(),
  enqueueOutbox: vi.fn(),
  readCachedConversations: vi.fn().mockResolvedValue([]),
  readCachedMessages: vi.fn().mockResolvedValue([]),
  readOutbox: async () => [],
  removeCachedConversation: vi.fn(),
  removeOutbox: vi.fn(),
  outboxErledigt: vi.fn(),
  trimMessageCache: vi.fn(),
  updateOutbox: vi.fn(),
  readMeta: async (key: string) => meta.get(key) ?? null,
  writeMeta: async (key: string, value: unknown) => void meta.set(key, structuredClone(value)),
}));

vi.mock('../lib/upload.js', () => ({ uploadBlob: vi.fn() }));

let chat: typeof import('./chat.js');

const nachricht = {
  id: 'm1',
  conversationId: 'c1',
  senderId: 'ich',
  type: 'text' as const,
  body: 'alt',
  attachments: [],
  replyToId: null,
  replyTo: null,
  metadata: {},
  reactions: [],
  clientId: null,
  createdAt: '2026-01-01T00:00:00Z',
  editedAt: null,
  deletedAt: null,
};

beforeEach(async () => {
  vi.resetModules();
  meta.clear();
  offline = false;
  editMock.mockReset();
  reactMock.mockReset();
  removeMock.mockReset();
  chat = await import('./chat.js');
  chat.useChat.setState({ messages: { c1: [{ ...nachricht }] } });
});

describe('Aktionswarteschlange im Chat', () => {
  it('offline bearbeitet: sofort sichtbar, aufgehoben, später genau einmal gesendet', async () => {
    offline = true;
    await chat.useChat.getState().editMessage(nachricht, 'neu');
    expect(chat.useChat.getState().messages.c1[0].body).toBe('neu');
    expect(chat.ausstehend()).toHaveLength(1);
    // Im Speicher, damit ein Neustart sie nicht verliert.
    expect(meta.get('aktionen')).toHaveLength(1);

    offline = false;
    editMock.mockImplementation(async (id: string, body: string) => ({ ...nachricht, id, body, editedAt: 'jetzt' }));
    await chat.aktionenAbarbeiten();
    await chat.aktionenAbarbeiten();
    expect(editMock).toHaveBeenCalledTimes(1);
    expect(chat.ausstehend()).toHaveLength(0);
    expect(chat.useChat.getState().messages.c1[0]).toMatchObject({ body: 'neu', editedAt: 'jetzt' });
  });

  it('zweimal dieselbe Reaktion offline: am Ende nichts gesetzt, eine Anfrage', async () => {
    offline = true;
    await chat.useChat.getState().toggleReaction(nachricht, '❤️', false);
    expect(chat.useChat.getState().messages.c1[0].reactions).toHaveLength(1);
    await chat.useChat.getState().toggleReaction(chat.useChat.getState().messages.c1[0], '❤️', true);
    expect(chat.useChat.getState().messages.c1[0].reactions).toHaveLength(0);
    offline = false;
    reactMock.mockResolvedValue({ reactions: [] });
    await chat.aktionenAbarbeiten();
    expect(reactMock).toHaveBeenCalledTimes(1);
    expect(reactMock).toHaveBeenCalledWith('m1', '❤️', 'weg');
  });

  it('offline gelöscht bleibt weg – auch wenn der Server die Nachricht noch einmal liefert', async () => {
    offline = true;
    await chat.useChat.getState().deleteMessage(nachricht, 'me');
    expect(chat.useChat.getState().messages.c1).toHaveLength(0);
    chat.useChat.getState().applyMessage({ ...nachricht });
    expect(chat.useChat.getState().messages.c1).toHaveLength(0);
    offline = false;
    removeMock.mockResolvedValue(undefined);
    await chat.aktionenAbarbeiten();
    expect(removeMock).toHaveBeenCalledWith('m1', 'me');
  });

  it('eine Ablehnung des Servers wird gemeldet und nicht ewig wiederholt', async () => {
    editMock.mockRejectedValue(new FakeApiError(false, 403));
    await expect(chat.useChat.getState().editMessage(nachricht, 'neu')).rejects.toThrow();
    expect(chat.ausstehend()).toHaveLength(0);
  });

  it('nach einem Neustart: aus dem Speicher weiter', async () => {
    offline = true;
    await chat.useChat.getState().deleteMessage(nachricht, 'all');
    vi.resetModules();
    chat = await import('./chat.js');
    offline = false;
    removeMock.mockResolvedValue(undefined);
    await chat.useChat.getState().hydrate();
    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledWith('m1', 'all'));
  });
});
