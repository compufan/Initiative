import { useCallback, useEffect, useState } from 'react';
import type { CalendarEventDto } from '@initiative/shared';
import { ApiError, api } from '../../lib/api.js';
import { realtime } from '../../lib/realtime.js';

function upsert(events: CalendarEventDto[], event: CalendarEventDto): CalendarEventDto[] {
  const index = events.findIndex((item) => item.id === event.id);
  if (index < 0) return [...events, event];
  const next = events.slice();
  next[index] = event;
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
      setEvents(items);
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

  useEffect(() => {
    const offUpdated = realtime.on('event.updated', ({ event }) => {
      setEvents((current) => upsert(current, event));
    });
    const offDeleted = realtime.on('event.deleted', ({ eventId }) => {
      setEvents((current) => current.filter((item) => item.id !== eventId));
    });
    return () => {
      offUpdated();
      offDeleted();
    };
  }, []);

  const apply = useCallback((event: CalendarEventDto) => {
    setEvents((current) => upsert(current, event));
  }, []);

  return { events, loading, offline, failed, reload, apply };
}

export interface LiveEventResult {
  event: CalendarEventDto | null;
  setEvent: (event: CalendarEventDto) => void;
  loading: boolean;
  failed: boolean;
  deleted: boolean;
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
  const [event, setEvent] = useState<CalendarEventDto | null>(initial ?? null);
  const [loading, setLoading] = useState(Boolean(eventId) && initial == null);
  const [failed, setFailed] = useState(false);
  const [deleted, setDeleted] = useState(false);

  // Re-renders with the same expanded copy are a no-op for React.
  useEffect(() => {
    if (!initial) return;
    setEvent(initial);
    setDeleted(false);
  }, [initial]);

  useEffect(() => {
    if (!eventId || (initial && initial.id === eventId)) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.calendar
      .byId(eventId)
      .then((loaded) => {
        if (!cancelled) setEvent(loaded);
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
    const offUpdated = realtime.on('event.updated', (payload) => {
      if (payload.event.id === eventId) setEvent(payload.event);
    });
    const offDeleted = realtime.on('event.deleted', (payload) => {
      if (payload.eventId === eventId) setDeleted(true);
    });
    return () => {
      offUpdated();
      offDeleted();
    };
  }, [eventId]);

  return { event, setEvent, loading, failed, deleted };
}
