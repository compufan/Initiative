import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventDto } from '@initiative/shared';

/**
 * Termin-Karten bleiben in allen Chats synchron.
 *
 * Ein Termin steht als Karte im Gruppenchat und in jedem Einzelchat. Bisher
 * aktualisierte sich nur die Karte, die gerade eingehängt war: Eine Zusage in
 * einem Chat erreichte die Karte in einem nicht geöffneten nie, und beim
 * Zurückkehren stand dort der alte Zähler. Der Trichter führt jetzt jede Karte
 * im Speicher nach – hier wird geprüft, dass er sie alle trifft und nichts
 * sonst anfasst.
 */

const cacheMessagesMock = vi.fn();
const listMock = vi.fn();
const conversationsListMock = vi.fn();
const handlers = new Map<string, (payload: never) => void>();

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
    onStateChange: () => () => {},
  },
}));

vi.mock('../lib/db.js', () => ({
  cacheConversations: vi.fn(),
  cacheMessages: (...args: unknown[]) => cacheMessagesMock(...args),
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

const termin = (id: string, stand: number, zugesagt = 0): CalendarEventDto =>
  ({
    id,
    title: `Termin ${id}`,
    stand,
    conversationId: null,
    attendees: Array.from({ length: zugesagt }, (_, i) => ({ userId: `u${i}`, status: 'yes' })),
  }) as unknown as CalendarEventDto;

let zaehler = 0;
const karte = (chat: string, eventId: string | null, event?: CalendarEventDto) =>
  ({
    id: `m${String(++zaehler).padStart(4, '0')}`,
    conversationId: chat,
    senderId: 'u1',
    type: 'event',
    body: null,
    attachments: [],
    metadata: eventId ? { eventId } : {},
    reactions: [],
    createdAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    event,
  }) as never;

const text = (chat: string) =>
  ({
    id: `m${String(++zaehler).padStart(4, '0')}`,
    conversationId: chat,
    senderId: 'u1',
    type: 'text',
    body: 'Hallo',
    attachments: [],
    metadata: {},
    reactions: [],
    createdAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  }) as never;

let chat: typeof import('./chat.js');
let trichter: typeof import('../lib/terminEreignisse.js');

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  cacheMessagesMock.mockReset();
  listMock.mockReset();
  conversationsListMock.mockReset().mockResolvedValue({ items: [] });
  zaehler = 0;
  chat = await import('./chat.js');
  trichter = await import('../lib/terminEreignisse.js');
  chat.connectChatRealtime();
});

describe('Termin-Karten im Speicher', () => {
  it('führt jede Karte des Termins nach – auch in Chats, die nie geöffnet wurden', () => {
    const alt = termin('t1', 1, 0);
    chat.useChat.setState({
      messages: {
        gruppe: [karte('gruppe', 't1', alt), text('gruppe')],
        einzelB: [karte('einzelB', 't1', alt)],
        einzelC: [karte('einzelC', 't1', alt)],
      },
      // Keiner dieser Chats wurde je geöffnet.
      loaded: {},
    });

    trichter.aktualisiert(termin('t1', 2, 3));

    const { messages } = chat.useChat.getState();
    expect(messages.gruppe![0]!.event?.stand).toBe(2);
    expect(messages.einzelB![0]!.event?.stand).toBe(2);
    expect(messages.einzelC![0]!.event?.stand).toBe(2);
    expect(messages.einzelC![0]!.event?.attendees).toHaveLength(3);
  });

  it('lässt andere Nachrichten, andere Termine und unbeteiligte Chats unberührt', () => {
    const t1 = termin('t1', 1);
    const t2 = termin('t2', 5);
    const fremd = [karte('c3', 't2', t2), text('c3')];
    chat.useChat.setState({
      messages: {
        c1: [karte('c1', 't1', t1), karte('c1', 't2', t2), text('c1')],
        c3: fremd,
      },
    });
    const vorher = chat.useChat.getState().messages.c1!;

    trichter.aktualisiert(termin('t1', 2));

    const nachher = chat.useChat.getState().messages;
    expect(nachher.c1![0]!.event?.stand).toBe(2);
    // Der andere Termin und die Textnachricht behalten ihre Identität ...
    expect(nachher.c1![1]).toBe(vorher[1]);
    expect(nachher.c1![2]).toBe(vorher[2]);
    // ... und ein Chat ohne Karte dieses Termins wird nicht einmal kopiert.
    expect(nachher.c3).toBe(fremd);
  });

  it('eine ältere Fassung ersetzt nichts', () => {
    chat.useChat.setState({ messages: { c1: [karte('c1', 't1', termin('t1', 7, 2))] } });

    // Der Trichter selbst würde sie schon verwerfen; hier geht es um den
    // Speicher, falls jemand ihn direkt ruft.
    chat.terminAbgleichen(termin('t1', 6, 0));

    expect(chat.useChat.getState().messages.c1![0]!.event?.stand).toBe(7);
    expect(chat.useChat.getState().messages.c1![0]!.event?.attendees).toHaveLength(2);
  });

  it('schreibt die geänderten Karten in den Zwischenspeicher zurück', () => {
    chat.useChat.setState({
      messages: { c1: [karte('c1', 't1', termin('t1', 1)), text('c1')] },
    });

    trichter.aktualisiert(termin('t1', 2));

    expect(cacheMessagesMock).toHaveBeenCalledTimes(1);
    const geschrieben = cacheMessagesMock.mock.calls[0]![0] as {
      type: string;
      event: { stand: number };
    }[];
    expect(geschrieben).toHaveLength(1);
    expect(geschrieben[0]!.event.stand).toBe(2);
  });

  it('dieselbe Fassung noch einmal ist ein No-op', () => {
    chat.useChat.setState({ messages: { c1: [karte('c1', 't1', termin('t1', 1))] } });
    const fassung = termin('t1', 2);

    chat.terminAbgleichen(fassung);
    cacheMessagesMock.mockClear();
    const nach = chat.useChat.getState().messages;
    chat.terminAbgleichen(fassung);

    expect(chat.useChat.getState().messages).toBe(nach);
    expect(cacheMessagesMock).not.toHaveBeenCalled();
  });

  it('füllt eine Karte, die nur noch die Kennung hat (wieder eingeladen)', () => {
    chat.useChat.setState({ messages: { c1: [karte('c1', 't1')] } });

    trichter.aktualisiert(termin('t1', 4, 1));

    expect(chat.useChat.getState().messages.c1![0]!.event?.stand).toBe(4);
  });

  it('eine Karte ohne Kennung und ohne Termin bleibt, wie sie ist', () => {
    // Der Server kürzt die Karte für Nicht-Eingeladene: weder `event` noch
    // `metadata.eventId`. Sie lässt sich keinem Termin zuordnen.
    chat.useChat.setState({ messages: { c1: [karte('c1', null)] } });
    const vorher = chat.useChat.getState().messages.c1!;

    trichter.aktualisiert(termin('t1', 4));

    expect(chat.useChat.getState().messages.c1).toBe(vorher);
  });

  it('lädt einen Chat mit leerer Karte beim nächsten Öffnen vollständig neu, wenn der Termin auftaucht', () => {
    chat.useChat.setState({
      messages: { g: [karte('g', null)] },
      loaded: { g: true },
    });

    // Der Termin gehört zu diesem Gruppenchat; wer eingeladen wird, sieht die
    // bisher leere Karte erst nach einem Neuladen des Chats.
    trichter.aktualisiert({ ...termin('t1', 1), conversationId: 'g' });

    expect(chat.useChat.getState().loaded.g).toBe(false);
  });

  it('auch wenn der Termin schon in einem Einzelchat steht, wird der Gruppenchat neu geladen', () => {
    // Beim Einladen kommt zuerst die Karte im Einzelchat, dann der Rundruf.
    chat.useChat.setState({
      messages: { g: [karte('g', null)], e: [karte('e', 't1', termin('t1', 1))] },
      loaded: { g: true },
    });

    trichter.aktualisiert({ ...termin('t1', 2), conversationId: 'g' });

    expect(chat.useChat.getState().loaded.g).toBe(false);
  });

  it('steht die Karte des Termins im Gruppenchat selbst, stammt die leere von einem anderen', () => {
    chat.useChat.setState({
      messages: { g: [karte('g', null), karte('g', 't1', termin('t1', 1))] },
      loaded: { g: true },
    });

    trichter.aktualisiert({ ...termin('t1', 2), conversationId: 'g' });

    expect(chat.useChat.getState().loaded.g).toBe(true);
  });

  it('eine gelöschte Karte zählt nicht als leere Karte', () => {
    const gelöscht = {
      ...(karte('g', null) as object),
      deletedAt: '2026-01-02T00:00:00Z',
    } as never;
    chat.useChat.setState({ messages: { g: [gelöscht] }, loaded: { g: true } });

    trichter.aktualisiert({ ...termin('t1', 1), conversationId: 'g' });

    expect(chat.useChat.getState().loaded.g).toBe(true);
  });
});

describe('Termin entfernt', () => {
  it('setzt den Termin zurück und merkt sich den Grund', () => {
    chat.useChat.setState({
      messages: {
        g: [karte('g', 't1', termin('t1', 3))],
        e: [karte('e', 't2', termin('t2', 3))],
      },
    });

    trichter.entfernt('t1', 'ausgeladen');

    const { messages } = chat.useChat.getState();
    expect(messages.g![0]!.event).toBeUndefined();
    expect(messages.g![0]!.terminGrund).toBe('ausgeladen');
    // Die Kennung bleibt: Wer wieder eingeladen wird, bekommt die Karte live zurück.
    expect(messages.g![0]!.metadata.eventId).toBe('t1');
    expect(messages.e![0]!.event?.id).toBe('t2');
  });

  it('der Grund wird nicht zwischengespeichert', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 3))] } });

    trichter.entfernt('t1', 'ausgeladen');

    const geschrieben = cacheMessagesMock.mock.calls[0]![0] as Record<string, unknown>[];
    expect(geschrieben[0]).not.toHaveProperty('terminGrund');
    expect(geschrieben[0]!.event).toBeUndefined();
  });

  it('wieder eingeladen: die Karte zeigt den Termin, der Grund ist weg', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 3))] } });
    trichter.entfernt('t1', 'ausgeladen');

    trichter.aktualisiert(termin('t1', 9));

    const karte_ = chat.useChat.getState().messages.g![0]!;
    expect(karte_.event?.stand).toBe(9);
    expect(karte_.terminGrund).toBeUndefined();
  });

  it('zweimal entfernt ändert nichts mehr', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 3))] } });
    trichter.entfernt('t1', 'geloescht');
    const nach = chat.useChat.getState().messages;
    cacheMessagesMock.mockClear();

    trichter.entfernt('t1', 'geloescht');

    expect(chat.useChat.getState().messages).toBe(nach);
    expect(cacheMessagesMock).not.toHaveBeenCalled();
  });
});

describe('Rundruf und Hinweis', () => {
  it('event.updated aus dem Rundruf erreicht die Karten', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 1))] } });

    handlers.get('event.updated')?.({ event: termin('t1', 2, 4) } as never);

    expect(chat.useChat.getState().messages.g![0]!.event?.attendees).toHaveLength(4);
  });

  it('einander überholende Rundrufe: die ältere Fassung gewinnt nie', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 1))] } });

    handlers.get('event.updated')?.({ event: termin('t1', 5, 2) } as never);
    handlers.get('event.updated')?.({ event: termin('t1', 4, 1) } as never);

    const fassung = chat.useChat.getState().messages.g![0]!.event;
    expect(fassung?.stand).toBe(5);
    expect(fassung?.attendees).toHaveLength(2);
  });

  it('event.deleted lässt die Karten den Grund zeigen', () => {
    chat.useChat.setState({ messages: { g: [karte('g', 't1', termin('t1', 1))] } });

    handlers.get('event.deleted')?.({
      eventId: 't1',
      conversationId: null,
      grund: 'ausgeladen',
    } as never);

    expect(chat.useChat.getState().messages.g![0]!.terminGrund).toBe('ausgeladen');
  });

  it('ein Hinweis mit Termin-Kennung lädt weder Chats noch Chatliste neu', () => {
    handlers.get('sync.hint')?.({ scope: 'event', eventId: 't1' } as never);

    expect(listMock).not.toHaveBeenCalled();
    expect(conversationsListMock).not.toHaveBeenCalled();
  });

  it('ein Hinweis auf einen Chat lädt ihn weiterhin neu', async () => {
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    handlers.get('sync.hint')?.({ scope: 'messages', conversationId: 'c1' } as never);

    // Erst kommt der Zwischenspeicher, dann die Anfrage.
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled());
  });

  it('ein Hinweis ohne Kennung lädt die Chatliste neu', () => {
    handlers.get('sync.hint')?.({ scope: 'conversations' } as never);

    expect(conversationsListMock).toHaveBeenCalled();
  });
});
