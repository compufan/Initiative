import { useCallback, useEffect, useState } from 'react';
import type { CalendarEventDto } from '@initiative/shared';
import { ApiError, api } from '../../lib/api.js';
import {
  aktualisiert,
  auf,
  auffrischen,
  entferntVerwirft,
  neuer,
  type EntferntGrund,
} from '../../lib/terminEreignisse.js';

/** Legt die Fassung ein – eine ältere als die vorhandene verdrängt nichts. */
function upsert(events: CalendarEventDto[], event: CalendarEventDto): CalendarEventDto[] {
  const index = events.findIndex((item) => item.id === event.id);
  if (index < 0) return [...events, event];
  const next = events.slice();
  next[index] = neuer(events[index], event);
  return next;
}

export interface CalendarEventsResult {
  events: CalendarEventDto[];
  loading: boolean;
  offline: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  apply: (event: CalendarEventDto) => void;
}

/**
 * Loads every event of a window and keeps it live.
 *
 * The API answers with the events themselves (recurring ones included); the
 * screens unfold them into occurrences afterwards. `event.updated` and
 * `event.deleted` keep the list in sync while the screen is open – both
 * subscriptions are released when the component unmounts.
 *
 * Gehört wird am Trichter (`terminEreignisse`), nicht am Rundruf: Dort laufen
 * auch die eigenen Antworten und das Nachladen nach einem Hinweis zusammen, und
 * ein Rundruf, der einen anderen überholt, verdrängt die neuere Fassung nicht.
 */
export function useCalendarEvents(from: Date, to: Date): CalendarEventsResult {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const [events, setEvents] = useState<CalendarEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { items } = await api.calendar.events({ from: fromIso, to: toIso });
      // Ein Rundruf, der während der Anfrage ankam, kann neuer sein als die Liste.
      setEvents((current) =>
        items.map((item) => {
          const vorhanden = current.find((termin) => termin.id === item.id);
          return vorhanden ? neuer(vorhanden, item) : item;
        }),
      );
      setFailed(false);
      setOffline(false);
    } catch (error) {
      setFailed(true);
      setOffline(error instanceof ApiError && error.isOffline);
    } finally {
      setLoading(false);
    }
  }, [fromIso, toIso]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      auf({
        aktualisiert: (event) => setEvents((current) => upsert(current, event)),
        entfernt: (eventId) =>
          setEvents((current) => current.filter((item) => item.id !== eventId)),
        // Rundrufe in einer Lücke der Verbindung kommen nie wieder: Die Liste
        // wird neu geholt.
        nachholen: () => void reload(),
      }),
    [reload],
  );

  // Die eigene Antwort läuft durch denselben Trichter wie der Rundruf – so
  // stimmt die Liste auch dann, wenn der Rundruf nie ankommt, und die Karten in
  // den Chats bekommen sie ebenfalls. Der Trichter verwirft eine Fassung, die
  // älter ist als die bekannte; der Hörer oben legt sie sonst in die Liste.
  const apply = useCallback((event: CalendarEventDto) => {
    aktualisiert(event);
  }, []);

  return { events, loading, offline, failed, reload, apply };
}

export interface LiveEventResult {
  event: CalendarEventDto | null;
  setEvent: (event: CalendarEventDto) => void;
  loading: boolean;
  failed: boolean;
  deleted: boolean;
  /** Warum der Termin weg ist – nur, wenn `deleted` gilt und der Server es sagte. */
  grund: EntferntGrund | undefined;
}

/**
 * A single event, live.
 *
 * `initial` is the copy the API already expanded into a chat message – it saves
 * the extra round trip; without it the event is fetched by id.
 */
export function useLiveEvent(
  eventId: string | null,
  initial?: CalendarEventDto | null,
): LiveEventResult {
  const [event, setEventRaw] = useState<CalendarEventDto | null>(initial ?? null);
  const [loading, setLoading] = useState(Boolean(eventId) && initial == null);
  const [failed, setFailed] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [grund, setGrund] = useState<EntferntGrund | undefined>(undefined);

  // Re-renders with the same expanded copy are a no-op for React. Die Karte im
  // Chat-Speicher wird vom Trichter nachgeführt; eine ältere Fassung als die,
  // die schon angezeigt wird, verdrängt nichts.
  useEffect(() => {
    if (!initial) return;
    setEventRaw((current) =>
      current && current.id === initial.id ? neuer(current, initial) : initial,
    );
    setDeleted(false);
    setGrund(undefined);
  }, [initial]);

  /**
   * Eine Fassung aus der eigenen Antwort (Zusage, Speichern, Einladen).
   *
   * Sie läuft durch den Trichter, damit auch die Karten in allen Chats und der
   * Kalender sie bekommen – nicht nur diese Ansicht.
   */
  const setEvent = useCallback((next: CalendarEventDto) => {
    if (!aktualisiert(next)) return;
    setEventRaw((current) => (current && current.id === next.id ? neuer(current, next) : next));
  }, []);

  useEffect(() => {
    if (!eventId || (initial && initial.id === eventId)) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const angefordertAm = Date.now();
    api.calendar
      .byId(eventId)
      .then((loaded) => {
        if (cancelled) return;
        // Wurde der Termin entfernt, während die Antwort unterwegs war, zeigt sie
        // ihn, wie er davor war – sie belebt ihn nicht wieder.
        if (entferntVerwirft(loaded, angefordertAm)) return;
        // Durch den Trichter, damit auch die Karten und der Kalender sie
        // bekommen – und trotzdem hier anzeigen, falls er sie als ältere
        // verwirft: Diese Ansicht hat sonst gar keine.
        aktualisiert(loaded, { angefordertAm });
        setEventRaw((current) =>
          current && current.id === loaded.id ? neuer(current, loaded) : loaded,
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, initial]);

  useEffect(() => {
    if (!eventId) return undefined;
    return auf({
      aktualisiert: (neu) => {
        if (neu.id !== eventId) return;
        setEventRaw((current) => (current && current.id === neu.id ? neuer(current, neu) : neu));
        setDeleted(false);
        setGrund(undefined);
      },
      entfernt: (id, warum) => {
        if (id !== eventId) return;
        setDeleted(true);
        setGrund(warum);
      },
      // Nach einer Lücke der Verbindung: den Termin neu holen. Die Antwort
      // läuft durch den Trichter und kommt über den Hörer oben hier an.
      nachholen: () => auffrischen([eventId]),
    });
  }, [eventId]);

  return { event, setEvent, loading, failed, deleted, grund };
}
