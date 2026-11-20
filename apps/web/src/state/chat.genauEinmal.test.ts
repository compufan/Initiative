import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Senden ist genau-einmal – auch wenn mittendrin alles schiefgeht.
 *
 * Nachgestellt wird, was auf einem Telefon passiert: Das Foto ist hoch, dann
 * reisst das Netz ab; oder der Server hat die Nachricht schon festgeschrieben,
 * aber die Antwort kommt nie an, und die App wird neu geladen. Die Outbox
 * (hier eine Map anstelle von IndexedDB, die zwischen zwei „Seitenladungen“
 * erhalten bleibt) muss danach mit demselben `clientId` weitermachen, ohne den
 * Anhang erneut hochzuladen – und der Verlauf zeigt die Nachricht genau
 * einmal.
 */

type Eintrag = Record<string, unknown> & { clientId: string };

const outbox = new Map<string, Eintrag>();
const verlauf = new Map<string, Record<string, unknown>>();
const sendMock = vi.fn();
const uploadMock = vi.fn();
const erledigtMock = vi.fn();

class ApiErrorAttrappe extends Error {
  constructor(
    readonly status: number,
    message = 'Netz weg',
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isOffline(): boolean {
    return this.status === 0;
  }
}

vi.mock('../lib/api.js', () => ({
  ApiError: ApiErrorAttrappe,
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
  dateiHinterlegen: vi.fn(),
  dropCachedMessage: vi.fn(),
  enqueueOutbox: async (entry: Eintrag) => void outbox.set(entry.clientId, structuredClone(entry)),
  outboxErledigt: async (clientId: string, message: { id: string }) => {
    erledigtMock(clientId, message);
    // Eine Transaktion: beides oder nichts.
    outbox.delete(clientId);
    verlauf.set(message.id, message);
  },
  readCachedConversations: vi.fn().mockResolvedValue([]),
  readCachedMessages: vi.fn().mockResolvedValue([]),
  readOutbox: async () => [...outbox.values()].map((entry) => structuredClone(entry)),
  removeCachedConversation: vi.fn(),
  removeOutbox: async (clientId: string) => void outbox.delete(clientId),
  trimMessageCache: vi.fn(),
  updateOutbox: async (entry: Eintrag) => void outbox.set(entry.clientId, structuredClone(entry)),
}));

vi.mock('../lib/upload.js', () => ({ uploadBlob: (...args: unknown[]) => uploadMock(...args) }));

/** Der „Server“: je `clientId` höchstens eine Nachricht, Wiederholung liefert das Original. */
const server = new Map<string, Record<string, unknown>>();
function serverAntwort(
  conversationId: string,
  body: { clientId: string; attachmentIds: string[] },
) {
  const vorhanden = server.get(body.clientId);
  if (vorhanden) return vorhanden;
  const nachricht = {
    id: `srv-${server.size + 1}`,
    conversationId,
    clientId: body.clientId,
    senderId: 'u1',
    type: 'image',
    body: null,
    attachments: body.attachmentIds.map((id) => ({ id })),
    reactions: [],
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
  };
  server.set(body.clientId, nachricht);
  return nachricht;
}

async function neuLaden(): Promise<typeof import('./chat.js').useChat> {
  vi.resetModules();
  const { useChat } = await import('./chat.js');
  return useChat;
}

const foto = {
  kind: 'image' as const,
  mime: 'image/png',
  fileName: 'foto.png',
  blob: new Blob(['png']),
};

beforeEach(() => {
  outbox.clear();
  verlauf.clear();
  server.clear();
  sendMock.mockReset();
  uploadMock.mockReset();
  erledigtMock.mockReset();
});

describe('Senden genau einmal', () => {
  it('lädt nach einem Netzabriss den Anhang nicht noch einmal hoch', async () => {
    uploadMock.mockResolvedValue({ id: 'anhang-1' });
    sendMock.mockRejectedValueOnce(new ApiErrorAttrappe(0));

    let useChat = await neuLaden();
    await useChat.getState().sendMessage('c1', { type: 'image', attachments: [foto] });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(outbox.size).toBe(1);
    const gemerkt = [...outbox.values()][0] as unknown as {
      pendingAttachments: { hochgeladenId?: string }[];
    };
    expect(gemerkt.pendingAttachments[0].hochgeladenId).toBe('anhang-1');

    // Neu laden, Netz wieder da.
    sendMock.mockImplementation(
      async (c: string, b: { clientId: string; attachmentIds: string[] }) => serverAntwort(c, b),
    );
    useChat = await neuLaden();
    await useChat.getState().hydrate();
    await vi.waitFor(() => expect(outbox.size).toBe(0));

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ attachmentIds: ['anhang-1'] }),
    );
    expect(server.size).toBe(1);
  });

  it('zeigt nach Absturz zwischen Server-Commit und Outbox-Abschluss genau eine Nachricht', async () => {
    uploadMock.mockResolvedValue({ id: 'anhang-2' });
    // Der Server schreibt fest – aber die Antwort geht verloren.
    sendMock.mockImplementationOnce(
      async (c: string, b: { clientId: string; attachmentIds: string[] }) => {
        serverAntwort(c, b);
        throw new ApiErrorAttrappe(0);
      },
    );

    let useChat = await neuLaden();
    await useChat.getState().sendMessage('c1', { type: 'image', attachments: [foto] });
    expect(server.size).toBe(1);
    expect(outbox.size).toBe(1);
    const clientId = [...outbox.keys()][0];

    sendMock.mockImplementation(
      async (c: string, b: { clientId: string; attachmentIds: string[] }) => serverAntwort(c, b),
    );
    useChat = await neuLaden();
    await useChat.getState().hydrate();
    await vi.waitFor(() => expect(outbox.size).toBe(0));

    expect(server.size).toBe(1);
    expect(erledigtMock).toHaveBeenCalledTimes(1);
    expect(erledigtMock).toHaveBeenCalledWith(clientId, expect.objectContaining({ id: 'srv-1' }));
    expect(verlauf.size).toBe(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const sichtbar = useChat.getState().messages.c1 ?? [];
    expect(sichtbar.filter((m) => m.clientId === clientId)).toHaveLength(1);
    expect(sichtbar[0]).toMatchObject({ id: 'srv-1', pending: false });
  });

  it('entfernt den lokalen Schatten, wenn die Nachricht vom Server zuerst da ist', async () => {
    sendMock.mockImplementation(() => new Promise(() => {}));
    const useChat = await neuLaden();
    void useChat.getState().sendMessage('c1', { body: 'hallo' });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const clientId = [...outbox.keys()][0];

    // Über Echtzeit kommt die festgeschriebene Nachricht, zweimal.
    const vomServer = {
      id: 'srv-9',
      conversationId: 'c1',
      clientId,
      senderId: 'u1',
      type: 'text',
      body: 'hallo',
      attachments: [],
      reactions: [],
      metadata: {},
      createdAt: '2026-01-01T00:00:00Z',
    } as never;
    useChat.getState().applyMessage(vomServer);
    useChat.getState().applyMessage(vomServer);
    const liste = useChat.getState().messages.c1 ?? [];
    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatchObject({ id: 'srv-9', pending: false });
  });
});
