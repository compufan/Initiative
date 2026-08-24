import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameSessionDto, MessageDto } from '@initiative/shared';
import { ApiError, api } from '../../lib/api.js';
import { realtime } from '../../lib/realtime.js';
import { useChat } from '../../state/chat.js';

export interface LiveGameSession {
  session: GameSessionDto | null;
  loading: boolean;
  failed: boolean;
  offline: boolean;
  /** Authoritative state from the server (REST answer or `game.updated`). */
  apply: (session: GameSessionDto) => void;
  /** Optimistic state; replaced as soon as a newer server version arrives. */
  predict: (session: GameSessionDto, baseVersion: number) => void;
  /** Undo a prediction the server rejected. */
  rollback: (session: GameSessionDto) => void;
  reload: () => Promise<void>;
}

/**
 * A single match, live.
 *
 * `initial` is the copy the API already expanded into the chat message – it
 * saves the extra round trip. Every update is version guarded: an older frame
 * (or the echo of a move we already predicted locally) never overwrites a newer
 * state, no matter in which order REST answer and websocket frame arrive.
 */
export function useLiveGameSession(
  sessionId: string | null,
  initial?: GameSessionDto | null,
): LiveGameSession {
  const [session, setSession] = useState<GameSessionDto | null>(initial ?? null);
  const [loading, setLoading] = useState(Boolean(sessionId) && initial == null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  /** Version the current prediction was built on – anything newer wins. */
  const predictedFrom = useRef<number | null>(null);

  const apply = useCallback((next: GameSessionDto) => {
    setSession((current) => {
      if (!current || current.id !== next.id) {
        predictedFrom.current = null;
        return next;
      }
      const floor = predictedFrom.current;
      if (floor != null && next.version <= floor) return current;
      if (next.version < current.version) return current;
      predictedFrom.current = null;
      return next;
    });
  }, []);

  const predict = useCallback((next: GameSessionDto, baseVersion: number) => {
    predictedFrom.current = baseVersion;
    setSession(next);
  }, []);

  const rollback = useCallback((previous: GameSessionDto) => {
    predictedFrom.current = null;
    setSession(previous);
  }, []);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const loaded = await api.games.byId(sessionId);
      predictedFrom.current = null;
      setSession(loaded);
      setFailed(false);
      setOffline(false);
    } catch (error) {
      setFailed(true);
      setOffline(error instanceof ApiError && error.isOffline);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Re-renders with the same expanded copy are a no-op for React.
  useEffect(() => {
    if (initial) apply(initial);
  }, [initial, apply]);

  useEffect(() => {
    if (!sessionId) return undefined;
    if (initial && initial.id === sessionId) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.games
      .byId(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        predictedFrom.current = null;
        setSession(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        setOffline(error instanceof ApiError && error.isOffline);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, initial]);

  useEffect(() => {
    if (!sessionId) return undefined;
    return realtime.on('game.updated', (payload) => {
      if (payload.session.id === sessionId) apply(payload.session);
    });
  }, [sessionId, apply]);

  return { session, loading, failed, offline, apply, predict, rollback, reload };
}

function newer(a: GameSessionDto, b: GameSessionDto): GameSessionDto {
  return b.version >= a.version ? b : a;
}

/** Every match the client knows about, newest first, with my turns on top. */
export function useGameSessions(): { sessions: GameSessionDto[]; refreshing: boolean } {
  const messages = useChat((state) => state.messages);
  const conversations = useChat((state) => state.conversations);
  const [overlay, setOverlay] = useState<Record<string, GameSessionDto>>({});
  const [refreshing, setRefreshing] = useState(false);

  const fromChat = useMemo(() => {
    const found: Record<string, GameSessionDto> = {};
    const collect = (message: MessageDto | null | undefined) => {
      const game = message?.game;
      if (!game) return;
      const known = found[game.id];
      found[game.id] = known ? newer(known, game) : game;
    };
    for (const list of Object.values(messages)) for (const message of list) collect(message);
    for (const conversation of conversations) collect(conversation.lastMessage);
    return found;
  }, [messages, conversations]);

  const sessions = useMemo(() => {
    const merged: Record<string, GameSessionDto> = { ...fromChat };
    for (const [id, session] of Object.entries(overlay)) {
      const known = merged[id];
      merged[id] = known ? newer(known, session) : session;
    }
    return Object.values(merged);
  }, [fromChat, overlay]);

  // Chat messages only carry the matches whose chat is already loaded, and the
  // state of their last expansion. The API knows all of them – ask it once and
  // merge, so the list is complete right after a cold start.
  const ids = Object.keys(fromChat).sort().join(',');
  useEffect(() => {
    const list = ids.split(',').filter((id) => id.length > 0);
    let cancelled = false;
    setRefreshing(true);
    void Promise.all([
      api.games
        .sessions()
        .then((result) => result.items)
        .catch(() => [] as GameSessionDto[]),
      ...list.slice(0, 20).map((id) => api.games.byId(id).catch(() => null)),
    ])
      .then((parts) => parts.flat())
      .then((loaded) => {
        if (cancelled) return;
        const found = loaded.filter((item): item is GameSessionDto => item != null);
        if (found.length > 0) {
          setOverlay((current) => {
            const next = { ...current };
            for (const item of found) {
              const known = next[item.id];
              next[item.id] = known ? newer(known, item) : item;
            }
            return next;
          });
        }
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ids]);

  useEffect(
    () =>
      realtime.on('game.updated', ({ session }) => {
        setOverlay((current) => {
          const known = current[session.id];
          return { ...current, [session.id]: known ? newer(known, session) : session };
        });
      }),
    [],
  );

  return { sessions, refreshing };
}
