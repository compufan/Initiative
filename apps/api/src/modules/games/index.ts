import {
  createGameSessionSchema,
  gameMoveSchema,
  getGame,
  listGames,
  uuidSchema,
  userOfSeat,
  type GameStatus,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { GameSessionRow } from '../../db/types.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { assertMembership } from '../../services/conversation-core.js';
import { registerMessageExpander } from '../../services/message-expanders.js';
import {
  createSession,
  gameExpander,
  loadSessionDtos,
  persistSession,
  requireSession,
  seatsOf,
  toGameSessionDto,
} from '../../services/games.js';
import { notifyUsers } from '../../services/notify.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });

export default defineModule({
  key: 'games',
  description: 'Mini-Spiele im Chat',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;
    registerMessageExpander(gameExpander);

    /** Catalog of everything registered in `packages/shared/src/games`. */
    app.get('/games', async () => ({
      items: listGames().map((game) => ({
        key: game.key,
        name: game.name,
        description: game.description,
        emoji: game.emoji,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
      })),
    }));

    app.get('/games/sessions', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { conversationId, status } = parseQuery(
        z.object({
          conversationId: uuidSchema.optional(),
          status: z.enum(['open', 'active', 'finished', 'aborted']).optional(),
        }),
        request,
      );
      if (conversationId) await assertMembership(sql, conversationId, userId);

      const rows = await sql<GameSessionRow[]>`
        select g.*
        from game_sessions g
        join conversation_members cm on cm.conversation_id = g.conversation_id and cm.user_id = ${userId}
        where true
          ${conversationId ? sql`and g.conversation_id = ${conversationId}` : sql``}
          ${status ? sql`and g.status = ${status}` : sql`and g.status in ('open', 'active')`}
        order by g.updated_at desc
        limit 50
      `;
      return { items: rows.map(toGameSessionDto) };
    });

    app.post('/games/sessions', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(createGameSessionSchema, request);
      await assertMembership(sql, input.conversationId, userId);

      for (const opponentId of input.opponentIds ?? []) {
        await assertMembership(sql, input.conversationId, opponentId);
      }

      const session = await createSession(ctx, {
        conversationId: input.conversationId,
        gameKey: input.gameKey,
        createdBy: userId,
        opponentIds: input.opponentIds,
      });
      reply.status(201);
      return session;
    });

    app.get('/games/sessions/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireSession(sql, id);
      await assertMembership(sql, row.conversationId, userId);
      return (await loadSessionDtos(sql, [id])).get(id);
    });

    app.post('/games/sessions/:id/join', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireSession(sql, id);
      await assertMembership(sql, row.conversationId, userId);

      const definition = getGame(row.gameKey);
      if (!definition) throw badRequest('Unbekanntes Spiel');
      if (row.status === 'finished' || row.status === 'aborted') throw badRequest('Das Spiel ist beendet');
      if (row.players.some((player) => player.userId === userId)) {
        return toGameSessionDto(row);
      }
      if (row.players.length >= definition.maxPlayers) throw badRequest('Das Spiel ist schon voll');

      const players = [
        ...row.players,
        { userId, seat: row.players.length, joinedAt: new Date().toISOString() },
      ];
      const seats = players.map(({ seat, userId: id2 }) => ({ seat, userId: id2 }));
      const status: GameStatus = players.length >= definition.minPlayers ? 'active' : 'open';
      const turnSeat = definition.currentSeat(row.state);

      return persistSession(ctx, row, {
        state: row.state,
        status,
        turnUserId: status === 'active' ? userOfSeat(seats, turnSeat) : null,
        winnerUserIds: [],
        players,
      });
    });

    /**
     * Authoritative move handling: the rules from `@initiative/shared` decide,
     * never the client. Optimistic concurrency via the session version.
     */
    app.post('/games/sessions/:id/moves', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(gameMoveSchema, request);
      const row = await requireSession(sql, id);
      await assertMembership(sql, row.conversationId, userId);

      if (input.version != null && input.version !== row.version) {
        throw badRequest('Der Spielstand hat sich geändert – bitte neu laden.');
      }
      if (row.status !== 'active') throw badRequest('Das Spiel läuft gerade nicht');

      const definition = getGame(row.gameKey);
      if (!definition) throw badRequest('Unbekanntes Spiel');

      const seats = seatsOf(row);
      const seat = seats.find((entry) => entry.userId === userId)?.seat;
      if (seat == null) throw forbidden('Du spielst nicht mit');

      const move = definition.parseMove(input.move);
      if (move == null) throw badRequest('Ungültiger Zug');

      const result = definition.applyMove(row.state, move, { seat, userId, players: seats });
      if (!result.ok) throw badRequest(result.error);

      const outcome = definition.getOutcome(result.state);
      const nextSeat = definition.currentSeat(result.state);
      const status: GameStatus = outcome.finished ? 'finished' : 'active';

      const session = await persistSession(ctx, row, {
        state: result.state,
        status,
        turnUserId: outcome.finished ? null : userOfSeat(seats, nextSeat),
        winnerUserIds: outcome.winnerSeats
          .map((winnerSeat) => userOfSeat(seats, winnerSeat))
          .filter((value): value is string => Boolean(value)),
      });

      // Nudge the player whose turn it is now.
      if (session.turnUserId && session.turnUserId !== userId) {
        await notifyUsers(ctx, [session.turnUserId], {
          title: definition.name,
          body: 'Du bist am Zug',
          tag: `game:${session.id}`,
          url: `/spiele/${session.id}`,
          conversationId: session.conversationId,
          kind: 'game',
        });
      }
      return session;
    });

    app.post('/games/sessions/:id/abort', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireSession(sql, id);
      await assertMembership(sql, row.conversationId, userId);
      if (!row.players.some((player) => player.userId === userId) && row.createdBy !== userId) {
        throw forbidden('Nur Mitspieler können das Spiel beenden');
      }
      if (row.status === 'finished' || row.status === 'aborted') return toGameSessionDto(row);

      const seats = seatsOf(row);
      const winners = seats.filter((entry) => entry.userId !== userId).map((entry) => entry.userId);

      return persistSession(ctx, row, {
        state: row.state,
        status: 'aborted',
        turnUserId: null,
        winnerUserIds: winners,
      });
    });

    /** Rematch: same game, same chat, same players. */
    app.post('/games/sessions/:id/rematch', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const row = await requireSession(sql, id);
      await assertMembership(sql, row.conversationId, userId);

      const session = await createSession(ctx, {
        conversationId: row.conversationId,
        gameKey: row.gameKey,
        createdBy: userId,
        opponentIds: row.players.map((player) => player.userId).filter((player) => player !== userId),
      });
      reply.status(201);
      return session;
    });
  },
});
