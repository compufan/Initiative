import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getGame,
  listGames,
  seatOf,
  userOfSeat,
  type ConversationDto,
  type GameInfoDto,
  type GameSessionDto,
  type UserDto,
} from '@initiative/shared';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';

/** Shown when a session references a game this client does not know (yet). */
export const UNKNOWN_GAME: GameInfoDto = {
  key: '',
  name: 'Unbekanntes Spiel',
  description: 'Dieses Spiel kennt deine App noch nicht.',
  emoji: '🎮',
  minPlayers: 2,
  maxPlayers: 2,
};

/** Catalog entry of the local rules copy – used offline and as a fallback. */
export function localCatalog(): GameInfoDto[] {
  return listGames().map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    emoji: definition.emoji,
    minPlayers: definition.minPlayers,
    maxPlayers: definition.maxPlayers,
  }));
}

/** Metadata for a game key: server catalog first, then the local rules copy. */
export function gameInfoFor(gameKey: string, catalog: GameInfoDto[] = []): GameInfoDto {
  const fromCatalog = catalog.find((item) => item.key === gameKey);
  if (fromCatalog) return fromCatalog;
  const definition = getGame(gameKey);
  if (definition) {
    return {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      emoji: definition.emoji,
      minPlayers: definition.minPlayers,
      maxPlayers: definition.maxPlayers,
    };
  }
  return { ...UNKNOWN_GAME, key: gameKey };
}

let catalogCache: GameInfoDto[] | null = null;

export interface GameCatalogResult {
  games: GameInfoDto[];
  loading: boolean;
  failed: boolean;
}

/**
 * The catalog of the server (`/games`), cached for the session.
 *
 * Without a network the local copy of the rules answers instead, so a game can
 * always be picked – creating it still needs the server.
 */
export function useGameCatalog(): GameCatalogResult {
  const [games, setGames] = useState<GameInfoDto[]>(() => catalogCache ?? localCatalog());
  const [loading, setLoading] = useState(catalogCache == null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (catalogCache) return undefined;
    let cancelled = false;
    api.games
      .catalog()
      .then(({ items }) => {
        if (cancelled) return;
        catalogCache = items;
        setGames(items);
        setFailed(false);
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
  }, []);

  return { games, loading, failed };
}

/* ---------- seats and players ---------- */

/** Seat of the signed-in user, or null when watching someone else's match. */
export function mySeatIn(session: GameSessionDto, myId: string): number | null {
  return seatOf(session.players, myId);
}

export function userOfSeatIn(session: GameSessionDto, seat: number | null): string | null {
  return userOfSeat(session.players, seat);
}

/** Stable colour class per seat; the boards read `--seat` from it. */
export function seatClass(seat: number | null): string {
  return seat == null ? 'game-seat-none' : `game-seat-${seat % 4}`;
}

export function isMyTurn(session: GameSessionDto, myId: string): boolean {
  return session.status === 'active' && session.turnUserId === myId;
}

export function isFinished(session: GameSessionDto): boolean {
  return session.status === 'finished' || session.status === 'aborted';
}

export type StatusTone = 'turn' | 'wait' | 'open' | 'done';

export interface StatusInfo {
  text: string;
  tone: StatusTone;
}

/** One line describing where a match stands, from the viewer's perspective. */
export function statusInfo(
  session: GameSessionDto,
  myId: string,
  nameOf: (userId: string) => string,
): StatusInfo {
  if (session.status === 'finished') {
    if (session.winnerUserIds.length === 0) return { text: 'Unentschieden', tone: 'done' };
    if (session.winnerUserIds.includes(myId)) return { text: 'Du hast gewonnen', tone: 'done' };
    return { text: `Sieg für ${session.winnerUserIds.map(nameOf).join(', ')}`, tone: 'done' };
  }
  if (session.status === 'aborted') {
    const quitter = session.players.find(
      (player) => !session.winnerUserIds.includes(player.userId),
    );
    if (!quitter) return { text: 'Abgebrochen', tone: 'done' };
    return {
      text:
        quitter.userId === myId ? 'Du hast aufgegeben' : `${nameOf(quitter.userId)} hat aufgegeben`,
      tone: 'done',
    };
  }
  if (session.status === 'open') return { text: 'Wartet auf Mitspieler', tone: 'open' };
  if (!session.turnUserId) return { text: 'Bereit', tone: 'wait' };
  if (session.turnUserId === myId) return { text: 'Du bist am Zug', tone: 'turn' };
  return { text: `Wartet auf ${nameOf(session.turnUserId)}`, tone: 'wait' };
}

/** "Du gegen Anna" – the line under the game name. */
export function playersLabel(
  session: GameSessionDto,
  myId: string,
  nameOf: (userId: string) => string,
): string {
  const players = session.players.slice().sort((a, b) => a.seat - b.seat);
  if (players.length === 0) return 'Noch keine Mitspieler';
  const first = players[0];
  if (players.length === 1) {
    return first.userId === myId
      ? 'Du wartest auf Mitspieler'
      : `${nameOf(first.userId)} wartet auf Mitspieler`;
  }
  return players
    .map((player) => (player.userId === myId ? 'Du' : nameOf(player.userId)))
    .join(' gegen ');
}

/* ---------- optimistic moves ---------- */

export type LocalMoveResult = { ok: true; session: GameSessionDto } | { ok: false; error: string };

/**
 * Applies a move with the local copy of the rules.
 *
 * This is only for the immediate feedback on screen and to catch obviously
 * invalid input before it goes on the wire – `apps/api/src/games` decides.
 */
export function applyMoveLocally(
  session: GameSessionDto,
  move: unknown,
  myId: string,
): LocalMoveResult {
  const definition = getGame(session.gameKey);
  if (!definition) return { ok: false, error: 'Dieses Spiel kennt deine App noch nicht.' };
  if (session.status !== 'active') return { ok: false, error: 'Das Spiel läuft gerade nicht.' };

  const seat = seatOf(session.players, myId);
  if (seat == null) return { ok: false, error: 'Du spielst nicht mit.' };

  const parsed = definition.parseMove(move);
  if (parsed == null) return { ok: false, error: 'Ungültiger Zug.' };

  const result = definition.applyMove(session.state, parsed, {
    seat,
    userId: myId,
    players: session.players,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const outcome = definition.getOutcome(result.state);
  const nextSeat = definition.currentSeat(result.state);
  return {
    ok: true,
    session: {
      ...session,
      state: result.state,
      status: outcome.finished ? 'finished' : 'active',
      turnUserId: outcome.finished ? null : userOfSeat(session.players, nextSeat),
      winnerUserIds: outcome.winnerSeats
        .map((winnerSeat) => userOfSeat(session.players, winnerSeat))
        .filter((userId): userId is string => userId != null),
      updatedAt: new Date().toISOString(),
    },
  };
}

/* ---------- chats and users ---------- */

export function conversationLabel(
  conversation: ConversationDto | null | undefined,
  myId: string,
): string {
  if (!conversation) return 'Chat';
  if (conversation.type === 'group') {
    const title = conversation.title?.trim();
    return title && title.length > 0 ? title : 'Gruppe';
  }
  const other =
    conversation.members.find((member) => member.userId !== myId) ??
    conversation.members[0] ??
    null;
  if (!other) return 'Chat';
  const nickname = other.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : other.user.displayName;
}

/**
 * Resolves player ids to users: chat members are already in the store, the rest
 * is fetched once per id (failures are remembered so we never loop).
 */
export function useUserLookup(userIds: string[]): Record<string, UserDto> {
  const conversations = useChat((state) => state.conversations);
  const [fetched, setFetched] = useState<Record<string, UserDto>>({});
  const requested = useRef(new Set<string>());

  const known = useMemo(() => {
    const map: Record<string, UserDto> = {};
    for (const conversation of conversations) {
      for (const member of conversation.members) map[member.userId] = member.user;
    }
    return map;
  }, [conversations]);

  const wanted = userIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const missing = wanted
      .split(',')
      .filter((id) => id.length > 0 && !known[id] && !requested.current.has(id));
    if (missing.length === 0) return undefined;
    for (const id of missing) requested.current.add(id);
    void Promise.all(missing.map((id) => api.users.byId(id).catch(() => null))).then((users) => {
      if (cancelled) return;
      const found = users.filter((user): user is UserDto => user != null);
      if (found.length === 0) return;
      setFetched((current) => {
        const next = { ...current };
        for (const user of found) next[user.id] = user;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, known]);

  return useMemo(() => ({ ...known, ...fetched }), [known, fetched]);
}

/** Display name for a user id, falling back to a neutral label. */
export function nameFrom(users: Record<string, UserDto>, userId: string): string {
  return users[userId]?.displayName ?? 'Mitspieler';
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Sorts matches for lists: my turn first, then the most recent activity. */
export function compareSessions(myId: string) {
  const rank = (session: GameSessionDto): number => {
    if (session.status === 'active' && session.turnUserId === myId) return 0;
    if (session.status === 'active' || session.status === 'open') return 1;
    return 2;
  };
  return (a: GameSessionDto, b: GameSessionDto): number => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  };
}
