import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventDto } from '@initiative/shared';

/**
 * Der Trichter für Termin-Änderungen.
 *
 * Geprüft wird, was im Betrieb schiefgehen würde: zwei Rundrufe, die einander
 * überholen (die ältere Fassung darf die neuere nicht ersetzen), ein Hinweis
 * statt eines zu großen Rundrufs (ein Abruf, nicht mehrere, und keiner, wenn die
 * Fassung inzwischen schon da ist) und ein Termin, der nicht mehr erreichbar ist.
 */

const byIdMock = vi.fn();
const handlers = new Map<string, (payload: never) => void>();

vi.mock('./api.js', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super('fehler');
      this.status = status;
    }
  },
  api: { calendar: { byId: (...args: unknown[]) => byIdMock(...args) } },
}));

vi.mock('./realtime.js', () => ({
  realtime: {
    on: (type: string, handler: (payload: never) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  },
}));

const termin = (id: string, stand: number | undefined, titel = 'Grillen'): CalendarEventDto =>
  ({ id, title: titel, stand, attendees: [] }) as unknown as CalendarEventDto;

let t: typeof import('./terminEreignisse.js');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  byIdMock.mockReset();
  handlers.clear();
  t = await import('./terminEreignisse.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('aktualisiert', () => {
  it('nimmt eine neuere Fassung und verwirft eine ältere', () => {
    const angekommen: number[] = [];
    t.auf({ aktualisiert: (event) => angekommen.push(event.stand ?? -1) });

    expect(t.aktualisiert(termin('a', 3))).toBe(true);
    expect(t.aktualisiert(termin('a', 5))).toBe(true);
    // Der Rundruf zu Stand 4 hat den zu Stand 5 überholt – er kommt zu spät.
    expect(t.aktualisiert(termin('a', 4))).toBe(false);

    expect(angekommen).toEqual([3, 5]);
    expect(t.standVon('a')).toBe(5);
  });

  it('nimmt den gleichen Stand an, weil er später angekommen ist', () => {
    const angekommen: string[] = [];
    t.auf({ aktualisiert: (event) => angekommen.push(event.title) });

    t.aktualisiert(termin('a', 2, 'eins'));
    // Die Antwort einer „meldenden“ Route kann den Stand des folgenden Rundrufs
    // tragen – gleich alt, aber vollständiger.
    expect(t.aktualisiert(termin('a', 2, 'zwei'))).toBe(true);
    expect(angekommen).toEqual(['eins', 'zwei']);
  });

  it('kennt je Termin einen eigenen Stand', () => {
    t.aktualisiert(termin('a', 9));
    expect(t.aktualisiert(termin('b', 1))).toBe(true);
  });

  it('nimmt eine Fassung ohne Stand immer an (älterer Server)', () => {
    t.aktualisiert(termin('a', 7));
    expect(t.aktualisiert(termin('a', undefined))).toBe(true);
  });

  it('ein Hörer, der abgehängt wurde, hört nichts mehr', () => {
    const eintraege: string[] = [];
    const ab = t.auf({ aktualisiert: (event) => eintraege.push(event.id) });
    t.aktualisiert(termin('a', 1));
    ab();
    t.aktualisiert(termin('a', 2));
    expect(eintraege).toEqual(['a']);
  });

  it('ein Hörer, der wirft, nimmt den anderen nichts weg', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const eintraege: string[] = [];
    t.auf({
      aktualisiert: () => {
        throw new Error('kaputt');
      },
    });
    t.auf({ aktualisiert: (event) => eintraege.push(event.id) });
    t.aktualisiert(termin('a', 1));
    expect(eintraege).toEqual(['a']);
  });
});

describe('neuer', () => {
  it('der größere Stand gewinnt, bei Gleichstand die zweite', () => {
    const a = termin('a', 4, 'a');
    const b = termin('a', 3, 'b');
    expect(t.neuer(a, b)).toBe(a);
    expect(t.neuer(b, a)).toBe(a);
    const c = termin('a', 4, 'c');
    expect(t.neuer(a, c)).toBe(c);
  });

  it('ohne Stand gilt die zweite', () => {
    const a = termin('a', 4);
    const b = termin('a', undefined);
    expect(t.neuer(a, b)).toBe(b);
  });
});

describe('entfernt', () => {
  it('meldet den Grund und vergisst den Stand', () => {
    const gemeldet: [string, string | undefined][] = [];
    t.auf({ entfernt: (id, grund) => gemeldet.push([id, grund]) });

    t.aktualisiert(termin('a', 9));
    t.entfernt('a', 'ausgeladen');
    expect(gemeldet).toEqual([['a', 'ausgeladen']]);
    // Wer wieder eingeladen wird, bekommt einen höheren Stand – aber ein Zähler,
    // der das Löschen überlebt, könnte eine spätere Fassung fälschlich verwerfen.
    expect(t.standVon('a')).toBeUndefined();
    expect(t.aktualisiert(termin('a', 2))).toBe(true);
  });
});

describe('Hinweis mit Termin-Kennung', () => {
  it('holt den Termin einmal, auch wenn der Hinweis mehrfach kommt', async () => {
    byIdMock.mockResolvedValue(termin('a', 6));
    const angekommen: number[] = [];
    t.auf({ aktualisiert: (event) => angekommen.push(event.stand ?? -1) });

    t.nachladen('a');
    t.nachladen('a');
    t.nachladen('a');
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);

    expect(byIdMock).toHaveBeenCalledTimes(1);
    expect(byIdMock).toHaveBeenCalledWith('a');
    expect(angekommen).toEqual([6]);
  });

  it('wartet zufällig, damit nicht hundert Geräte im selben Augenblick fragen', async () => {
    byIdMock.mockResolvedValue(termin('a', 1));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    t.nachladen('a');

    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS * 0.5 - 10);
    expect(byIdMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(byIdMock).toHaveBeenCalledTimes(1);
  });

  it('fragt nicht, wenn die Fassung inzwischen schon angekommen ist', async () => {
    t.nachladen('a');
    // Die volle Fassung kam in der Wartezeit an – etwa als eigene Antwort.
    await vi.advanceTimersByTimeAsync(1);
    t.aktualisiert(termin('a', 8));
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);

    expect(byIdMock).not.toHaveBeenCalled();
  });

  it('ein zweiter Hinweis nach dem Abruf holt wieder', async () => {
    byIdMock.mockResolvedValue(termin('a', 2));
    t.nachladen('a');
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    byIdMock.mockResolvedValue(termin('a', 3));
    t.nachladen('a');
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    expect(byIdMock).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404])('behandelt %i wie einen gelöschten Termin', async (status) => {
    const { ApiError } = await import('./api.js');
    byIdMock.mockRejectedValue(new (ApiError as unknown as new (s: number) => Error)(status));
    const gemeldet: [string, string | undefined][] = [];
    t.auf({ entfernt: (id, grund) => gemeldet.push([id, grund]) });

    t.nachladen('a');
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);

    expect(gemeldet).toEqual([['a', undefined]]);
  });

  it('lässt alles, wie es ist, wenn der Abruf an der Verbindung scheitert', async () => {
    const { ApiError } = await import('./api.js');
    byIdMock.mockRejectedValue(new (ApiError as unknown as new (s: number) => Error)(0));
    const gemeldet: string[] = [];
    t.auf({ entfernt: (id) => gemeldet.push(id) });

    t.nachladen('a');
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);

    expect(gemeldet).toEqual([]);
  });
});

describe('Verdrahtung mit dem Rundruf', () => {
  it('leitet event.updated, event.deleted und den Hinweis in den Trichter', async () => {
    byIdMock.mockResolvedValue(termin('c', 2));
    const log: string[] = [];
    t.auf({
      aktualisiert: (event) => log.push(`neu ${event.id} ${event.stand}`),
      entfernt: (id, grund) => log.push(`weg ${id} ${grund ?? '-'}`),
    });

    t.connectTerminEreignisse();
    // Zweimal verdrahten darf nichts verdoppeln.
    t.connectTerminEreignisse();

    handlers.get('event.updated')?.({ event: termin('a', 1) } as never);
    handlers.get('event.deleted')?.({
      eventId: 'b',
      conversationId: null,
      grund: 'geloescht',
    } as never);
    handlers.get('sync.hint')?.({ scope: 'event', eventId: 'c' } as never);
    // Ein Hinweis ohne Termin-Kennung gehört dem Chat-Speicher, nicht hier.
    handlers.get('sync.hint')?.({ scope: 'conversations' } as never);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);

    expect(log).toEqual(['neu a 1', 'weg b geloescht', 'neu c 2']);
    expect(byIdMock).toHaveBeenCalledTimes(1);
  });
});
