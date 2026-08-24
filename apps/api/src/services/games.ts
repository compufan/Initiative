import {
  getGame,
  uuidv7,
  type GameSessionDto,
  type GameSeat,
  type GameStatus,
} from '@initiative/shared';
import type { AppContext } from '../context.js';
import { jsonb, type Sql } from '../db/client.js';
import type { GameSessionRow } from '../db/types.js';
import { isoRequired } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getMemberIds } from './conversation-core.js';
import { createMessage, republishMessage } from './messages.js';
import type { MessageExpander } from './message-expanders.js';

export function toGameSessionDto(row: GameSessionRow): GameSessionDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    gameKey: row.gameKey,
    status: row.status,
    players: (row.players ?? []).map((player) => ({
      userId: player.userId,
      seat: player.seat,
      joinedAt: player.joinedAt,
    })),
    state: row.state,
    turnUserId: row.turnUserId,
    winnerUserIds: row.winnerUserIds ?? [],
    createdBy: row.createdBy ?? '',
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    version: row.version,
  };
}

export async function requireSession(sql: Sql, sessionId: string): Promise<GameSessionRow> {
  const rows = await sql<GameSessionRow[]>`select * from game_sessions where id = ${sessionId}`;
  const row = rows[0];
  if (!row) throw notFound('Spiel nicht gefunden');
  return row;
}

export async function loadSessionDtos(
  sql: Sql,
  sessionIds: string[],
): Promise<Map<string, GameSessionDto>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await sql<GameSessionRow[]>`select * from game_sessions where id = any(${sessionIds})`;
  return new Map(rows.map((row) => [row.id, toGameSessionDto(row)]));
}

export function seatsOf(row: GameSessionRow): GameSeat[] {
  return (row.players ?? []).map((player) => ({ seat: player.seat, userId: player.userId }));
}

export async function createSession(
  ctx: AppContext,
  input: { conversationId: string; gameKey: string; createdBy: string; opponentIds?: string[] },
): Promise<GameSessionDto> {
  const definition = getGame(input.gameKey);
  if (!definition) throw badRequest('Unbekanntes Spiel');

  const userIds = [input.createdBy, ...(input.opponentIds ?? [])].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  if (userIds.length > definition.maxPlayers) throw badRequest('Zu viele Mitspieler');

  const players = userIds.map((userId, seat) => ({
    userId,
    seat,
    joinedAt: new Date().toISOString(),
  }));
  const seats: GameSeat[] = players.map(({ seat, userId }) => ({ seat, userId }));
  const state = definition.createInitialState(seats);
  const status: GameStatus = players.length >= definition.minPlayers ? 'active' : 'open';
  const turnSeat = definition.currentSeat(state);
  const sessionId = uuidv7();

  await ctx.sql`
    insert into game_sessions ${ctx.sql({
      id: sessionId,
      conversationId: input.conversationId,
      gameKey: input.gameKey,
      status,
      state: jsonb(ctx.sql, state),
      players: jsonb(ctx.sql, players),
      turnUserId: status === 'active' ? (players.find((p) => p.seat === turnSeat)?.userId ?? null) : null,
      winnerUserIds: jsonb(ctx.sql, []),
      createdBy: input.createdBy,
      version: 0,
    })}
  `;

  const message = await createMessage(ctx, {
    conversationId: input.conversationId,
    senderId: input.createdBy,
    type: 'game',
    body: null,
    metadata: { gameSessionId: sessionId },
  });
  await ctx.sql`update game_sessions set message_id = ${message.id} where id = ${sessionId}`;

  const session = toGameSessionDto(await requireSession(ctx.sql, sessionId));
  await broadcastSession(ctx, session);
  return session;
}

export async function persistSession(
  ctx: AppContext,
  row: GameSessionRow,
  next: {
    state: unknown;
    status: GameStatus;
    turnUserId: string | null;
    winnerUserIds: string[];
    players?: GameSessionRow['players'];
  },
): Promise<GameSessionDto> {
  const rows = await ctx.sql<GameSessionRow[]>`
    update game_sessions
    set state = ${jsonb(ctx.sql, next.state)},
        status = ${next.status},
        turn_user_id = ${next.turnUserId},
        winner_user_ids = ${jsonb(ctx.sql, next.winnerUserIds)},
        players = ${jsonb(ctx.sql, next.players ?? row.players)},
        version = version + 1,
        updated_at = now()
    where id = ${row.id} and version = ${row.version}
    returning *
  `;
  const updated = rows[0];
  if (!updated) throw badRequest('Der Spielstand hat sich geändert – bitte neu laden.');
  const session = toGameSessionDto(updated);
  await broadcastSession(ctx, session);
  return session;
}

export async function broadcastSession(ctx: AppContext, session: GameSessionDto): Promise<void> {
  const memberIds = await getMemberIds(ctx.sql, session.conversationId);
  await ctx.hub.publish(memberIds, { type: 'game.updated', payload: { session } });
  await republishMessage(ctx, session.messageId, session.createdBy);
}

/** Embeds the referenced match into every `game` message. */
export const gameExpander: MessageExpander = {
  key: 'games',
  async expand({ sql, messages }) {
    const ids = [
      ...new Set(
        messages.map((message) => message.metadata?.gameSessionId).filter((id): id is string => !!id),
      ),
    ];
    const sessions = await loadSessionDtos(sql, ids);
    const result = new Map<string, { game?: GameSessionDto }>();
    for (const message of messages) {
      const sessionId = message.metadata?.gameSessionId;
      if (!sessionId) continue;
      const session = sessions.get(sessionId);
      if (session) result.set(message.id, { game: session });
    }
    return result;
  },
};
