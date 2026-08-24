import type { FastifyInstance } from 'fastify';
import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  TYPING_TTL_MS,
  parseEnvelope,
} from '@initiative/shared';
import type { AppContext } from '../context.js';
import { userIdFromToken } from '../lib/auth.js';
import { getMemberIds, getMembership } from '../services/conversation-core.js';
import { touchLastSeen } from '../services/users.js';
import type { Connection } from './hub.js';

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

/**
 * Websocket endpoint. One socket per device; every event the user is allowed to
 * see is pushed through the realtime hub, so the client only polls on cold start.
 */
export function registerRealtime(app: FastifyInstance, ctx: AppContext): void {
  ctx.hub.setPresenceHandler((userId, online) => {
    void (async () => {
      try {
        if (!online) await touchLastSeen(ctx.sql, userId);
        const contacts = await ctx.sql<{ userId: string }[]>`
          select distinct other.user_id
          from conversation_members mine
          join conversation_members other on other.conversation_id = mine.conversation_id
          where mine.user_id = ${userId} and other.user_id <> ${userId}
        `;
        const audience = contacts.map((row) => row.userId);
        if (audience.length === 0) return;
        await ctx.hub.publish(audience, {
          type: 'presence',
          payload: { userId, online, lastSeenAt: new Date().toISOString() },
        });
      } catch (error) {
        app.log.warn({ err: error }, 'presence broadcast failed');
      }
    })();
  });

  app.get(REALTIME_PATH, { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocketLike;
    const token = (request.query as { token?: string } | undefined)?.token;
    const userId = token ? userIdFromToken(token, ctx.env.jwtSecret) : null;

    if (!userId) {
      ws.close(4401, 'unauthorized');
      return;
    }

    const connection: Connection = ctx.hub.add(userId, ws);
    ctx.hub.sendTo(connection, {
      type: 'hello',
      payload: { userId, connectionId: connection.id, serverTime: new Date().toISOString() },
    });
    void touchLastSeen(ctx.sql, userId);

    const heartbeat = setInterval(() => {
      if (!connection.alive) {
        ws.terminate();
        return;
      }
      connection.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('pong', () => {
      connection.alive = true;
    });

    ws.on('message', (raw: never) => {
      connection.alive = true;
      const envelope = parseEnvelope(String(raw));
      if (!envelope) return;
      void handleClientEvent(ctx, connection, envelope).catch((error: unknown) =>
        app.log.warn({ err: error }, 'realtime event failed'),
      );
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      ctx.hub.remove(connection);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}

async function handleClientEvent(
  ctx: AppContext,
  connection: Connection,
  event: { type: string; payload: unknown },
): Promise<void> {
  const userId = connection.userId;

  switch (event.type) {
    case 'ping': {
      ctx.hub.sendTo(connection, { type: 'pong', payload: { ts: new Date().toISOString() } });
      return;
    }
    case 'typing': {
      const payload = event.payload as { conversationId?: string; typing?: boolean };
      if (!payload?.conversationId) return;
      const membership = await getMembership(ctx.sql, payload.conversationId, userId);
      if (!membership) return;
      const memberIds = (await getMemberIds(ctx.sql, payload.conversationId)).filter(
        (id) => id !== userId,
      );
      await ctx.hub.publish(memberIds, {
        type: 'typing',
        payload: {
          conversationId: payload.conversationId,
          userId,
          until: new Date(Date.now() + (payload.typing === false ? 0 : TYPING_TTL_MS)).toISOString(),
        },
      });
      return;
    }
    case 'read': {
      const payload = event.payload as { conversationId?: string; messageId?: string };
      if (!payload?.conversationId || !payload.messageId) return;
      const membership = await getMembership(ctx.sql, payload.conversationId, userId);
      if (!membership) return;
      await ctx.sql`
        update conversation_members
        set last_read_message_id = greatest(${payload.messageId}::uuid, coalesce(last_read_message_id, ${payload.messageId}::uuid))
        where conversation_id = ${payload.conversationId} and user_id = ${userId}
      `;
      const memberIds = await getMemberIds(ctx.sql, payload.conversationId);
      await ctx.hub.publish(memberIds, {
        type: 'read.updated',
        payload: {
          conversationId: payload.conversationId,
          userId,
          lastReadMessageId: payload.messageId,
        },
      });
      return;
    }
    default:
      // Unknown events are ignored so new clients can talk to old servers.
      return;
  }
}
