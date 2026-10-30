import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstest: Eine Nachricht, abgeschickt während die vorige noch
 * unterwegs war, blieb in der Outbox liegen.
 *
 * `flushOutbox` liest die Outbox einmal zu Beginn und ignorierte jeden
 * weiteren Aufruf, solange es lief. Die zweite Nachricht stand deshalb nicht
 * in der Liste des laufenden Durchgangs – und wurde erst beim nächsten
 * zufälligen Anlass (Wiederverbindung, weitere Nachricht) gesendet.
 */

const outbox = new Map<string, Record<string, unknown>>();
const sendMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    isOffline = false;
  },
  api: {
    messages: { send: (...args: unknown[]) => sendMock(...args), list: vi.fn() },
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
  enqueueOutbox: async (entry: { clientId: string }) => void outbox.set(entry.clientId, entry),
  readCachedConversations: vi.fn().mockResolvedValue([]),
  readCachedMessages: vi.fn().mockResolvedValue([]),
  readOutbox: async () => [...outbox.values()].map((entry) => ({ ...entry })),
  removeCachedConversation: vi.fn(),
  removeOutbox: async (clientId: string) => void outbox.delete(clientId),
  trimMessageCache: vi.fn(),
  updateOutbox: async (entry: { clientId: string }) => void outbox.set(entry.clientId, entry),
}));

vi.mock('../lib/upload.js', () => ({ uploadBlob: vi.fn() }));

let useChat: typeof import('./chat.js').useChat;

beforeEach(async () => {
  vi.resetModules();
  outbox.clear();
  sendMock.mockReset();
  ({ useChat } = await import('./chat.js'));
});

describe('flushOutbox', () => {
  it('sendet auch, was während eines laufenden Durchgangs dazukam', async () => {
    let ersteFreigeben: () => void = () => {};
    sendMock.mockImplementation(async (conversationId: string, body: { clientId: string }) => {
      if (sendMock.mock.calls.length === 1) {
        await new Promise<void>((fertig) => (ersteFreigeben = fertig));
      }
      return {
        id: `srv-${body.clientId}`,
        conversationId,
        clientId: body.clientId,
        senderId: 'u1',
        type: 'text',
        body: 'x',
        attachments: [],
        reactions: [],
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      };
    });

    const erste = useChat.getState().sendMessage('c1', { body: 'eins' });
    // Warten, bis der erste Durchgang wirklich beim Server hängt.
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    await useChat.getState().sendMessage('c1', { body: 'zwei' });
    ersteFreigeben();
    await erste;

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(outbox.size).toBe(0);
    const offen = (useChat.getState().messages.c1 ?? []).filter((m) => m.pending);
    expect(offen).toEqual([]);
  });
});
