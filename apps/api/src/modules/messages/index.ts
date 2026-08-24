import {
  LIMITS,
  editMessageSchema,
  listMessagesSchema,
  reactionSchema,
  searchMessagesSchema,
  sendMessageSchema,
  uuidSchema,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { MessageRow, ReactionRow } from '../../db/types.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { assertMembership, getMemberIds } from '../../services/conversation-core.js';
import {
  createMessage,
  hydrateMessages,
  loadMessage,
  publishMessageUpdate,
  toReactionDtos,
} from '../../services/messages.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });

export default defineModule({
  key: 'messages',
  description: 'Nachrichten, Reaktionen und Suche',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;

    app.get(
      '/conversations/:id/messages',
      { preHandler: app.authenticate },
      async (request) => {
        const viewerId = requireUserId(request);
        const { id } = parseParams(idParams, request);
        const query = parseQuery(listMessagesSchema, request);
        await assertMembership(sql, id, viewerId);

        const limit = query.limit ?? LIMITS.messagePageSize;

        // `after` walks forward (catching up), everything else walks backwards.
        const rows = query.after
          ? await sql<MessageRow[]>`
              select * from messages
              where conversation_id = ${id} and id > ${query.after}
              order by id asc
              limit ${limit}
            `
          : await sql<MessageRow[]>`
              select * from messages
              where conversation_id = ${id}
                ${query.before ? sql`and id < ${query.before}` : sql``}
              order by id desc
              limit ${limit}
            `;

        const ordered = query.after ? rows : rows.slice().reverse();
        const items = await hydrateMessages(sql, ordered, viewerId);
        const nextCursor =
          !query.after && rows.length === limit ? (ordered[0]?.id ?? null) : null;
        return { items, nextCursor };
      },
    );

    app.post('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(sendMessageSchema, request);
      await assertMembership(sql, id, viewerId);

      if (input.type === 'system') throw badRequest('Systemnachrichten können nicht gesendet werden');

      const message = await createMessage(ctx, {
        conversationId: id,
        senderId: viewerId,
        type: input.type,
        body: input.body ?? null,
        attachmentIds: input.attachmentIds,
        replyToId: input.replyToId ?? null,
        clientId: input.clientId ?? null,
        metadata: input.metadata,
      });
      reply.status(201);
      return message;
    });

    app.patch('/messages/:id', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { body } = parseBody(editMessageSchema, request);

      const rows = await sql<MessageRow[]>`select * from messages where id = ${id}`;
      const row = rows[0];
      if (!row) throw notFound('Nachricht nicht gefunden');
      if (row.senderId !== viewerId) throw forbidden('Nur eigene Nachrichten können bearbeitet werden');
      if (row.deletedAt) throw badRequest('Gelöschte Nachrichten können nicht bearbeitet werden');
      if (row.type !== 'text') throw badRequest('Nur Textnachrichten können bearbeitet werden');

      const updated = await sql<MessageRow[]>`
        update messages set body = ${body}, edited_at = now() where id = ${id} returning *
      `;
      const [message] = await hydrateMessages(sql, updated, viewerId);
      await publishMessageUpdate(ctx, message!);
      return message;
    });

    app.delete('/messages/:id', { preHandler: app.authenticate }, async (request, reply) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);

      const rows = await sql<MessageRow[]>`select * from messages where id = ${id}`;
      const row = rows[0];
      if (!row) throw notFound('Nachricht nicht gefunden');

      const membership = await assertMembership(sql, row.conversationId, viewerId);
      if (row.senderId !== viewerId && membership.role === 'member') {
        throw forbidden('Nur eigene Nachrichten können gelöscht werden');
      }

      await sql`
        update messages set deleted_at = now(), body = null, metadata = '{}'::jsonb where id = ${id}
      `;
      await sql`delete from attachments where message_id = ${id}`;

      const memberIds = await getMemberIds(sql, row.conversationId);
      await ctx.hub.publish(memberIds, {
        type: 'message.deleted',
        payload: { conversationId: row.conversationId, messageId: id },
      });
      reply.status(204);
      return null;
    });

    app.put('/messages/:id/reactions', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { emoji } = parseBody(reactionSchema, request);

      const rows = await sql<MessageRow[]>`select * from messages where id = ${id}`;
      const row = rows[0];
      if (!row) throw notFound('Nachricht nicht gefunden');
      await assertMembership(sql, row.conversationId, viewerId);

      await sql`
        insert into reactions ${sql({ messageId: id, userId: viewerId, emoji })}
        on conflict (message_id, user_id, emoji) do nothing
      `;
      return publishReactions(ctx, id, row.conversationId);
    });

    app.delete('/messages/:id/reactions', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { emoji } = parseQuery(reactionSchema, request);

      const rows = await sql<MessageRow[]>`select * from messages where id = ${id}`;
      const row = rows[0];
      if (!row) throw notFound('Nachricht nicht gefunden');
      await assertMembership(sql, row.conversationId, viewerId);

      await sql`
        delete from reactions where message_id = ${id} and user_id = ${viewerId} and emoji = ${emoji}
      `;
      return publishReactions(ctx, id, row.conversationId);
    });

    app.get('/messages/:id', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const rows = await sql<MessageRow[]>`select conversation_id from messages where id = ${id}`;
      const row = rows[0];
      if (!row) throw notFound('Nachricht nicht gefunden');
      await assertMembership(sql, row.conversationId, viewerId);
      const message = await loadMessage(sql, id, viewerId);
      if (!message) throw notFound('Nachricht nicht gefunden');
      return message;
    });

    app.get('/search/messages', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { q, conversationId, limit } = parseQuery(searchMessagesSchema, request);

      const rows = await sql<MessageRow[]>`
        select m.*
        from messages m
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${viewerId}
        where m.deleted_at is null
          and to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', ${q})
          ${conversationId ? sql`and m.conversation_id = ${conversationId}` : sql``}
        order by m.id desc
        limit ${limit ?? 30}
      `;
      return { items: await hydrateMessages(sql, rows, viewerId) };
    });
  },
});

async function publishReactions(ctx: AppContext, messageId: string, conversationId: string) {
  const rows = await ctx.sql<ReactionRow[]>`
    select * from reactions where message_id = ${messageId}
  `;
  const reactions = toReactionDtos(rows);
  const memberIds = await getMemberIds(ctx.sql, conversationId);
  await ctx.hub.publish(memberIds, {
    type: 'message.reactions',
    payload: { conversationId, messageId, reactions },
  });
  return { reactions };
}
