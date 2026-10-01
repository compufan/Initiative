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
const zustandHoerer = new Set<(zustand: string) => void>();

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
    onStateChange: (handler: (zustand: string) => void) => {
      zustandHoerer.add(handler);
      return () => zustandHoerer.delete(handler);
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
  zustandHoerer.clear();
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
    expect(t.standVon('a')).toBeUndefined();
    // Wer wieder eingeladen wird, bekommt einen höheren Stand und wird
    // angenommen.
    expect(t.aktualisiert(termin('a', 10))).toBe(true);
  });

  it('lässt einen entfernten Termin nicht von einer späten Fassung beleben', () => {
    const angekommen: number[] = [];
    t.auf({ aktualisiert: (event) => angekommen.push(event.stand ?? -1) });
    t.aktualisiert(termin('a', 9));
    t.entfernt('a', 'geloescht');

    // Ein Rundruf mit einem Stand, den wir schon kannten: Er gehört zu davor.
    expect(t.aktualisiert(termin('a', 9))).toBe(false);
    expect(t.aktualisiert(termin('a', 7))).toBe(false);
    // Eine Antwort auf eine Anfrage, die VOR dem Entfernen losging – egal, was
    // sie für einen Stand trägt.
    expect(t.aktualisiert(termin('a', 12), { angefordertAm: Date.now() - 5 })).toBe(false);
    expect(angekommen).toEqual([9]);

    // Eine Anfrage danach (oder ein höherer Rundruf) belebt ihn wieder.
    vi.advanceTimersByTime(10);
    expect(t.aktualisiert(termin('a', 12), { angefordertAm: Date.now() })).toBe(true);
    expect(t.aktualisiert(termin('a', 13))).toBe(true);
  });

  it('kennt der Trichter den Stand nicht, entscheidet allein der Zeitpunkt der Anfrage', () => {
    t.entfernt('b', 'geloescht');
    expect(t.aktualisiert(termin('b', 3), { angefordertAm: Date.now() - 1 })).toBe(false);
    // Ein Rundruf ohne Anfrage wird angenommen: Er kam nach dem Entfernen.
    expect(t.aktualisiert(termin('b', 4))).toBe(true);
  });

  it('der Grabstein steht nicht ewig', () => {
    t.aktualisiert(termin('a', 9));
    t.entfernt('a', 'geloescht');
    vi.advanceTimersByTime(t.GRABSTEIN_MS + 1);
    expect(t.aktualisiert(termin('a', 9))).toBe(true);
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

  it('fragt nicht, wenn die volle Fassung VOR dem Hinweis kam und den Stand trägt', async () => {
    // So ist die Reihenfolge am selben Server: erst die volle Fassung, ein bis
    // drei Millisekunden später der Hinweis aus dem Bus.
    t.aktualisiert(termin('a', 8));
    await vi.advanceTimersByTimeAsync(3);
    t.nachladen('a', 8);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    expect(byIdMock).not.toHaveBeenCalled();
  });

  it('fragt, wenn der Hinweis einen höheren Stand meldet, als wir kennen', async () => {
    byIdMock.mockResolvedValue(termin('a', 9));
    t.aktualisiert(termin('a', 8));
    await vi.advanceTimersByTimeAsync(3);
    t.nachladen('a', 9);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    expect(byIdMock).toHaveBeenCalledTimes(1);
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

describe('auffrischen und einmalPruefen', () => {
  it('holt jeden Termin einmal, höchstens vier zugleich', async () => {
    let offen = 0;
    let spitze = 0;
    byIdMock.mockImplementation(async (id: string) => {
      offen += 1;
      spitze = Math.max(spitze, offen);
      await new Promise((fertig) => setTimeout(fertig, 50));
      offen -= 1;
      return termin(id, 1);
    });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a', 'b'];
    t.auffrischen(ids);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    await vi.advanceTimersByTimeAsync(500);

    expect(byIdMock).toHaveBeenCalledTimes(7);
    expect(spitze).toBeLessThanOrEqual(4);
  });

  it('die Antwort läuft durch den Trichter, ein 404 heißt entfernt', async () => {
    const { ApiError } = await import('./api.js');
    byIdMock.mockImplementation(async (id: string) => {
      if (id === 'weg') throw new (ApiError as unknown as new (s: number) => Error)(404);
      return termin(id, 4);
    });
    const log: string[] = [];
    t.auf({
      aktualisiert: (event) => log.push(`neu ${event.id}`),
      entfernt: (id) => log.push(`weg ${id}`),
    });
    t.auffrischen(['da', 'weg']);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    expect(log.sort()).toEqual(['neu da', 'weg weg']);
  });

  it('einmalPruefen prüft einen Termin nur einmal je Sitzung', async () => {
    byIdMock.mockResolvedValue(termin('a', 1));
    t.einmalPruefen(['a']);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    t.einmalPruefen(['a']);
    await vi.advanceTimersByTimeAsync(t.HINWEIS_STREUUNG_MS + 1);
    expect(byIdMock).toHaveBeenCalledTimes(1);
  });
});

describe('nachholen nach einer Lücke', () => {
  const zustand = (wert: string) => zustandHoerer.forEach((hoerer) => hoerer(wert));

  it('ruft die Hörer nach offline → online, nicht beim ersten Verbinden', () => {
    const geholt = vi.fn();
    t.auf({ nachholen: geholt });
    t.connectTerminEreignisse();

    zustand('connecting');
    zustand('online');
    expect(geholt).not.toHaveBeenCalled();

    zustand('offline');
    zustand('connecting');
    zustand('online');
    expect(geholt).toHaveBeenCalledTimes(1);

    // Ein weiteres „online“ ohne Abbruch dazwischen holt nichts.
    zustand('online');
    expect(geholt).toHaveBeenCalledTimes(1);
  });

  it('mehrere Anlässe kurz hintereinander zählen einmal', () => {
    const geholt = vi.fn();
    t.auf({ nachholen: geholt });
    t.nachholen();
    t.nachholen();
    expect(geholt).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    t.nachholen();
    expect(geholt).toHaveBeenCalledTimes(2);
  });

  it('holt auch nach, wenn die App lange im Hintergrund war', async () => {
    // Die Testumgebung hat kein `document`: ein kleiner Ersatz, der die
    // Sichtbarkeit und den Hörer festhält.
    const hoerer = new Map<string, () => void>();
    const dokument = {
      visibilityState: 'visible',
      addEventListener: (art: string, eintrag: () => void) => hoerer.set(art, eintrag),
    };
    vi.stubGlobal('document', dokument);
    vi.resetModules();
    const frisch = await import('./terminEreignisse.js');
    const geholt = vi.fn();
    frisch.auf({ nachholen: geholt });
    frisch.connectTerminEreignisse();
    const wechsel = (sicht: string) => {
      dokument.visibilityState = sicht;
      hoerer.get('visibilitychange')?.();
    };

    wechsel('hidden');
    vi.advanceTimersByTime(frisch.HINTERGRUND_MS + 1000);
    wechsel('visible');
    expect(geholt).toHaveBeenCalledTimes(1);

    // Ein kurzer Wechsel genügt nicht.
    vi.advanceTimersByTime(5000);
    wechsel('hidden');
    vi.advanceTimersByTime(2000);
    wechsel('visible');
    expect(geholt).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
