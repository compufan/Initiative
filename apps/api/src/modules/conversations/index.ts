import {
  addMembersSchema,
  createConversationSchema,
  markReadSchema,
  updateConversationSchema,
  updateMemberSchema,
  uuidSchema,
  uuidv7,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { ConversationRow } from '../../db/types.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import {
  assertCanModerate,
  assertMembership,
  broadcastConversation,
  findDirectConversation,
  getMemberIds,
  loadConversationDto,
  loadConversationDtos,
} from '../../services/conversations.js';
import { createMessage } from '../../services/messages.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });
const memberParams = z.object({ id: uuidSchema, userId: uuidSchema });

export default defineModule({
  key: 'conversations',
  description: 'Chats, Mitglieder und Lesestatus',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;

    app.get('/conversations', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { archived } = parseQuery(
        z.object({ archived: z.enum(['true', 'false']).optional() }),
        request,
      );
      const items = await loadConversationDtos(sql, viewerId, {
        includeArchived: archived === 'true',
      });
      return { items: archived === 'true' ? items.filter((c) => c.archived) : items };
    });

    app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
      const viewerId = requireUserId(request);
      const input = parseBody(createConversationSchema, request);
      const memberIds = [...new Set([viewerId, ...input.memberIds])];

      const known = await sql<{ id: string }[]>`select id from users where id = any(${memberIds})`;
      if (known.length !== memberIds.length) throw badRequest('Unbekannte Mitglieder');

      if (input.type === 'direct') {
        const counterpart = input.memberIds[0]!;
        if (counterpart === viewerId) throw badRequest('Chat mit sich selbst ist nicht möglich');
        const existing = await findDirectConversation(sql, viewerId, counterpart);
        if (existing) {
          const dto = await loadConversationDto(sql, viewerId, existing);
          return dto;
        }
      }

      const conversationId = uuidv7();
      await sql.begin(async (tx) => {
        await tx`
          insert into conversations ${tx({
            id: conversationId,
            type: input.type,
            title: input.type === 'group' ? (input.title ?? 'Neue Gruppe') : null,
            avatarAttachmentId: input.avatarAttachmentId ?? null,
            createdBy: viewerId,
          })}
        `;
        for (const userId of memberIds) {
          await tx`
            insert into conversation_members ${tx({
              conversationId,
              userId,
              role: userId === viewerId ? 'owner' : 'member',
            })}
          `;
        }
      });

      if (input.type === 'group') {
        await createMessage(ctx, {
          conversationId,
          senderId: viewerId,
          type: 'system',
          body: null,
          metadata: { system: { kind: 'conversation.created', actorId: viewerId } },
          silent: true,
        });
      }

      await broadcastConversation(ctx, conversationId, memberIds);
      reply.status(201);
      return loadConversationDto(sql, viewerId, conversationId);
    });

    app.get('/conversations/:id', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      await assertMembership(sql, id, viewerId);
      const dto = await loadConversationDto(sql, viewerId, id);
      if (!dto) throw notFound('Chat nicht gefunden');
      return dto;
    });

    app.patch('/conversations/:id', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(updateConversationSchema, request);
      const membership = await assertMembership(sql, id, viewerId);

      const conversationPatch: Record<string, unknown> = {};
      if (input.title !== undefined) conversationPatch.title = input.title;
      if (input.avatarAttachmentId !== undefined) {
        conversationPatch.avatarAttachmentId = input.avatarAttachmentId;
      }
      if (Object.keys(conversationPatch).length > 0) {
        if (membership.role === 'member') throw forbidden('Nur Admins dürfen den Chat ändern');
        conversationPatch.updatedAt = new Date();
        await sql`update conversations set ${sql(conversationPatch)} where id = ${id}`;
      }

      const memberPatch: Record<string, unknown> = {};
      if (input.mutedUntil !== undefined) {
        memberPatch.mutedUntil = input.mutedUntil ? new Date(input.mutedUntil) : null;
      }
      if (input.archived !== undefined) memberPatch.archived = input.archived;
      if (Object.keys(memberPatch).length > 0) {
        await sql`
          update conversation_members set ${sql(memberPatch)}
          where conversation_id = ${id} and user_id = ${viewerId}
        `;
      }

      await broadcastConversation(ctx, id);
      return loadConversationDto(sql, viewerId, id);
    });

    app.post('/conversations/:id/members', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { memberIds } = parseBody(addMembersSchema, request);
      await assertCanModerate(sql, id, viewerId);

      const conversation = await sql<ConversationRow[]>`select * from conversations where id = ${id}`;
      if (conversation[0]?.type === 'direct') throw badRequest('Direktchats haben feste Mitglieder');

      const known = await sql<{ id: string }[]>`select id from users where id = any(${memberIds})`;
      if (known.length !== new Set(memberIds).size) throw badRequest('Unbekannte Mitglieder');

      for (const userId of memberIds) {
        await sql`
          insert into conversation_members ${sql({ conversationId: id, userId })}
          on conflict (conversation_id, user_id) do nothing
        `;
      }

      await createMessage(ctx, {
        conversationId: id,
        senderId: viewerId,
        type: 'system',
        metadata: { system: { kind: 'members.added', actorId: viewerId, targetIds: memberIds } },
        silent: true,
      });
      await broadcastConversation(ctx, id);
      return loadConversationDto(sql, viewerId, id);
    });

    app.patch(
      '/conversations/:id/members/:userId',
      { preHandler: app.authenticate },
      async (request) => {
        const viewerId = requireUserId(request);
        const { id, userId } = parseParams(memberParams, request);
        const input = parseBody(updateMemberSchema, request);
        if (input.role) await assertCanModerate(sql, id, viewerId);
        else if (userId !== viewerId) await assertCanModerate(sql, id, viewerId);
        else await assertMembership(sql, id, viewerId);

        const patch: Record<string, unknown> = {};
        if (input.role !== undefined) patch.role = input.role;
        if (input.nickname !== undefined) patch.nickname = input.nickname;
        if (Object.keys(patch).length > 0) {
          await sql`
            update conversation_members set ${sql(patch)}
            where conversation_id = ${id} and user_id = ${userId}
          `;
        }
        await broadcastConversation(ctx, id);
        return loadConversationDto(sql, viewerId, id);
      },
    );

    app.delete(
      '/conversations/:id/members/:userId',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const viewerId = requireUserId(request);
        const { id, userId } = parseParams(memberParams, request);
        if (userId !== viewerId) await assertCanModerate(sql, id, viewerId);
        else await assertMembership(sql, id, viewerId);

        const memberIds = await getMemberIds(sql, id);
        await sql`
          delete from conversation_members where conversation_id = ${id} and user_id = ${userId}
        `;
        await createMessage(ctx, {
          conversationId: id,
          senderId: viewerId,
          type: 'system',
          metadata: {
            system: {
              kind: userId === viewerId ? 'member.left' : 'member.removed',
              actorId: viewerId,
              targetIds: [userId],
            },
          },
          silent: true,
        });
        await ctx.hub.publish([userId], { type: 'conversation.removed', payload: { conversationId: id } });
        await broadcastConversation(ctx, id, memberIds.filter((member) => member !== userId));
        reply.status(204);
        return null;
      },
    );

    app.post('/conversations/:id/read', { preHandler: app.authenticate }, async (request) => {
      const viewerId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const { messageId } = parseBody(markReadSchema, request);
      await assertMembership(sql, id, viewerId);
      await sql`
        update conversation_members
        set last_read_message_id = ${messageId}
        where conversation_id = ${id} and user_id = ${viewerId}
          and (last_read_message_id is null or last_read_message_id < ${messageId})
      `;
      const memberIds = await getMemberIds(sql, id);
      await ctx.hub.publish(memberIds, {
        type: 'read.updated',
        payload: { conversationId: id, userId: viewerId, lastReadMessageId: messageId },
      });
      return { ok: true };
    });
  },
});
